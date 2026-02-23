const http = require('http');
// ============================================================
// VIBE CHECK BOT v2.1
// ============================================================
//
// Features:
// - /vibe command — analyze 1 to 5 channels in one report
// - /vibe-progress — track community health over time (with graphs)
// - OpenAI GPT-4o-mini analysis
// - Sensitivity levels: Low / Medium / High
// - Visibility: Private / Public
// - Custom timeframes and message counts
// - Supabase report storage
// - Email reports via Resend
// - Stripe paywall (5 free reports, then Pro)
// - Tester system — owner-approved unlimited access
// - Rate limiting and cooldowns
// - Welcome message on server join
// - HTTP server to keep Railway alive
//
// ============================================================

require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits
} = require('discord.js');
const OpenAI = require('openai');
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  FREE_REPORTS: 5,
  PRO_REPORTS_PER_MONTH: 30,
  FREE_MAX_MESSAGES: 500,
  PRO_MAX_MESSAGES: 1000,
  FREE_MAX_CHANNELS: 1,
  PRO_MAX_CHANNELS: 5,

  MAX_OPENAI_CHARS: 30000,
  MAX_OPENAI_MESSAGES_PER_CHANNEL: 200,

  STRIPE_MONTHLY_LINK: 'https://buy.stripe.com/fZu28k00n5s92Oqf4z4ow01',
  STRIPE_YEARLY_LINK: 'https://buy.stripe.com/bJebIUbJ56wd4Wye0v4ow03',

  CONTACT_EMAIL: 'play@felixagaming.com',
  REPORT_EMAIL: 'play@felixagaming.com',
  OWNER_ID: '1185219817913991220',

  YEARLY_ENABLED: true,
  COOLDOWN_SECONDS: 15,
  SERVER_THROTTLE_PER_MINUTE: 10,
  PENDING_COMMAND_TIMEOUT: 300000,

  COST_PER_1M_INPUT_TOKENS: 0.15,
  COST_PER_1M_OUTPUT_TOKENS: 0.60
};

// ============================================================
// SENSITIVITY PROMPTS
// ============================================================

const SENSITIVITY_PROMPTS = {
  low: `SENSITIVITY: LOW (Adult/Gaming communities - CoD, GTA, etc.)
- Casual trash talk and banter is NORMAL — mark as neutral, NOT unfriendly
- Only flag: death threats, slurs (racial/homophobic), doxxing, severe harassment
- "get rekt", "you suck", "trash player" = neutral in gaming context
- Profanity alone is NOT unfriendly
- Reserve "unfriendly" for genuinely toxic behavior that would harm the community`,

  medium: `SENSITIVITY: MEDIUM (General communities)
- Flag: insults, harassment, bullying, hate speech, threats, repeated negativity
- Mild disagreement or criticism = neutral
- "Your idea is bad" = neutral. "You are worthless" = unfriendly
- Flag xenophobia, racism, sexism, homophobia
- Flag persistent harassment ("I'll keep tagging you until you leave")
- Constructive criticism is fine, personal attacks are not`,

  high: `SENSITIVITY: HIGH (Kids / Family / Education)
- Flag: any profanity, mild insults, rude dismissals, negative tone
- "That's dumb" = unfriendly. "I disagree" = neutral
- Anything that would make a child feel unsafe or unwelcome = unfriendly
- Very strict — when in doubt, mark as unfriendly`
};

// ============================================================
// STARTUP VALIDATION
// ============================================================

function validateEnvironment() {
  const required = ['DISCORD_TOKEN', 'CLIENT_ID', 'OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_KEY'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    console.error('❌ FATAL: Missing required environment variables:');
    missing.forEach(key => console.error(`   - ${key}`));
    process.exit(1);
  }
  if (!CONFIG.STRIPE_YEARLY_LINK || CONFIG.STRIPE_YEARLY_LINK.includes('YOUR_')) {
    CONFIG.YEARLY_ENABLED = false;
  }
  console.log('✅ Environment validated');
}

validateEnvironment();

// ============================================================
// GLOBAL ERROR HANDLERS
// ============================================================

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err.message);
});

// ============================================================
// API CLIENTS
// ============================================================

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ============================================================
// DISCORD CLIENT
// ============================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ============================================================
// USAGE TRACKING
// ============================================================

const serverUsage = new Map();
const cooldowns = new Map();
const serverThrottle = new Map();

async function getUsageFromDB(serverId) {
  try {
    const { data } = await supabase.from('usage').select('*').eq('server_id', serverId).single();
    return data;
  } catch { return null; }
}

async function getReportsUsed(serverId) {
  const dbUsage = await getUsageFromDB(serverId);
  if (dbUsage) return dbUsage.reports_used || 0;
  if (!serverUsage.has(serverId)) serverUsage.set(serverId, { reportsUsed: 0 });
  return serverUsage.get(serverId).reportsUsed;
}

async function isPaid(serverId) {
  try {
    const { data } = await supabase.from('paid_servers').select('server_id, expires_at').eq('server_id', serverId).single();
    if (!data) return false;
    if (data.expires_at && new Date(data.expires_at) < new Date()) return false;
    return true;
  } catch { return false; }
}

async function isTester(serverId) {
  try {
    const { data } = await supabase.from('testers').select('expires_at').eq('server_id', serverId).single();
    if (!data) return false;
    return new Date(data.expires_at) > new Date();
  } catch { return false; }
}

async function getFreeBonus(serverId) {
  try {
    const { data } = await supabase.from('usage').select('free_bonus').eq('server_id', serverId).single();
    return data?.free_bonus || 0;
  } catch { return 0; }
}

async function getSubscriptionStatus(serverId) {
  try {
    const { data } = await supabase.from('paid_servers').select('expires_at').eq('server_id', serverId).single();
    if (!data || !data.expires_at) return { isActive: false, daysLeft: 0 };
    const msLeft = new Date(data.expires_at).getTime() - Date.now();
    const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
    return { isActive: daysLeft > 0, daysLeft: Math.max(0, daysLeft) };
  } catch { return { isActive: false, daysLeft: 0 }; }
}

async function canUseBot(serverId) {
  // Testers have unlimited access
  if (await isTester(serverId)) return true;

  const paid = await isPaid(serverId);
  const used = await getReportsUsed(serverId);
  if (paid) return used < CONFIG.PRO_REPORTS_PER_MONTH;
  const bonus = await getFreeBonus(serverId);
  return used < (CONFIG.FREE_REPORTS + bonus);
}

async function getReportsRemaining(serverId) {
  if (await isTester(serverId)) return 999;
  const paid = await isPaid(serverId);
  const used = await getReportsUsed(serverId);
  if (paid) return CONFIG.PRO_REPORTS_PER_MONTH - used;
  const bonus = await getFreeBonus(serverId);
  return (CONFIG.FREE_REPORTS + bonus) - used;
}

async function incrementUsage(serverId) {
  // Never increment for testers
  if (await isTester(serverId)) return;
  try {
    const { data } = await supabase.from('usage').select('reports_used').eq('server_id', serverId).single();
    if (data) {
      await supabase.from('usage').update({ reports_used: (data.reports_used || 0) + 1 }).eq('server_id', serverId);
    } else {
      await supabase.from('usage').insert({ server_id: serverId, reports_used: 1, month_start: new Date().toISOString() });
    }
  } catch {
    if (!serverUsage.has(serverId)) serverUsage.set(serverId, { reportsUsed: 0 });
    serverUsage.get(serverId).reportsUsed++;
  }
}

function isOnCooldown(userId) {
  const last = cooldowns.get(userId);
  if (!last) return false;
  return (Date.now() - last) < CONFIG.COOLDOWN_SECONDS * 1000;
}

function setCooldown(userId) { cooldowns.set(userId, Date.now()); }

function isServerThrottled(serverId) {
  const now = Date.now();
  const entry = serverThrottle.get(serverId);
  if (!entry || now > entry.resetAt) {
    serverThrottle.set(serverId, { count: 0, resetAt: now + 60000 });
    return false;
  }
  return entry.count >= CONFIG.SERVER_THROTTLE_PER_MINUTE;
}

function incrementServerThrottle(serverId) {
  const now = Date.now();
  const entry = serverThrottle.get(serverId);
  if (!entry || now > entry.resetAt) {
    serverThrottle.set(serverId, { count: 1, resetAt: now + 60000 });
  } else {
    entry.count++;
  }
}

// ============================================================
// MESSAGE FETCH + SANITIZE
// ============================================================

function sanitizeMessage(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<@!?\d+>/g, '[user]')
    .replace(/<#\d+>/g, '[channel]')
    .replace(/<@&\d+>/g, '[role]')
    .replace(/@(everyone|here)/g, '[mention]')
    .replace(/https?:\/\/\S+/g, '[link]')
    .replace(/\w{50,}/g, '[...]')
    .trim()
    .slice(0, 500);
}

function canReadChannel(guild, channel) {
  const me = guild.members.me;
  if (!me) return false;
  const perms = channel.permissionsFor(me);
  return perms?.has('ViewChannel') && perms?.has('ReadMessageHistory');
}

async function fetchChannelMessages(channel, messageCount, timeframeMs) {
  const cutoffTime = Date.now() - timeframeMs;
  let allMessages = [];
  let lastId;

  while (allMessages.length < messageCount) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;
    const fetched = await channel.messages.fetch(options);
    if (fetched.size === 0) break;

    const filtered = fetched.filter(m =>
      !m.author.bot && m.content.length > 0 && m.createdTimestamp > cutoffTime
    );
    allMessages.push(...filtered.map(m => sanitizeMessage(m.content)).filter(Boolean));
    lastId = fetched.last().id;
    if (fetched.last().createdTimestamp < cutoffTime) break;
  }

  return allMessages.slice(0, messageCount);
}

// ============================================================
// FAST CHANNEL STATS (no full member fetch)
// ============================================================

async function getChannelStats(guild, channel) {
  try {
    const POSITIVE = ['👍','❤️','😂','🔥','✅','🎉','😊','💯','⭐','🙌'];
    const NEGATIVE = ['👎','😡','🤮','💀','😤','😒','🤦'];

    let mostReacted = null, mostPositive = null, mostNegative = null;
    let maxTotal = 0, maxPos = 0, maxNeg = 0;

    const recentMsgs = await channel.messages.fetch({ limit: 100 });
    recentMsgs.forEach(m => {
      if (m.author.bot || !m.content) return;
      let total = 0, pos = 0, neg = 0, reactionStr = '';
      m.reactions.cache.forEach(r => {
        const count = r.count;
        total += count;
        reactionStr += `${r.emoji.name}×${count} `;
        if (POSITIVE.includes(r.emoji.name)) pos += count;
        if (NEGATIVE.includes(r.emoji.name)) neg += count;
      });
      reactionStr = reactionStr.trim();
      if (total > maxTotal) { maxTotal = total; mostReacted = { text: m.content.substring(0, 80), reactions: reactionStr || `${total} reactions` }; }
      if (pos > maxPos)     { maxPos = pos;     mostPositive = { text: m.content.substring(0, 80), reactions: reactionStr || `${pos} positive` }; }
      if (neg > maxNeg)     { maxNeg = neg;      mostNegative = { text: m.content.substring(0, 80), reactions: reactionStr || `${neg} negative` }; }
    });

    return {
      totalMembers: guild.memberCount,
      membersWithAccess: null,
      activeMembers: null,
      mostReacted,
      mostPositive,
      mostNegative
    };
  } catch {
    return { totalMembers: guild.memberCount, membersWithAccess: null, activeMembers: null, mostReacted: null, mostPositive: null, mostNegative: null };
  }
}

// ============================================================
// AI ANALYSIS
// ============================================================

async function analyzeMessages(messages, channelNames, sensitivity, timeframeLabel) {
  const totalMessages = messages.length;
  let trimmedMessages = messages;
  let totalChars = messages.join(' ').length;
  if (totalChars > CONFIG.MAX_OPENAI_CHARS) {
    const ratio = CONFIG.MAX_OPENAI_CHARS / totalChars;
    trimmedMessages = messages.slice(0, Math.floor(totalMessages * ratio));
  }

  const analyzedCount = trimmedMessages.length;
  const sensitivityPrompt = SENSITIVITY_PROMPTS[sensitivity] || SENSITIVITY_PROMPTS.medium;

  const prompt = `You are Vibe Check Bot, a community behavior analyzer.

${sensitivityPrompt}

Analyze these ${analyzedCount} messages from ${channelNames.join(', ')} (last ${timeframeLabel}).

RULES:
- sentiment counts (friendly + neutral + unfriendly) MUST add up to exactly ${analyzedCount}
- Each message belongs to exactly ONE category
- Flag ALL unfriendly messages — do not limit to top 5
- Understand messages in ANY language — translate mentally before judging
- Provide specific, actionable AI recommendations

MESSAGES TO ANALYZE:
${trimmedMessages.map((m, i) => `${i + 1}. ${m}`).join('\n')}

Respond ONLY with this exact JSON (no markdown, no extra text):
{
  "friendlinessScore": <0-10 number>,
  "sentiment": {
    "friendly": <integer>,
    "neutral": <integer>,
    "unfriendly": <integer>
  },
  "flaggedMessages": [
    {
      "message": "<exact message text>",
      "type": "<insult|harassment|threat|hate_speech|bullying|profanity|spam|other>",
      "severity": <1-10>
    }
  ],
  "toxicityTypes": {
    "insults": <count>,
    "harassment": <count>,
    "threats": <count>,
    "hate_speech": <count>,
    "bullying": <count>,
    "profanity": <count>,
    "spam": <count>
  },
  "recommendation": "<2-3 specific, actionable sentences for the server admin>",
  "summary": "<1 sentence overall verdict>"
}`;

  const startTime = Date.now();
  let response;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 2000
      });
      break;
    } catch (err) {
      const isRetryable = err.status === 429 || err.status >= 500;
      if (attempt === maxAttempts || !isRetryable) throw err;
      const delay = attempt * 2000;
      console.warn(`⚠️ OpenAI attempt ${attempt} failed (${err.status}), retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  const processingTime = Date.now() - startTime;
  const usage = response.usage;
  const cost = (
    (usage.prompt_tokens / 1000000) * CONFIG.COST_PER_1M_INPUT_TOKENS +
    (usage.completion_tokens / 1000000) * CONFIG.COST_PER_1M_OUTPUT_TOKENS
  );

  let result = JSON.parse(response.choices[0].message.content.trim());
  result.friendlinessScore = clamp(result.friendlinessScore, 0, 10);

  const sentimentTotal = result.sentiment.friendly + result.sentiment.neutral + result.sentiment.unfriendly;
  if (sentimentTotal !== analyzedCount) {
    const scale = analyzedCount / sentimentTotal;
    result.sentiment.friendly = Math.round(result.sentiment.friendly * scale);
    result.sentiment.neutral = Math.round(result.sentiment.neutral * scale);
    result.sentiment.unfriendly = analyzedCount - result.sentiment.friendly - result.sentiment.neutral;
  }

  return { result, analyzedCount, totalMessages, processingTime, cost, inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens };
}

// ============================================================
// HELPERS
// ============================================================

function clamp(val, min, max) { return Math.min(Math.max(Number(val) || 0, min), max); }

function buildScoreBar(score) {
  const filled = Math.round(score);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function scoreColor(score) {
  if (score >= 7) return 0x22c55e;
  if (score >= 4) return 0xf59e0b;
  return 0xef4444;
}

function scoreEmoji(score) {
  if (score >= 8) return '🟢';
  if (score >= 5) return '🟡';
  return '🔴';
}

function scoreLabel(score) {
  if (score >= 8) return 'Excellent';
  if (score >= 6) return 'Good';
  if (score >= 4) return 'Needs Attention';
  return 'Poor';
}

// ============================================================
// BUILD DISCORD EMBED REPORT
// ============================================================

function buildReportEmbed(result, analyzedCount, channelNames, timeframeLabel, sensitivity, remaining, isPaidServer, reactions = null, stats = null, isPublic = false, channelMsgCounts = {}, channelResults = {}) {
  const score = result.friendlinessScore;
  const bar = buildScoreBar(score);
  const { friendly, neutral, unfriendly } = result.sentiment;
  const total = friendly + neutral + unfriendly;

  const friendlyPct = Math.round((friendly / total) * 100);
  const neutralPct = Math.round((neutral / total) * 100);
  const unfriendlyPct = Math.round((unfriendly / total) * 100);

  const channelDisplay = channelNames.length === 1 ? channelNames[0] : channelNames.join(', ');

  const communityDesc = score >= 8 ? 'Your community is thriving and welcoming.'
    : score >= 6 ? 'Your community is generally positive.'
    : score >= 4 ? 'Your community has a mixed atmosphere.'
    : 'Your community needs attention.';

  const embed = new EmbedBuilder()
    .setColor(scoreColor(score))
    .setTitle(channelNames.length > 1 ? `📊 Multi-Channel Vibe Report` : `📊 Community Vibe Report`)
    .setDescription(
      `**${channelDisplay}** • Last ${timeframeLabel} • ${analyzedCount} messages • Sensitivity: **${sensitivity.charAt(0).toUpperCase() + sensitivity.slice(1)}**\n\n` +
      `${scoreEmoji(score)} **Friendliness Score: ${score}/10** — ${scoreLabel(score)}\n` +
      `\`${bar}\`\n` +
      `*${communityDesc}*`
    );

  if (stats) {
    embed.addFields({ name: '📋 Channel Info', value: `👥 Server members: **${stats.totalMembers}**`, inline: false });
  }

  if (channelNames.length > 1) {
    const chScoreLines = channelNames.map(ch => {
      const res = channelResults[ch];
      if (!res) return `${ch}  —  not enough data`;
      const chScore = res.result.friendlinessScore;
      const chBar = '█'.repeat(Math.round(chScore)) + '░'.repeat(10 - Math.round(chScore));
      const chEmoji = chScore >= 7 ? '🟢' : chScore >= 4 ? '🟡' : '🔴';
      const msgCount = channelMsgCounts[ch] || 0;
      return `${chEmoji} **${ch}**  \`${chBar}\`  **${chScore}/10**  (${msgCount} msgs)`;
    });
    embed.addFields({
      name: `⚡ Impact Score: ${score}/10 — Per-Channel Breakdown`,
      value: chScoreLines.join('\n'),
      inline: false
    });
  }

  embed.addFields({
    name: '💬 Sentiment Breakdown',
    value:
      `🟢 Friendly   \`${String(friendly).padStart(4)}\`  ${friendlyPct}%  ${'█'.repeat(Math.round(friendlyPct / 10))}${'░'.repeat(10 - Math.round(friendlyPct / 10))}\n` +
      `⚪ Neutral    \`${String(neutral).padStart(4)}\`  ${neutralPct}%  ${'█'.repeat(Math.round(neutralPct / 10))}${'░'.repeat(10 - Math.round(neutralPct / 10))}\n` +
      `🔴 Unfriendly \`${String(unfriendly).padStart(4)}\`  ${unfriendlyPct}%  ${'█'.repeat(Math.round(unfriendlyPct / 10))}${'░'.repeat(10 - Math.round(unfriendlyPct / 10))}`,
    inline: false
  });

  if (isPublic) {
    const flaggedCount = result.flaggedMessages?.length || 0;
    if (flaggedCount > 0) {
      const typeBreakdown = result.toxicityTypes
        ? Object.entries(result.toxicityTypes).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => `• ${k}: ${v}`).join('\n')
        : 'See full report for details.';
      embed.addFields({ name: `⚠️ Toxicity Summary (${flaggedCount} flagged)`, value: typeBreakdown.substring(0, 1024) || 'Types unavailable.', inline: false });
    } else {
      embed.addFields({ name: '✅ No Flagged Content', value: 'No harmful content detected.', inline: false });
    }
  } else {
    if (result.toxicityTypes && Object.keys(result.toxicityTypes).length > 0) {
      const types = Object.entries(result.toxicityTypes).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
      const maxVal = types[0]?.[1] || 1;
      const bars = types.map(([k, v]) => {
        const filled = Math.round((v / maxVal) * 8);
        const bar = '█'.repeat(filled) + '░'.repeat(8 - filled);
        return `\`${bar}\` ${k}: ${v}`;
      }).join('\n');
      embed.addFields({ name: '🧪 Toxicity Breakdown', value: bars, inline: false });
    }

    if (result.flaggedMessages && result.flaggedMessages.length > 0) {
      const flaggedList = result.flaggedMessages
        .sort((a, b) => b.severity - a.severity)
        .slice(0, 10)
        .map(f => `• [\`${f.type}\` ${f.severity}/10] ${f.message.substring(0, 80)}${f.message.length > 80 ? '...' : ''}`)
        .join('\n');
      embed.addFields({ name: `⚠️ Flagged Messages (${result.flaggedMessages.length})`, value: flaggedList.substring(0, 1024), inline: false });
      if (result.flaggedMessages.length > 10) {
        embed.addFields({ name: '', value: `_...and ${result.flaggedMessages.length - 10} more in the email report_`, inline: false });
      }
    } else {
      embed.addFields({ name: '✅ No Flagged Messages', value: 'No harmful content detected.', inline: false });
    }
  }

  if (reactions && !isPublic) {
    const reactionLines = [];
    if (reactions.mostReacted)  reactionLines.push(`⭐ **Most reacted:** "${reactions.mostReacted.text}" — ${reactions.mostReacted.reactions}`);
    if (reactions.mostPositive) reactionLines.push(`👍 **Most positive:** "${reactions.mostPositive.text}" — ${reactions.mostPositive.reactions}`);
    if (reactions.mostNegative) reactionLines.push(`👎 **Most negative:** "${reactions.mostNegative.text}" — ${reactions.mostNegative.reactions}`);
    if (reactionLines.length > 0) {
      embed.addFields({ name: '💬 Most Reacted Comments', value: reactionLines.join('\n'), inline: false });
    }
  }

  if (result.summary) {
    embed.addFields({ name: '🗒️ Vibe Insights', value: result.summary, inline: false });
  }

  if (result.recommendation) {
    embed.addFields({ name: '💡 Vibe Check Bot Recommendations', value: result.recommendation, inline: false });
  }

  embed.addFields({
    name: '🔧 Need Help?',
    value: `Request research-based strategies to improve your community.\n📧 **${CONFIG.CONTACT_EMAIL}**`,
    inline: false
  });

  const planType = isPaidServer ? '⚡ Pro' : '🎁 Free Trial';
  const reportWord = remaining === 1 ? 'report' : 'reports';
  embed.setFooter({
    text: `Vibe Check Bot • ${planType} • ${remaining} ${reportWord} remaining • Sensitivity: ${sensitivity}`
  });

  return embed;
}

// ============================================================
// SAVE REPORT TO SUPABASE
// ============================================================

async function saveReport(serverId, serverName, channelNames, score, sentiment, flaggedCount, sensitivity, timeframe, analyzedCount, toxicityTypes) {
  try {
    await supabase.from('reports').insert({
      server_id: serverId,
      server_name: serverName,
      channel_name: channelNames.join(', '),
      score,
      friendly: sentiment.friendly,
      neutral: sentiment.neutral,
      unfriendly: sentiment.unfriendly,
      flagged_count: flaggedCount,
      sensitivity,
      timeframe,
      messages_analyzed: analyzedCount,
      toxicity_types: JSON.stringify(toxicityTypes || {}),
      created_at: new Date().toISOString()
    });
  } catch (err) { console.error('Save report error:', err.message); }
}

// ============================================================
// RESEARCH LOGGING
// ============================================================

async function logResearchData(data) {
  try {
    const rows = data.channelNames.map(channelName => {
      const chRes = data.channelResults?.[channelName];
      const chScore = chRes ? chRes.result.friendlinessScore : data.score;
      const chSentiment = chRes ? chRes.result.sentiment : { friendly: 0, neutral: 0, unfriendly: 0 };
      const chFlagged = chRes ? (chRes.result.flaggedMessages?.length || 0) : data.flaggedCount;
      const chToxTypes = chRes ? (chRes.result.toxicityTypes || {}) : data.toxicityTypes;
      const chMsgs = chRes ? chRes.analyzedCount : data.analyzedCount;
      return {
        server_name:        data.serverName,
        server_id:          data.serverId,
        member_count:       data.memberCount,
        channel_name:       channelName,
        messages_analyzed:  chMsgs,
        score:              chScore,
        friendly:           chSentiment.friendly,
        neutral:            chSentiment.neutral,
        unfriendly:         chSentiment.unfriendly,
        flagged_count:      chFlagged,
        toxicity_types:     chToxTypes,
        sensitivity:        data.sensitivity,
        timeframe:          data.timeframe,
        is_pro:             data.isPro,
        input_tokens:       data.inputTokens,
        output_tokens:      data.outputTokens,
        cost_usd:           data.cost,
        processing_time_ms: data.processingTime
      };
    });

    const { error } = await supabase.from('research_logs').insert(rows);
    if (error) console.error('Research log error:', error.message);
    else console.log(`📊 Research logged: ${rows.length} channel(s), score ${data.score}, $${data.cost?.toFixed(6)}`);
  } catch (err) { console.error('Research logging failed:', err.message); }
}

// ============================================================
// EMAIL REPORTS
// ============================================================

async function sendEmailReport(serverName, serverId, channelNames, result, analyzedCount, timeframe, sensitivity, remaining) {
  try {
    const flaggedHtml = result.flaggedMessages && result.flaggedMessages.length > 0
      ? result.flaggedMessages.sort((a, b) => b.severity - a.severity).map(f => `<li><strong>[${f.type} - ${f.severity}/10]</strong> ${f.message}</li>`).join('')
      : '<li>No flagged messages</li>';

    await resend.emails.send({
      from: 'Vibe Check Bot <noreply@vibecheckbot.com>',
      to: CONFIG.REPORT_EMAIL,
      subject: `📊 Vibe Report — ${serverName} | Score: ${result.friendlinessScore}/10`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
          <h2 style="color:#F97316">📊 Vibe Check Bot Report</h2>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:6px;border-bottom:1px solid #eee"><strong>Server</strong></td><td>${serverName}</td></tr>
            <tr><td style="padding:6px;border-bottom:1px solid #eee"><strong>Channel(s)</strong></td><td>${channelNames.join(', ')}</td></tr>
            <tr><td style="padding:6px;border-bottom:1px solid #eee"><strong>Messages</strong></td><td>${analyzedCount}</td></tr>
            <tr><td style="padding:6px;border-bottom:1px solid #eee"><strong>Score</strong></td><td><strong>${result.friendlinessScore}/10</strong></td></tr>
            <tr><td style="padding:6px;border-bottom:1px solid #eee"><strong>Friendly</strong></td><td>${result.sentiment.friendly}</td></tr>
            <tr><td style="padding:6px;border-bottom:1px solid #eee"><strong>Neutral</strong></td><td>${result.sentiment.neutral}</td></tr>
            <tr><td style="padding:6px;border-bottom:1px solid #eee"><strong>Unfriendly</strong></td><td>${result.sentiment.unfriendly}</td></tr>
            <tr><td style="padding:6px;border-bottom:1px solid #eee"><strong>Flagged</strong></td><td>${result.flaggedMessages ? result.flaggedMessages.length : 0}</td></tr>
            <tr><td style="padding:6px;border-bottom:1px solid #eee"><strong>Reports Remaining</strong></td><td>${remaining}</td></tr>
          </table>
          <h3>⚠️ All Flagged Messages</h3>
          <ul>${flaggedHtml}</ul>
          <h3>💡 Recommendations</h3>
          <p>${result.recommendation || 'N/A'}</p>
        </div>
      `
    });
  } catch (err) { console.error('Email error:', err.message); }
}

async function sendNewTrialEmail(serverName, serverId, userName) {
  try {
    await resend.emails.send({
      from: 'Vibe Check Bot <noreply@vibecheckbot.com>',
      to: CONFIG.REPORT_EMAIL,
      subject: `🆕 New Free Trial: ${serverName}`,
      html: `<div style="font-family:Arial,sans-serif"><h2>🆕 New Free Trial</h2><p><strong>Server:</strong> ${serverName}</p><p><strong>ID:</strong> ${serverId}</p><p><strong>By:</strong> ${userName}</p></div>`
    });
  } catch (err) { console.error('New trial email error:', err.message); }
}

async function sendTrialEndedEmail(serverName, serverId, userName) {
  try {
    await resend.emails.send({
      from: 'Vibe Check Bot <noreply@vibecheckbot.com>',
      to: CONFIG.REPORT_EMAIL,
      subject: `🔔 Trial Ended: ${serverName}`,
      html: `<div style="font-family:Arial,sans-serif"><h2>🔔 Trial Ended</h2><p><strong>Server:</strong> ${serverName}</p><p><strong>ID:</strong> ${serverId}</p><p><strong>By:</strong> ${userName}</p><p>To give extra reports: <code>/vibe-admin action:test server_id:${serverId}</code></p></div>`
    });
  } catch (err) { console.error('Trial ended email error:', err.message); }
}

// ============================================================
// REGISTER SLASH COMMANDS
// ============================================================

async function registerCommands() {
  const vibeCommand = new SlashCommandBuilder()
    .setName('vibe')
    .setDescription('Check the friendliness of one or more channels')
    .addChannelOption(opt => opt.setName('channel').setDescription('Channel to analyze (default: current)').setRequired(false).addChannelTypes(ChannelType.GuildText))
    .addChannelOption(opt => opt.setName('channel2').setDescription('2nd channel').setRequired(false).addChannelTypes(ChannelType.GuildText))
    .addChannelOption(opt => opt.setName('channel3').setDescription('3rd channel').setRequired(false).addChannelTypes(ChannelType.GuildText))
    .addChannelOption(opt => opt.setName('channel4').setDescription('4th channel').setRequired(false).addChannelTypes(ChannelType.GuildText))
    .addChannelOption(opt => opt.setName('channel5').setDescription('5th channel').setRequired(false).addChannelTypes(ChannelType.GuildText))
    .addStringOption(opt => opt.setName('timeframe').setDescription('How far back to analyze (default: 7d)').setRequired(false).addChoices(
      { name: '1 hour', value: '1h' },
      { name: '24 hours', value: '24h' },
      { name: '7 days', value: '7d' },
      { name: '14 days', value: '14d' },
      { name: '30 days', value: '30d' }
    ))
    .addStringOption(opt => opt.setName('sensitivity').setDescription('How strict the analysis is (default: medium)').setRequired(false).addChoices(
      { name: '🎮 Low — Gaming/Adult', value: 'low' },
      { name: '⚖️ Medium — General', value: 'medium' },
      { name: '👶 High — Kids/Family', value: 'high' }
    ))
    .addStringOption(opt => opt.setName('visibility').setDescription('Who sees the report (default: private)').setRequired(false).addChoices(
      { name: '🔒 Private — only you', value: 'private' },
      { name: '📢 Public — everyone in channel', value: 'public' }
    ))
    .addIntegerOption(opt => opt.setName('messages').setDescription('Messages per channel to analyze (default: 100)').setRequired(false).addChoices(
      { name: '50 messages', value: 50 },
      { name: '100 messages', value: 100 },
      { name: '250 messages', value: 250 },
      { name: '500 messages', value: 500 },
      { name: '1000 messages (Pro)', value: 1000 }
    ));

  const progressCommand = new SlashCommandBuilder()
    .setName('vibe-progress')
    .setDescription('See your community friendliness trend over time')
    .addStringOption(opt => opt.setName('range').setDescription('How many past reports to show (default: 10)').setRequired(false).addChoices(
      { name: 'Last 5 reports', value: '5' },
      { name: 'Last 10 reports', value: '10' },
      { name: 'Last 20 reports', value: '20' },
      { name: 'Last 30 days', value: '30d' }
    ))
    .addChannelOption(opt => opt.setName('channel').setDescription('Filter by channel').setRequired(false).addChannelTypes(ChannelType.GuildText))
    .addChannelOption(opt => opt.setName('channel2').setDescription('Compare channel 2').setRequired(false).addChannelTypes(ChannelType.GuildText))
    .addChannelOption(opt => opt.setName('channel3').setDescription('Compare channel 3').setRequired(false).addChannelTypes(ChannelType.GuildText));

  const adminCommand = new SlashCommandBuilder()
    .setName('vibe-admin')
    .setDescription('Admin controls (owner only)')
    .addStringOption(opt => opt.setName('action').setDescription('Action to perform').setRequired(true).addChoices(
      { name: '🧪 Test — give extra free reports', value: 'test' },
      { name: '👥 Tester — unlimited access for 2 weeks', value: 'tester' },
      { name: '❌ Remove Tester — revoke tester access', value: 'tester_off' },
      { name: '⚡ Pro — activate Pro', value: 'pro' },
      { name: '🔴 Pro Off — deactivate Pro', value: 'pro_off' }
    ))
    .addStringOption(opt => opt.setName('server_id').setDescription('Server ID').setRequired(true))
    .addIntegerOption(opt => opt.setName('reports').setDescription('Extra reports to add (Test only, default: 5)').setRequired(false));

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
      body: [vibeCommand.toJSON(), progressCommand.toJSON(), adminCommand.toJSON()]
    });
    console.log('✅ Commands registered');
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }
}

// ============================================================
// BOT READY
// ============================================================

client.once('ready', () => {
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ✅ VIBE CHECK BOT IS ONLINE');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Bot: ${client.user.tag}`);
  console.log(`  Servers: ${client.guilds.cache.size}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  registerCommands();
});

// ============================================================
// WELCOME MESSAGE
// ============================================================

client.on('guildCreate', async (guild) => {
  console.log(`📥 Joined: ${guild.name}`);
  try {
    const channel = guild.systemChannel ||
      guild.channels.cache.find(c =>
        c.type === ChannelType.GuildText &&
        c.permissionsFor(guild.members.me)?.has('SendMessages')
      );
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setColor(0xF97316)
      .setTitle('👋 Vibe Check Bot has arrived!')
      .setDescription(
        'Use `/vibe` to check how friendly your community is.\n\n' +
        '**Analyze multiple channels in one report:**\n' +
        '`/vibe channel:#general channel2:#gaming channel3:#off-topic`'
      )
      .addFields(
        { name: '🎮 Low', value: 'Gaming/Adult', inline: true },
        { name: '⚖️ Medium', value: 'General (default)', inline: true },
        { name: '👶 High', value: 'Kids/Family', inline: true }
      )
      .setFooter({ text: 'How friendly is your community?' });

    await channel.send({ embeds: [embed] });
  } catch (err) { console.error(`❌ guildCreate error:`, err.message); }
});

client.on('guildDelete', (guild) => {
  console.log(`📤 Removed from: ${guild.name} (${guild.id})`);
});

// ============================================================
// INTERACTION HANDLER
// ============================================================

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton() && interaction.customId === 'view_progress') {
    await handleProgressCommand(interaction, '10', []);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'vibe') {
    await handleVibeCommand(interaction);
    return;
  }

  if (interaction.commandName === 'vibe-progress') {
    const range = interaction.options.getString('range') || '10';
    const filterChannels = [
      interaction.options.getChannel('channel'),
      interaction.options.getChannel('channel2'),
      interaction.options.getChannel('channel3')
    ].filter(Boolean);
    await handleProgressCommand(interaction, range, filterChannels);
    return;
  }

  if (interaction.commandName === 'vibe-admin') {
    await handleAdminCommand(interaction);
    return;
  }
});

// ============================================================
// /vibe HANDLER
// ============================================================

async function handleVibeCommand(interaction) {
  const serverId = interaction.guildId;
  const serverName = interaction.guild.name;

  if (isOnCooldown(interaction.user.id)) {
    return interaction.reply({ content: `⏳ Please wait ${CONFIG.COOLDOWN_SECONDS} seconds between reports.`, ephemeral: true });
  }

  if (isServerThrottled(serverId)) {
    return interaction.reply({ content: `⏳ This server is running too many reports at once. Please wait a minute.`, ephemeral: true });
  }
  incrementServerThrottle(serverId);

  const visibility  = interaction.options.getString('visibility')  || 'private';
  const sensitivity = interaction.options.getString('sensitivity') || 'medium';
  const timeframe   = interaction.options.getString('timeframe')   || '7d';
  const isPrivate   = visibility === 'private';
  const isPublic    = !isPrivate;
  const serverIsPaid = await isPaid(serverId);
  const tester       = await isTester(serverId);

  // Collect channels
  const rawChannels = [
    interaction.options.getChannel('channel') || interaction.channel,
    interaction.options.getChannel('channel2'),
    interaction.options.getChannel('channel3'),
    interaction.options.getChannel('channel4'),
    interaction.options.getChannel('channel5')
  ].filter(Boolean);

  const seen = new Set();
  const channels = rawChannels.filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true; });

  // Message count — no limit for testers
  let messageCount = interaction.options.getInteger('messages') || 100;
  if (!serverIsPaid && !tester && messageCount > CONFIG.FREE_MAX_MESSAGES) {
    messageCount = CONFIG.FREE_MAX_MESSAGES;
  }

  // Trial / limit check — skip for testers
  if (!tester && !(await canUseBot(serverId))) {
    if (serverIsPaid) {
      const { data: usageData } = await supabase.from('usage').select('month_start').eq('server_id', serverId).single();
      const monthStart = usageData?.month_start ? new Date(usageData.month_start) : new Date();
      const daysUntilReset = Math.max(1, Math.ceil(30 - ((Date.now() - monthStart.getTime()) / (1000 * 60 * 60 * 24))));
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xf59e0b).setTitle('⚠️ Monthly Limit Reached')
          .setDescription(`You've used all **${CONFIG.PRO_REPORTS_PER_MONTH} reports** this month.\nResets in **${daysUntilReset} day${daysUntilReset === 1 ? '' : 's'}**.`)
        ],
        ephemeral: true
      });
    } else {
      await sendTrialEndedEmail(serverName, serverId, interaction.user.tag);
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xf59e0b).setTitle('⚠️ Free Trial Ended')
          .setDescription(`You've used all **${CONFIG.FREE_REPORTS}** free reports.`)
          .addFields(
            { name: '⚡ Upgrade to Pro', value: `30 reports/month • Up to 1,000 messages • Multi-channel` },
            { name: 'Monthly', value: `[$8.99/mo](${CONFIG.STRIPE_MONTHLY_LINK})`, inline: true },
            { name: 'Yearly', value: `[$99/yr — save 8%](${CONFIG.STRIPE_YEARLY_LINK})`, inline: true }
          )
        ],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('Get Pro Monthly').setStyle(ButtonStyle.Link).setURL(CONFIG.STRIPE_MONTHLY_LINK),
          ...(CONFIG.YEARLY_ENABLED ? [new ButtonBuilder().setLabel('Get Pro Yearly').setStyle(ButtonStyle.Link).setURL(CONFIG.STRIPE_YEARLY_LINK)] : [])
        )],
        ephemeral: true
      });
    }
  }

  await interaction.deferReply({ ephemeral: isPrivate });
  setCooldown(interaction.user.id);

  try {
    const timeMs = { '1h': 3600000, '24h': 86400000, '7d': 604800000, '14d': 1209600000, '30d': 2592000000 }[timeframe] || 604800000;
    const timeframeLabel = { '1h': '1 hour', '24h': '24 hours', '7d': '7 days', '14d': '14 days', '30d': '30 days' }[timeframe] || '7 days';

    const msgsPerChannel = Math.floor(messageCount / channels.length);

    // ── Fetch messages once per channel and cache ──
    const cachedMessages = {};
    const channelNames   = [];
    const channelMsgCounts = {};

    for (const ch of channels) {
      if (!canReadChannel(interaction.guild, ch)) {
        return interaction.editReply(`❌ I don't have permission to read **#${ch.name}**. Please check my channel permissions.`);
      }
      const msgs = await fetchChannelMessages(ch, msgsPerChannel, timeMs);
      const chName = `#${ch.name}`;
      cachedMessages[chName]   = msgs;
      channelMsgCounts[chName] = msgs.length;
      channelNames.push(chName);
    }

    const totalMsgs = Object.values(cachedMessages).reduce((s, m) => s + m.length, 0);
    if (totalMsgs < 5) {
      return interaction.editReply('❌ Not enough messages to analyze. Need at least 5 messages in the selected timeframe. Try a longer timeframe or a different channel.');
    }

    // ── Per-channel analysis using cached messages ──
    const channelResults = {};
    let totalProcessingTime = 0, totalCost = 0, totalInputTokens = 0, totalOutputTokens = 0, totalAnalyzed = 0;

    for (const ch of channels) {
      const chName = `#${ch.name}`;
      const chMsgs = cachedMessages[chName] || [];
      if (chMsgs.length < 2) { channelResults[chName] = null; continue; }
      const res = await analyzeMessages(chMsgs, [chName], sensitivity, timeframeLabel);
      channelResults[chName]    = res;
      totalProcessingTime      += res.processingTime || 0;
      totalCost                += res.cost || 0;
      totalInputTokens         += res.inputTokens || 0;
      totalOutputTokens        += res.outputTokens || 0;
      totalAnalyzed            += res.analyzedCount || 0;
    }

    const validChannels = Object.entries(channelResults).filter(([, r]) => r !== null);
    if (validChannels.length === 0) {
      return interaction.editReply('❌ Not enough messages in any channel. Try a longer timeframe.');
    }

    // Impact score = weighted average
    const totalMsgsForWeight = validChannels.reduce((s, [, r]) => s + r.analyzedCount, 0) || 1;
    const impactScore = parseFloat(
      (validChannels.reduce((s, [, r]) => s + r.result.friendlinessScore * r.analyzedCount, 0) / totalMsgsForWeight).toFixed(1)
    );

    // Merge sentiment + toxicity
    const combinedSentiment  = { friendly: 0, neutral: 0, unfriendly: 0 };
    const combinedToxTypes   = {};
    const combinedFlagged    = [];

    for (const [, res] of validChannels) {
      combinedSentiment.friendly   += res.result.sentiment.friendly   || 0;
      combinedSentiment.neutral    += res.result.sentiment.neutral    || 0;
      combinedSentiment.unfriendly += res.result.sentiment.unfriendly || 0;
      if (res.result.toxicityTypes) {
        Object.entries(res.result.toxicityTypes).forEach(([k, v]) => { combinedToxTypes[k] = (combinedToxTypes[k] || 0) + (v || 0); });
      }
      if (res.result.flaggedMessages) combinedFlagged.push(...res.result.flaggedMessages);
    }

    const worstChannel = [...validChannels].sort((a, b) => a[1].result.friendlinessScore - b[1].result.friendlinessScore)[0];
    const combinedSummary = validChannels.length > 1
      ? `Overall impact score across ${validChannels.length} channels: ${impactScore}/10. ${worstChannel[0]} needs the most attention.`
      : validChannels[0][1].result.summary || '';
    const combinedRec = validChannels.length > 1
      ? `Focus moderation efforts on ${worstChannel[0]} (score: ${worstChannel[1].result.friendlinessScore}/10). ${worstChannel[1].result.recommendation || ''}`
      : validChannels[0][1].result.recommendation || '';

    const result = {
      friendlinessScore: impactScore,
      sentiment:         combinedSentiment,
      flaggedMessages:   combinedFlagged.sort((a, b) => b.severity - a.severity).slice(0, 10),
      toxicityTypes:     combinedToxTypes,
      summary:           combinedSummary,
      recommendation:    combinedRec
    };

    const reactionStats = await getChannelStats(interaction.guild, channels[0]);

    // Increment usage (skipped for testers)
    await incrementUsage(serverId);
    const remaining = await getReportsRemaining(serverId);

    const reportEmbed = buildReportEmbed(
      result, totalAnalyzed, channelNames,
      timeframeLabel, sensitivity, remaining, serverIsPaid,
      reactionStats, reactionStats, isPublic, channelMsgCounts, channelResults
    );

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('📧 Request Tools').setStyle(ButtonStyle.Link).setURL('https://www.felixagaming.com/vibe'),
      new ButtonBuilder().setLabel('📈 View Progress').setStyle(ButtonStyle.Primary).setCustomId('view_progress')
    );
    if (!serverIsPaid && !tester) {
      buttons.addComponents(new ButtonBuilder().setLabel('⚡ Upgrade to Pro').setStyle(ButtonStyle.Link).setURL(CONFIG.STRIPE_MONTHLY_LINK));
    }

    await interaction.editReply({ embeds: [reportEmbed], components: [buttons] });

    // Save + log
    await saveReport(serverId, serverName, channelNames, result.friendlinessScore, result.sentiment, result.flaggedMessages?.length || 0, sensitivity, timeframe, totalAnalyzed, result.toxicityTypes);
    await logResearchData({ serverName, serverId, memberCount: interaction.guild.memberCount, channelNames, channelResults, analyzedCount: totalAnalyzed, score: result.friendlinessScore, sentiment: result.sentiment, flaggedCount: result.flaggedMessages?.length || 0, toxicityTypes: result.toxicityTypes, sensitivity, timeframe, isPro: serverIsPaid, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cost: totalCost, processingTime: totalProcessingTime });
    await sendEmailReport(serverName, serverId, channelNames, result, totalAnalyzed, timeframeLabel, sensitivity, remaining);

    const usedNow = await getReportsUsed(serverId);
    if (usedNow === 1) await sendNewTrialEmail(serverName, serverId, interaction.user.tag);

    // Milestone every 5 reports
    if (usedNow % 5 === 0 && usedNow > 0) {
      await interaction.followUp({
        embeds: [new EmbedBuilder().setColor(0xA78BFA).setDescription(`🎉 **${usedNow} reports** completed! Want to see how your community is improving?`)],
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('📈 View Progress Report').setStyle(ButtonStyle.Primary).setCustomId('view_progress'))],
        ephemeral: true
      });
    }

    // Low reports warning
    if (!serverIsPaid && !tester && remaining > 0 && remaining <= 2) {
      await interaction.followUp({
        embeds: [new EmbedBuilder().setColor(0xf59e0b).setDescription(`⚠️ Only **${remaining}** free ${remaining === 1 ? 'report' : 'reports'} left. [Get Pro](${CONFIG.STRIPE_MONTHLY_LINK}) for 30/month.`)],
        ephemeral: true
      });
    }

    // Pro expiry warning
    if (serverIsPaid) {
      const subStatus = await getSubscriptionStatus(serverId);
      if (subStatus.isActive && subStatus.daysLeft <= 7) {
        await interaction.followUp({
          embeds: [new EmbedBuilder().setColor(0xf59e0b).setTitle('⏰ Subscription Expiring Soon').setDescription(`Your Pro subscription expires in **${subStatus.daysLeft} day${subStatus.daysLeft === 1 ? '' : 's'}**!\n\nRenew to keep access.`)],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('🔄 Renew Monthly — $8.99').setStyle(ButtonStyle.Link).setURL(CONFIG.STRIPE_MONTHLY_LINK),
            ...(CONFIG.YEARLY_ENABLED ? [new ButtonBuilder().setLabel('💎 Renew Yearly — $99').setStyle(ButtonStyle.Link).setURL(CONFIG.STRIPE_YEARLY_LINK)] : [])
          )],
          ephemeral: true
        });
      }
    }

  } catch (err) {
    console.error('Vibe error:', err);
    try { await interaction.editReply('❌ Something went wrong. Please try again in a moment.'); } catch {}
  }
}

// ============================================================
// /vibe-progress HANDLER — with graphs and descriptive analysis
// ============================================================

async function handleProgressCommand(interaction, range, filterChannels) {
  const serverId = interaction.guildId;
  await interaction.deferReply({ ephemeral: true });

  try {
    let query = supabase.from('reports').select('*').eq('server_id', serverId).order('created_at', { ascending: false });

    if (range === '30d') {
      query = query.gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
    } else {
      query = query.limit(parseInt(range) || 10);
    }

    const { data: reports, error } = await query;
    if (error || !reports || reports.length === 0) {
      return interaction.editReply('❌ No reports found. Run `/vibe` first to start tracking progress.');
    }

    const sorted = [...reports].reverse(); // oldest → newest

    // ── SINGLE OR ALL CHANNELS MODE ──
    let filteredReports = sorted;
    let filterLabel = '';

    if (filterChannels && filterChannels.length === 1) {
      const chName = `#${filterChannels[0].name}`;
      filteredReports = sorted.filter(r => r.channel_name && r.channel_name.includes(chName));
      filterLabel = ` • ${chName}`;
      if (filteredReports.length === 0) {
        return interaction.editReply(`❌ No reports found for ${chName}. Run \`/vibe\` in that channel first.`);
      }
    }

    const latest  = filteredReports[filteredReports.length - 1];
    const oldest  = filteredReports[0];
    const avgScore = (filteredReports.reduce((sum, r) => sum + r.score, 0) / filteredReports.length).toFixed(1);
    const scoreDiff = (latest.score - oldest.score).toFixed(1);
    const trendArrow = scoreDiff > 0 ? `📈 +${scoreDiff}` : scoreDiff < 0 ? `📉 ${scoreDiff}` : '➡️ No change';

    // ── SCORE GRAPH — sparkline style with coloured dots ──
    const graphLines = filteredReports.map(r => {
      const date  = new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const bar   = '█'.repeat(Math.round(r.score)) + '░'.repeat(10 - Math.round(r.score));
      const dot   = r.score >= 7 ? '🟢' : r.score >= 4 ? '🟡' : '🔴';
      const label = scoreLabel(r.score);
      return `${dot} \`${date.padEnd(8)}\` \`${bar}\` **${r.score}** — ${label}`;
    });

    // ── TREND SUMMARY ──
    const latestScore = latest.score;
    const trendDesc = (() => {
      const diff = parseFloat(scoreDiff);
      if (filteredReports.length < 2) return 'Only one report so far — run `/vibe` again to start tracking trends.';
      if (diff >= 2)   return `🚀 Major improvement! Your community jumped **+${diff} points**. Something is working — keep it up.`;
      if (diff >= 0.5) return `📈 Trending upward by **+${diff} points**. Your moderation efforts are paying off.`;
      if (diff === 0)  return `➡️ Score is holding steady at **${latestScore}/10**. Community is stable.`;
      if (diff >= -0.5) return `⚠️ Slight dip of **${diff} points**. Keep an eye on flagged messages.`;
      if (diff >= -2)  return `📉 Score dropped **${diff} points**. Consider reviewing recent flagged messages and reminding members of the rules.`;
      return `🚨 Significant drop of **${diff} points**. Immediate moderation attention recommended.`;
    })();

    // ── SENTIMENT EVOLUTION ──
    const safeDiv = (n, d) => d === 0 ? 0 : Math.round((n / d) * 100);
    const oldTotal = (oldest.friendly || 0) + (oldest.neutral || 0) + (oldest.unfriendly || 0);
    const newTotal = (latest.friendly || 0) + (latest.neutral || 0) + (latest.unfriendly || 0);

    const firstFriendlyPct   = safeDiv(oldest.friendly, oldTotal);
    const lastFriendlyPct    = safeDiv(latest.friendly, newTotal);
    const firstUnfriendlyPct = safeDiv(oldest.unfriendly, oldTotal);
    const lastUnfriendlyPct  = safeDiv(latest.unfriendly, newTotal);

    const friendlyChange    = lastFriendlyPct - firstFriendlyPct;
    const unfriendlyChange  = lastUnfriendlyPct - firstUnfriendlyPct;
    const friendlyArrow     = friendlyChange > 0 ? `🟢 ↑+${friendlyChange}%` : friendlyChange < 0 ? `🔴 ↓${friendlyChange}%` : `➡️ 0%`;
    const unfriendlyArrow   = unfriendlyChange > 0 ? `🔴 ↑+${unfriendlyChange}%` : unfriendlyChange < 0 ? `🟢 ↓${unfriendlyChange}%` : `➡️ 0%`;

    // ── TOXICITY CUMULATIVE ──
    const toxMap = {};
    filteredReports.forEach(r => {
      try {
        const types = typeof r.toxicity_types === 'string' ? JSON.parse(r.toxicity_types) : r.toxicity_types;
        if (types) Object.entries(types).forEach(([k, v]) => { toxMap[k] = (toxMap[k] || 0) + (v || 0); });
      } catch {}
    });
    const toxEntries = Object.entries(toxMap).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const maxTox = toxEntries[0]?.[1] || 1;
    const toxBars = toxEntries.slice(0, 5).map(([k, v]) => {
      const filled = Math.round((v / maxTox) * 8);
      return `\`${'█'.repeat(filled)}${'░'.repeat(8 - filled)}\` **${k}**: ${v}`;
    }).join('\n') || 'None detected ✅';

    // ── FLAGGED TREND ──
    const firstFlagged = oldest.flagged_count || 0;
    const lastFlagged  = latest.flagged_count  || 0;
    const flagDiff     = lastFlagged - firstFlagged;
    const flagTrend    = flagDiff < 0 ? `✅ ↓ Down ${Math.abs(flagDiff)} (improving)` : flagDiff > 0 ? `⚠️ ↑ Up ${flagDiff} (needs attention)` : `➡️ Stable`;

    // ── PER-CHANNEL COMPARISON (if multiple channels in data) ──
    const allChannelsInData = [...new Set(sorted.map(r => r.channel_name).filter(Boolean))];
    let perChannelField = null;
    if (allChannelsInData.length > 1) {
      const lines = allChannelsInData.map(chName => {
        const chReports = sorted.filter(r => r.channel_name === chName);
        if (chReports.length < 1) return null;
        const chLatest = chReports[chReports.length - 1].score;
        const chOldest = chReports[0].score;
        const chDiff = (chLatest - chOldest).toFixed(1);
        const arrow = chDiff > 0 ? `📈 +${chDiff}` : chDiff < 0 ? `📉 ${chDiff}` : '➡️ stable';
        const dot = chLatest >= 7 ? '🟢' : chLatest >= 4 ? '🟡' : '🔴';
        const bar = '█'.repeat(Math.round(chLatest)) + '░'.repeat(10 - Math.round(chLatest));
        return `${dot} **${chName}**  \`${bar}\`  **${chLatest}/10**  ${arrow}`;
      }).filter(Boolean);
      if (lines.length > 0) perChannelField = lines.join('\n');
    }

    // ── DESCRIPTIVE ANALYSIS ──
    const descriptiveAnalysis = (() => {
      const lines = [];

      // Overall health statement
      if (latestScore >= 8)      lines.push(`✨ **Thriving Community** — Your server is in excellent health with a score of ${latestScore}/10.`);
      else if (latestScore >= 6) lines.push(`👍 **Healthy Community** — Your server is generally positive at ${latestScore}/10.`);
      else if (latestScore >= 4) lines.push(`⚠️ **Mixed Atmosphere** — Your server score of ${latestScore}/10 suggests room for improvement.`);
      else                        lines.push(`🚨 **Needs Attention** — A score of ${latestScore}/10 indicates significant toxicity issues.`);

      // Friendly % insight
      if (lastFriendlyPct >= 70) lines.push(`🟢 **${lastFriendlyPct}% of messages are friendly** — your community is welcoming to new members.`);
      else if (lastFriendlyPct >= 50) lines.push(`🟡 **${lastFriendlyPct}% friendly messages** — most interactions are positive but there's room to grow.`);
      else lines.push(`🔴 **Only ${lastFriendlyPct}% friendly messages** — consider posting community guidelines and increasing moderation.`);

      // Trend insight
      if (parseFloat(scoreDiff) > 0) lines.push(`📈 Score improved by **+${scoreDiff} points** since first report — your efforts are working!`);
      else if (parseFloat(scoreDiff) < 0) lines.push(`📉 Score dropped by **${scoreDiff} points** — recent events may have impacted community health.`);

      // Top toxicity type
      if (toxEntries.length > 0) {
        const [topType, topCount] = toxEntries[0];
        lines.push(`⚠️ Most common issue: **${topType}** (${topCount} instances across all reports).`);
      }

      return lines.join('\n');
    })();

    // ── RECOMMENDATIONS ──
    const recommendations = [];
    const diff = parseFloat(scoreDiff);
    if (diff < -0.5) recommendations.push(`📉 Score dropped ${Math.abs(diff)} points — post a community guidelines reminder and review recent flagged messages.`);
    else if (diff > 0.5) recommendations.push(`📈 Great progress (+${diff} pts) — keep current moderation. Consider highlighting positive contributors.`);
    else recommendations.push(`➡️ Score is stable — run a targeted `/vibe` on your lowest-performing channel to find improvement areas.`);
    if (lastFlagged > firstFlagged) recommendations.push(`⚠️ Flagged messages increased (${firstFlagged} → ${lastFlagged}) — consider stricter auto-mod rules or a warning post.`);
    if (lastUnfriendlyPct > firstUnfriendlyPct) recommendations.push(`🔴 Unfriendly messages rose ${firstUnfriendlyPct}% → ${lastUnfriendlyPct}% — a pinned reminder of community rules may help.`);

    // ── BUILD EMBED ──
    const embed = new EmbedBuilder()
      .setColor(latestScore >= 7 ? 0x22c55e : latestScore >= 4 ? 0xf59e0b : 0xef4444)
      .setTitle(`📈 Progress Report — ${interaction.guild.name}`)
      .setDescription(
        `**${filteredReports.length} report${filteredReports.length === 1 ? '' : 's'} analyzed**${filterLabel} • ` +
        `First: **${oldest.score}/10** → Latest: **${latest.score}/10** • ${trendArrow}`
      )
      .addFields(
        // ── Section 1: Score graph ──
        {
          name: '📊 Score History  (oldest → newest)',
          value: graphLines.slice(-10).join('\n') || 'Not enough data',
          inline: false
        },
        // ── Section 2: Trend summary ──
        {
          name: '🎯 Trend Analysis',
          value:
            `**Average score:** ${avgScore}/10\n` +
            `**Change:** ${trendArrow}\n\n` +
            trendDesc,
          inline: false
        },
        // ── Section 3: Descriptive analysis ──
        {
          name: '🔍 Community Health Analysis',
          value: descriptiveAnalysis,
          inline: false
        },
        // ── Section 4: Sentiment evolution ──
        {
          name: '💬 Sentiment Evolution',
          value:
            `🟢 **Friendly:**     ${firstFriendlyPct}% → ${lastFriendlyPct}%  ${friendlyArrow}\n` +
            `🔴 **Unfriendly:**  ${firstUnfriendlyPct}% → ${lastUnfriendlyPct}%  ${unfriendlyArrow}`,
          inline: false
        },
        // ── Section 5: Flagged messages ──
        {
          name: '🚩 Flagged Messages',
          value: `First report: **${firstFlagged}** flagged | Latest: **${lastFlagged}** flagged\n${flagTrend}`,
          inline: false
        },
        // ── Section 6: Toxicity breakdown ──
        {
          name: '⚠️ Cumulative Toxicity Breakdown',
          value: toxBars,
          inline: false
        }
      );

    // Per-channel comparison
    if (perChannelField) {
      embed.addFields({ name: '📺 Per-Channel Score Comparison', value: perChannelField, inline: false });
    }

    // Always last: recommendations
    embed.addFields({
      name: '💡 Vibe Check Bot Recommendations',
      value: recommendations.join('\n'),
      inline: false
    });

    embed.setFooter({ text: `Vibe Check Bot • ${filteredReports.length} reports • Run /vibe regularly to build up your history` });

    await interaction.editReply({ embeds: [embed] });

  } catch (err) {
    console.error('Progress error:', err);
    try { await interaction.editReply('❌ Something went wrong loading your progress report.'); } catch {}
  }
}

// ============================================================
// /vibe-admin HANDLER
// ============================================================

async function handleAdminCommand(interaction) {
  if (interaction.user.id !== CONFIG.OWNER_ID) {
    return interaction.reply({ content: '❌ This command is for the bot owner only.', ephemeral: true });
  }

  const action      = interaction.options.getString('action');
  const serverId    = interaction.options.getString('server_id');
  const extraReports = interaction.options.getInteger('reports') || 5;

  if (!/^\d{17,19}$/.test(serverId)) {
    return interaction.reply({ content: '❌ Invalid server ID. Must be a 17-19 digit number.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  console.log(`🔧 ADMIN: ${action} on server ${serverId} by ${interaction.user.tag}`);

  try {
    // ── TESTER: unlimited access for 2 weeks ──
    if (action === 'tester') {
      const expires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
      await supabase.from('testers').upsert({
        server_id:    serverId,
        approved_at:  new Date().toISOString(),
        expires_at:   expires.toISOString()
      });
      return interaction.editReply(
        `👥 **Tester approved — unlimited access**\n` +
        `Server: \`${serverId}\`\n` +
        `Expires: **${expires.toDateString()}**\n\n` +
        `✅ No report limits, no message limits, multi-channel — all unlocked.`
      );
    }

    // ── TESTER OFF: revoke ──
    if (action === 'tester_off') {
      await supabase.from('testers').delete().eq('server_id', serverId);
      return interaction.editReply(`❌ **Tester access revoked**\nServer \`${serverId}\` is back to Free tier.`);
    }

    // ── TEST: extra free reports ──
    if (action === 'test') {
      const { data } = await supabase.from('usage').select('reports_used, free_bonus').eq('server_id', serverId).single();
      if (data) {
        await supabase.from('usage').update({ free_bonus: (data.free_bonus || 0) + extraReports }).eq('server_id', serverId);
      } else {
        await supabase.from('usage').insert({ server_id: serverId, reports_used: 0, free_bonus: extraReports, month_start: new Date().toISOString() });
      }
      return interaction.editReply(`🧪 **Test mode**\nServer: \`${serverId}\`\nAdded **${extraReports}** extra free reports.`);
    }

    // ── PRO: activate ──
    if (action === 'pro') {
      const expires = new Date();
      expires.setDate(expires.getDate() + 30);
      await supabase.from('paid_servers').upsert({ server_id: serverId, activated_at: new Date().toISOString(), expires_at: expires.toISOString() });
      return interaction.editReply(`⚡ **Pro activated**\nServer: \`${serverId}\`\nExpires: **${expires.toDateString()}**`);
    }

    // ── PRO OFF: deactivate ──
    if (action === 'pro_off') {
      await supabase.from('paid_servers').delete().eq('server_id', serverId);
      return interaction.editReply(`🔴 **Pro deactivated**\nServer: \`${serverId}\` is now on Free tier.`);
    }

  } catch (err) {
    console.error('Admin error:', err);
    return interaction.editReply(`❌ Error: ${err.message}`);
  }
}

// ============================================================
// HTTP SERVER (keeps Railway alive)
// ============================================================

http.createServer((req, res) => res.end('Vibe Check Bot is running')).listen(process.env.PORT || 3000);

// ============================================================
// START BOT
// ============================================================

client.login(process.env.DISCORD_TOKEN);
