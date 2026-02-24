const http = require('http');
// ============================================================
// VIBE CHECK BOT
// ============================================================
//
// Features:
// - /vibe command — analyze 1 to 5 channels in one report
// - /vibe-progress — track community health over time
// - OpenAI GPT-4o-mini analysis
// - Sensitivity levels: Low / Medium / High
// - Visibility: Private / Public
// - Custom timeframes and message counts
// - Supabase report storage
// - Email reports via Resend
// - Stripe paywall (5 free reports, then Pro)
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
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits
} = require('discord.js');
const OpenAI = require('openai');
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  // Plan limits
  FREE_REPORTS: 5,
  PRO_REPORTS_PER_MONTH: 30,
  FREE_MAX_MESSAGES: 500,
  PRO_MAX_MESSAGES: 1000,
  FREE_MAX_CHANNELS: 1,
  PRO_MAX_CHANNELS: 5,

  // OpenAI safety limits
  MAX_OPENAI_CHARS: 30000,
  MAX_OPENAI_MESSAGES_PER_CHANNEL: 200,

  // Stripe payment links
  STRIPE_MONTHLY_LINK: 'https://buy.stripe.com/fZu28k00n5s92Oqf4z4ow01',
  STRIPE_YEARLY_LINK: 'https://buy.stripe.com/bJebIUbJ56wd4Wye0v4ow03',

  // Contact
  CONTACT_EMAIL: 'play@felixagaming.com',
  REPORT_EMAIL: 'play@felixagaming.com',
  OWNER_ID: '1185219817913991220',

  // Stripe
  YEARLY_ENABLED: true,

  // Rate limiting
  COOLDOWN_SECONDS: 15,
  SERVER_THROTTLE_PER_MINUTE: 10,

  // Timeouts
  PENDING_COMMAND_TIMEOUT: 300000,

  // OpenAI cost tracking (GPT-4o-mini pricing)
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
// OPENAI + RESEND + SUPABASE SETUP
// ============================================================

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

  // Auto-detect placeholder Stripe yearly link
  if (!CONFIG.STRIPE_YEARLY_LINK || CONFIG.STRIPE_YEARLY_LINK.includes('YOUR_')) {
    console.warn('⚠️  Yearly plan disabled — placeholder Stripe link detected.');
    CONFIG.YEARLY_ENABLED = false;
  }

  console.log('✅ Environment validated');
}

validateEnvironment();

// ============================================================
// GLOBAL ERROR HANDLERS
// ============================================================

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err.message);
  // Don't exit — let Railway handle restarts if truly fatal
});

// ============================================================
// API CLIENTS
// ============================================================

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

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
// USAGE TRACKING (in-memory, backed by Supabase)
// ============================================================

const serverUsage = new Map();
const cooldowns = new Map();
const serverThrottle = new Map(); // server_id -> { count, resetAt }

async function getUsageFromDB(serverId) {
  try {
    const { data } = await supabase
      .from('usage')
      .select('*')
      .eq('server_id', serverId)
      .single();
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
    const { data } = await supabase
      .from('paid_servers')
      .select('server_id, expires_at')
      .eq('server_id', serverId)
      .single();
    if (!data) return false;
    if (data.expires_at && new Date(data.expires_at) < new Date()) return false;
    return true;
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
    const { data } = await supabase
      .from('paid_servers')
      .select('expires_at')
      .eq('server_id', serverId)
      .single();
    if (!data || !data.expires_at) return { isActive: false, daysLeft: 0 };
    const msLeft = new Date(data.expires_at).getTime() - Date.now();
    const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
    return { isActive: daysLeft > 0, daysLeft: Math.max(0, daysLeft) };
  } catch { return { isActive: false, daysLeft: 0 }; }
}

async function canUseBot(serverId) {
  const paid = await isPaid(serverId);
  const used = await getReportsUsed(serverId);
  if (paid) return used < CONFIG.PRO_REPORTS_PER_MONTH;
  const bonus = await getFreeBonus(serverId);
  return used < (CONFIG.FREE_REPORTS + bonus);
}

async function getReportsRemaining(serverId) {
  const paid = await isPaid(serverId);
  const used = await getReportsUsed(serverId);
  if (paid) return CONFIG.PRO_REPORTS_PER_MONTH - used;
  const bonus = await getFreeBonus(serverId);
  return (CONFIG.FREE_REPORTS + bonus) - used;
}

async function incrementUsage(serverId) {
  try {
    const { data } = await supabase
      .from('usage')
      .select('reports_used')
      .eq('server_id', serverId)
      .single();

    if (data) {
      await supabase
        .from('usage')
        .update({ reports_used: (data.reports_used || 0) + 1 })
        .eq('server_id', serverId);
    } else {
      await supabase
        .from('usage')
        .insert({ server_id: serverId, reports_used: 1, month_start: new Date().toISOString() });
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

function setCooldown(userId) {
  cooldowns.set(userId, Date.now());
}

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
// FETCH MESSAGES FROM A CHANNEL
// ============================================================

// ============================================================
// MESSAGE SANITIZATION
// ============================================================

function sanitizeMessage(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<@!?\d+>/g, '[user]')          // user mentions
    .replace(/<#\d+>/g, '[channel]')           // channel mentions
    .replace(/<@&\d+>/g, '[role]')             // role mentions
    .replace(/@(everyone|here)/g, '[mention]') // @everyone / @here
    .replace(/https?:\/\/\S+/g, '[link]')      // URLs
    .replace(/\w{50,}/g, '[...]')               // absurdly long words (potential injection)
    .trim()
    .slice(0, 500);                             // hard cap per message
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
      !m.author.bot &&
      m.content.length > 0 &&
      m.createdTimestamp > cutoffTime
    );

    allMessages.push(...filtered.map(m => sanitizeMessage(m.content)).filter(Boolean));
    lastId = fetched.last().id;

    if (fetched.last().createdTimestamp < cutoffTime) break;
  }

  return allMessages.slice(0, messageCount);
}

// ============================================================
// AI ANALYSIS
// ============================================================

async function analyzeMessages(messages, channelNames, sensitivity, timeframeLabel) {
  const totalMessages = messages.length;

  // Safety: trim if too large
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
      break; // success
    } catch (err) {
      const isRetryable = err.status === 429 || err.status >= 500;
      if (attempt === maxAttempts || !isRetryable) throw err;
      const delay = attempt * 2000; // 2s, 4s
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

  // Validate sentiment totals
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

function clamp(val, min, max) {
  return Math.min(Math.max(Number(val) || 0, min), max);
}

// ============================================================
// BUILD SCORE BAR
// ============================================================

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

// ============================================================
// BUILD DISCORD EMBED REPORT
// ============================================================

function buildReportEmbed(result, analyzedCount, channelNames, timeframeLabel, sensitivity, remaining, isPaidServer, reactions = null, stats = null, isPublic = false, channelMsgCounts = {}) {
  const score = result.friendlinessScore;
  const bar = buildScoreBar(score);
  const { friendly, neutral, unfriendly } = result.sentiment;
  const total = friendly + neutral + unfriendly;

  const friendlyPct = Math.round((friendly / total) * 100);
  const neutralPct = Math.round((neutral / total) * 100);
  const unfriendlyPct = Math.round((unfriendly / total) * 100);

  const channelDisplay = channelNames.length === 1
    ? channelNames[0]
    : channelNames.join(', ');

  const communityDesc = score >= 8 ? 'Your community is thriving and welcoming.'
    : score >= 6 ? 'Your community is generally positive.'
    : score >= 4 ? 'Your community has a mixed atmosphere.'
    : 'Your community needs attention.';

  const embed = new EmbedBuilder()
    .setColor(scoreColor(score))
    .setTitle(channelNames.length > 1 ? `📊 Multi-Channel Vibe Report` : `📊 Community Vibe Report`)
    .setDescription(
      `**${channelDisplay}** • Last ${timeframeLabel} • ${analyzedCount} messages • Sensitivity: **${sensitivity.charAt(0).toUpperCase() + sensitivity.slice(1)}**\n\n` +
      `**${scoreEmoji(score)} Friendliness Score: ${score}/10**\n` +
      `\`${bar}\`\n` +
      `*${communityDesc}*`
    );

  // ── Section 1: Descriptive ──
  // Member stats
  if (stats) {
    const memberLine = stats.membersWithAccess !== null
      ? `👥 Members with access: **${stats.membersWithAccess}** | 💬 Active (7d): **${stats.activeMembers}**`
      : `👥 Server members: **${stats.totalMembers}**`;
    embed.addFields({ name: '📋 Channel Info', value: memberLine, inline: false });
  }

  // ── Multi-channel comparison (when 2+ channels) ──
  if (channelNames.length > 1 && Object.keys(channelMsgCounts).length > 0) {
    const totalMsgs = Object.values(channelMsgCounts).reduce((s, v) => s + v, 0) || 1;
    const comparison = channelNames.map(ch => {
      const count = channelMsgCounts[ch] || 0;
      const pct = Math.round((count / totalMsgs) * 100);
      const barLen = Math.round((count / totalMsgs) * 10);
      const bar = '█'.repeat(barLen) + '░'.repeat(10 - barLen);
      return `**${ch}**  \`${bar}\`  ${count} msgs (${pct}%)`;
    }).join('\n');
    embed.addFields({ name: '📊 Channel Breakdown', value: comparison, inline: false });
  }

  embed.addFields({
    name: '💬 Sentiment Breakdown',
    value:
      `🟢 Friendly   \`${String(friendly).padStart(4)}\`  ${friendlyPct}%\n` +
      `⚪ Neutral    \`${String(neutral).padStart(4)}\`  ${neutralPct}%\n` +
      `🔴 Unfriendly \`${String(unfriendly).padStart(4)}\`  ${unfriendlyPct}%`,
    inline: false
  });

  if (result.summary) {
    embed.addFields({ name: '🗒️ Summary', value: result.summary, inline: false });
  }

  // ── Section 2: Toxicity ──
  if (isPublic) {
    // Public report — never show message content, only counts and types
    const flaggedCount = result.flaggedMessages?.length || 0;
    if (flaggedCount > 0) {
      const typeBreakdown = result.toxicityTypes
        ? Object.entries(result.toxicityTypes)
            .filter(([, v]) => v > 0)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `• ${k}: ${v}`)
            .join('\n')
        : 'See full report for details.';
      embed.addFields({
        name: `⚠️ Toxicity Summary (${flaggedCount} flagged)`,
        value: typeBreakdown.substring(0, 1024) || 'Types unavailable.',
        inline: false
      });
    } else {
      embed.addFields({ name: '✅ No Flagged Content', value: 'No harmful content detected.', inline: false });
    }
  } else {
    // Private report — toxicity breakdown bars + full flagged messages
    if (result.toxicityTypes && Object.keys(result.toxicityTypes).length > 0) {
      const types = Object.entries(result.toxicityTypes)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1]);
      const maxVal = types[0]?.[1] || 1;
      const toxBars = types.map(([k, v]) => {
        const filled = Math.round((v / maxVal) * 8);
        const bar = '█'.repeat(filled) + '░'.repeat(8 - filled);
        return `\`${bar}\` ${k}: ${v}`;
      }).join('\n');
      embed.addFields({ name: '🧪 Toxicity Breakdown', value: toxBars.substring(0, 1024), inline: false });
    }

    if (result.flaggedMessages && result.flaggedMessages.length > 0) {
      const flaggedList = result.flaggedMessages
        .sort((a, b) => b.severity - a.severity)
        .slice(0, 10)
        .map(f => `• [\`${f.type}\` ${f.severity}/10] ${f.message.substring(0, 80)}${f.message.length > 80 ? '...' : ''}`)
        .join('\n');

      embed.addFields({
        name: `⚠️ Flagged Messages (${result.flaggedMessages.length})`,
        value: flaggedList.substring(0, 1024),
        inline: false
      });

      if (result.flaggedMessages.length > 10) {
        embed.addFields({
          name: '',
          value: `_...and ${result.flaggedMessages.length - 10} more in the email report_`,
          inline: false
        });
      }
    } else {
      embed.addFields({ name: '✅ No Flagged Messages', value: 'No harmful content detected.', inline: false });
    }
  }

  // ── Section 3: Reactions ──
  if (reactions && !isPublic) {
    // Reaction comments contain message text — private only
    const reactionLines = [];
    if (reactions.mostReacted)  reactionLines.push(`⭐ **Most reacted:** "${reactions.mostReacted.text}" — ${reactions.mostReacted.reactions}`);
    if (reactions.mostPositive) reactionLines.push(`👍 **Most positive:** "${reactions.mostPositive.text}" — ${reactions.mostPositive.reactions}`);
    if (reactions.mostNegative) reactionLines.push(`👎 **Most negative:** "${reactions.mostNegative.text}" — ${reactions.mostNegative.reactions}`);
    if (reactionLines.length > 0) {
      embed.addFields({ name: '💬 Most Reacted Comments', value: reactionLines.join('\n'), inline: false });
    }
  } else if (reactions && isPublic) {
    // Public — show reaction counts only, no message text
    const reactionLines = [];
    if (reactions.mostReacted)  reactionLines.push(`⭐ **Most reacted:** ${reactions.mostReacted.reactions}`);
    if (reactions.mostPositive) reactionLines.push(`👍 **Most positive reactions:** ${reactions.mostPositive.reactions}`);
    if (reactions.mostNegative) reactionLines.push(`👎 **Most negative reactions:** ${reactions.mostNegative.reactions}`);
    if (reactionLines.length > 0) {
      embed.addFields({ name: '💬 Reaction Summary', value: reactionLines.join('\n'), inline: false });
    }
  }

  // ── Vibe Check Bot Recommendations (always last) ──
  if (result.recommendation) {
    embed.addFields({ name: '💡 Vibe Check Bot Recommendations', value: result.recommendation, inline: false });
  }

  // CTA
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

// ============================================================
// RESEARCH LOGGING
// ============================================================

async function logResearchData(data) {
  try {
    // One row per channel
    const rows = data.channelNames.map(channelName => ({
      server_name:       data.serverName,
      server_id:         data.serverId,
      member_count:      data.memberCount,
      channel_name:      channelName,
      messages_analyzed: data.analyzedCount,
      score:             data.score,
      friendly:          data.sentiment.friendly,
      neutral:           data.sentiment.neutral,
      unfriendly:        data.sentiment.unfriendly,
      flagged_count:     data.flaggedCount,
      toxicity_types:    data.toxicityTypes || {},
      sensitivity:       data.sensitivity,
      timeframe:         data.timeframe,
      is_pro:            data.isPro,
      input_tokens:      data.inputTokens,
      output_tokens:     data.outputTokens,
      cost_usd:          data.cost,
      processing_time_ms: data.processingTime
    }));

    const { error } = await supabase.from('research_logs').insert(rows);
    if (error) console.error('Research log error:', error.message);
    else console.log(`📊 Research logged: ${rows.length} channel(s), score ${data.score}, $${data.cost?.toFixed(6)}`);
  } catch (err) {
    console.error('Research logging failed:', err.message);
  }
}

async function saveReport(serverId, serverName, channelNames, score, sentiment, flaggedCount, sensitivity, timeframe, analyzedCount, toxicityTypes) {
  try {
    await supabase.from('reports').insert({
      server_id: serverId,
      server_name: serverName,
      channel_name: channelNames.join(', '),
      score: score,
      friendly: sentiment.friendly,
      neutral: sentiment.neutral,
      unfriendly: sentiment.unfriendly,
      flagged_count: flaggedCount,
      sensitivity: sensitivity,
      timeframe: timeframe,
      messages_analyzed: analyzedCount,
      toxicity_types: JSON.stringify(toxicityTypes || {}),
      created_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('Save report error:', err.message);
  }
}

// ============================================================
// SEND EMAIL REPORT
// ============================================================

async function sendEmailReport(serverName, serverId, channelNames, result, analyzedCount, timeframe, sensitivity, remaining) {
  try {
    const flaggedHtml = result.flaggedMessages && result.flaggedMessages.length > 0
      ? result.flaggedMessages
        .sort((a, b) => b.severity - a.severity)
        .map(f => `<li><strong>[${f.type} - ${f.severity}/10]</strong> ${f.message}</li>`)
        .join('')
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
            <tr><td style="padding:6px;border-bottom:1px solid #eee"><strong>Server ID</strong></td><td>${serverId}</td></tr>
            <tr><td style="padding:6px;border-bottom:1px solid #eee"><strong>Channel(s)</strong></td><td>${channelNames.join(', ')}</td></tr>
            <tr><td style="padding:6px;border-bottom:1px solid #eee"><strong>Messages</strong></td><td>${analyzedCount}</td></tr>
            <tr><td style="padding:6px;border-bottom:1px solid #eee"><strong>Timeframe</strong></td><td>${timeframe}</td></tr>
            <tr><td style="padding:6px;border-bottom:1px solid #eee"><strong>Sensitivity</strong></td><td>${sensitivity}</td></tr>
            <tr><td style="padding:6px;border-bottom:1px solid #eee"><strong>Score</strong></td><td><strong style="color:${result.friendlinessScore >= 7 ? '#22c55e' : result.friendlinessScore >= 4 ? '#f59e0b' : '#ef4444'}">${result.friendlinessScore}/10</strong></td></tr>
            <tr><td style="padding:6px;border-bottom:1px solid #eee"><strong>Friendly</strong></td><td>${result.sentiment.friendly}</td></tr>
            <tr><td style="padding:6px;border-bottom:1px solid #eee"><strong>Neutral</strong></td><td>${result.sentiment.neutral}</td></tr>
            <tr><td style="padding:6px;border-bottom:1px solid #eee"><strong>Unfriendly</strong></td><td>${result.sentiment.unfriendly}</td></tr>
            <tr><td style="padding:6px;border-bottom:1px solid #eee"><strong>Flagged</strong></td><td>${result.flaggedMessages ? result.flaggedMessages.length : 0}</td></tr>
            <tr><td style="padding:6px;border-bottom:1px solid #eee"><strong>Reports Remaining</strong></td><td>${remaining}</td></tr>
          </table>
          <h3 style="margin-top:20px">⚠️ All Flagged Messages</h3>
          <ul>${flaggedHtml}</ul>
          <h3>💡 Vibe Check Bot Recommendations</h3>
          <p>${result.recommendation || 'N/A'}</p>
        </div>
      `
    });
  } catch (err) {
    console.error('Email error:', err.message);
  }
}

// ============================================================
// NOTIFICATION EMAILS (owner alerts)
// ============================================================

async function sendNewTrialEmail(serverName, serverId, userName) {
  try {
    await resend.emails.send({
      from: 'Vibe Check Bot <noreply@vibecheckbot.com>',
      to: CONFIG.REPORT_EMAIL,
      subject: `🆕 New Free Trial: ${serverName}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
          <div style="background:linear-gradient(135deg,#3b82f6,#1d4ed8);padding:20px;text-align:center">
            <h1 style="color:white;margin:0">🆕 New Free Trial Started</h1>
          </div>
          <div style="padding:20px;background:#f9fafb">
            <p><strong>Server:</strong> ${serverName}</p>
            <p><strong>Server ID:</strong> ${serverId}</p>
            <p><strong>Started by:</strong> ${userName}</p>
            <p><strong>Free reports:</strong> ${CONFIG.FREE_REPORTS}</p>
          </div>
          <div style="padding:20px;background:#eff6ff">
            <p style="margin:0">💡 This is report #1 of ${CONFIG.FREE_REPORTS}. You'll get another notification when their trial ends.</p>
          </div>
        </div>
      `
    });
  } catch (err) { console.error('New trial email error:', err.message); }
}

async function sendTrialEndedEmail(serverName, serverId, userName) {
  try {
    await resend.emails.send({
      from: 'Vibe Check Bot <noreply@vibecheckbot.com>',
      to: CONFIG.REPORT_EMAIL,
      subject: `🔔 Trial Ended: ${serverName}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
          <div style="background:linear-gradient(135deg,#f59e0b,#d97706);padding:20px;text-align:center">
            <h1 style="color:white;margin:0">🔔 Trial Ended</h1>
          </div>
          <div style="padding:20px;background:#f9fafb">
            <p><strong>Server:</strong> ${serverName}</p>
            <p><strong>Server ID:</strong> ${serverId}</p>
            <p><strong>Last used by:</strong> ${userName}</p>
            <p><strong>Reports used:</strong> ${CONFIG.FREE_REPORTS}/${CONFIG.FREE_REPORTS}</p>
          </div>
          <div style="padding:20px;background:#fef3c7">
            <p style="margin:0">💰 They've been shown the Stripe payment link.</p>
            <p style="margin-top:10px">To give them extra free reports: <code>/vibe-admin action:test server_id:${serverId}</code></p>
            <p style="margin-top:6px">To activate Pro manually: <code>/vibe-admin action:pro server_id:${serverId}</code></p>
          </div>
        </div>
      `
    });
  } catch (err) { console.error('Trial ended email error:', err.message); }
}

async function sendProgressReportEmail(serverName, serverId, channelNames, reports, requestedBy) {
  try {
    if (!reports || reports.length < 2) return;
    const oldest = reports[0];
    const latest = reports[reports.length - 1];
    const diff = (latest.score - oldest.score).toFixed(1);
    const trend = diff > 0 ? `📈 +${diff}` : diff < 0 ? `📉 ${diff}` : `➡️ 0.0`;
    await resend.emails.send({
      from: 'Vibe Check Bot <noreply@vibecheckbot.com>',
      to: CONFIG.REPORT_EMAIL,
      subject: `📈 Progress Report Viewed — ${serverName}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
          <div style="background:linear-gradient(135deg,#8b5cf6,#6d28d9);padding:20px;text-align:center">
            <h1 style="color:white;margin:0">📈 Progress Report</h1>
          </div>
          <div style="padding:20px;background:#f9fafb">
            <p><strong>Server:</strong> ${serverName}</p>
            <p><strong>Server ID:</strong> ${serverId}</p>
            <p><strong>Requested by:</strong> ${requestedBy}</p>
            <p><strong>Channels:</strong> ${channelNames.join(', ')}</p>
            <p><strong>Reports analyzed:</strong> ${reports.length}</p>
            <p><strong>Score trend:</strong> ${oldest.score}/10 → ${latest.score}/10 (${trend})</p>
          </div>
        </div>
      `
    });
  } catch (err) { console.error('Progress email error:', err.message); }
}

// ============================================================
// REGISTER SLASH COMMANDS
// ============================================================

async function registerCommands() {
  const vibeCommand = new SlashCommandBuilder()
    .setName('vibe')
    .setDescription('Check the friendliness of one or more channels')
    .addChannelOption(opt =>
      opt.setName('channel').setDescription('Channel to analyze (default: current)').setRequired(false)
        .addChannelTypes(ChannelType.GuildText))
    .addChannelOption(opt =>
      opt.setName('channel2').setDescription('2nd channel to include').setRequired(false)
        .addChannelTypes(ChannelType.GuildText))
    .addChannelOption(opt =>
      opt.setName('channel3').setDescription('3rd channel to include').setRequired(false)
        .addChannelTypes(ChannelType.GuildText))
    .addChannelOption(opt =>
      opt.setName('channel4').setDescription('4th channel to include').setRequired(false)
        .addChannelTypes(ChannelType.GuildText))
    .addChannelOption(opt =>
      opt.setName('channel5').setDescription('5th channel to include').setRequired(false)
        .addChannelTypes(ChannelType.GuildText))
    .addStringOption(opt =>
      opt.setName('timeframe').setDescription('How far back to analyze (default: 7d)').setRequired(false)
        .addChoices(
          { name: '1 hour', value: '1h' },
          { name: '24 hours', value: '24h' },
          { name: '7 days', value: '7d' },
          { name: '14 days', value: '14d' },
          { name: '30 days', value: '30d' }
        ))
    .addStringOption(opt =>
      opt.setName('sensitivity').setDescription('How strict the analysis is (default: medium)').setRequired(false)
        .addChoices(
          { name: '🎮 Low — Gaming/Adult', value: 'low' },
          { name: '⚖️ Medium — General', value: 'medium' },
          { name: '👶 High — Kids/Family', value: 'high' }
        ))
    .addStringOption(opt =>
      opt.setName('visibility').setDescription('Who sees the report (default: private)').setRequired(false)
        .addChoices(
          { name: '🔒 Private — only you', value: 'private' },
          { name: '📢 Public — everyone in channel', value: 'public' }
        ))
    .addIntegerOption(opt =>
      opt.setName('messages').setDescription('Messages per channel to analyze (default: 100)').setRequired(false)
        .addChoices(
          { name: '50 messages', value: 50 },
          { name: '100 messages', value: 100 },
          { name: '250 messages', value: 250 },
          { name: '500 messages', value: 500 },
          { name: '1000 messages (Pro)', value: 1000 }
        ));

  const progressCommand = new SlashCommandBuilder()
    .setName('vibe-progress')
    .setDescription('See your community friendliness trend over time')
    .addStringOption(opt =>
      opt.setName('range').setDescription('How many past reports to show (default: 10)').setRequired(false)
        .addChoices(
          { name: 'Last 5 reports', value: '5' },
          { name: 'Last 10 reports', value: '10' },
          { name: 'Last 20 reports', value: '20' },
          { name: 'Last 30 days', value: '30d' }
        ))
    .addChannelOption(opt =>
      opt.setName('channel').setDescription('Compare channel 1').setRequired(false)
        .addChannelTypes(ChannelType.GuildText))
    .addChannelOption(opt =>
      opt.setName('channel2').setDescription('Compare channel 2').setRequired(false)
        .addChannelTypes(ChannelType.GuildText))
    .addChannelOption(opt =>
      opt.setName('channel3').setDescription('Compare channel 3').setRequired(false)
        .addChannelTypes(ChannelType.GuildText))
    .addChannelOption(opt =>
      opt.setName('channel4').setDescription('Compare channel 4').setRequired(false)
        .addChannelTypes(ChannelType.GuildText))
    .addChannelOption(opt =>
      opt.setName('channel5').setDescription('Compare channel 5').setRequired(false)
        .addChannelTypes(ChannelType.GuildText));

  const adminCommand = new SlashCommandBuilder()
    .setName('vibe-admin')
    .setDescription('Admin controls (owner only)')
    .addStringOption(opt =>
      opt.setName('action').setDescription('Action to perform').setRequired(true)
        .addChoices(
          { name: '🧪 Test — give extra free reports', value: 'test' },
          { name: '⚡ Pro — activate Pro', value: 'pro' },
          { name: '🔴 Pro Off — deactivate Pro', value: 'pro_off' }
        ))
    .addStringOption(opt =>
      opt.setName('server_id').setDescription('Server ID').setRequired(true))
    .addIntegerOption(opt =>
      opt.setName('reports').setDescription('Number of extra reports to add (Test only, default: 5)').setRequired(false));

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
// WELCOME MESSAGE ON JOIN
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
        '**New: analyze multiple channels in one report!**\n' +
        '`/vibe channel:#general channel2:#gaming channel3:#off-topic`'
      )
      .addFields(
        { name: '🎮 Low Sensitivity', value: 'Gaming/Adult servers', inline: true },
        { name: '⚖️ Medium Sensitivity', value: 'General (default)', inline: true },
        { name: '👶 High Sensitivity', value: 'Kids/Family servers', inline: true }
      )
      .setFooter({ text: 'How friendly is your community?' });

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error(`❌ guildCreate error for ${guild.name}:`, err.message);
  }
});

client.on('guildDelete', (guild) => {
  console.log(`📤 Removed from server: ${guild.name} (${guild.id}) — Members: ${guild.memberCount}`);
});

// ============================================================
// INTERACTION HANDLER
// ============================================================

client.on('interactionCreate', async (interaction) => {

  // ── Button: View Progress ──────────────────────────────
  if (interaction.isButton() && interaction.customId === 'view_progress') {
    await handleProgressCommand(interaction, '10', []);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  // ── /vibe ──────────────────────────────────────────────
  if (interaction.commandName === 'vibe') {
    await handleVibeCommand(interaction);
    return;
  }

  // ── /vibe-progress ─────────────────────────────────────
  if (interaction.commandName === 'vibe-progress') {
    const range = interaction.options.getString('range') || '10';
    const filterChannels = [
      interaction.options.getChannel('channel'),
      interaction.options.getChannel('channel2'),
      interaction.options.getChannel('channel3'),
      interaction.options.getChannel('channel4'),
      interaction.options.getChannel('channel5')
    ].filter(Boolean);
    await handleProgressCommand(interaction, range, filterChannels);
    return;
  }

  // ── /vibe-admin ────────────────────────────────────────
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

  // Cooldown check
  if (isOnCooldown(interaction.user.id)) {
    return interaction.reply({
      content: `⏳ Please wait ${CONFIG.COOLDOWN_SECONDS} seconds between reports.`,
      ephemeral: true
    });
  }

  if (isServerThrottled(serverId)) {
    return interaction.reply({
      content: `⏳ This server is running too many reports at once. Please wait a minute and try again.`,
      ephemeral: true
    });
  }
  incrementServerThrottle(serverId);

  // Get options
  const visibility = interaction.options.getString('visibility') || 'private';
  const sensitivity = interaction.options.getString('sensitivity') || 'medium';
  const timeframe = interaction.options.getString('timeframe') || '7d';
  const isPrivate = visibility === 'private';
  const isPublic = !isPrivate;
  const serverIsPaid = await isPaid(serverId);

  // Collect channels
  const rawChannels = [
    interaction.options.getChannel('channel') || interaction.channel,
    interaction.options.getChannel('channel2'),
    interaction.options.getChannel('channel3'),
    interaction.options.getChannel('channel4'),
    interaction.options.getChannel('channel5')
  ].filter(Boolean);

  // Deduplicate
  const seen = new Set();
  const channels = rawChannels.filter(c => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });

  // Pro check for multi-channel
  if (channels.length > 1 && !serverIsPaid) {
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0xf59e0b)
        .setTitle('⚡ Multi-Channel Analysis is a Pro Feature')
        .setDescription('Upgrade to Pro to analyze up to 5 channels in one report.')
        .addFields({ name: 'Get Pro', value: `[Monthly $8.99/mo](${CONFIG.STRIPE_MONTHLY_LINK}) | [Yearly $99/yr](${CONFIG.STRIPE_YEARLY_LINK})` })
      ],
      ephemeral: true
    });
  }

  // Message count
  let messageCount = interaction.options.getInteger('messages') || 100;
  if (!serverIsPaid && messageCount > CONFIG.FREE_MAX_MESSAGES) {
    messageCount = CONFIG.FREE_MAX_MESSAGES;
  }

  // Trial / limit check
  if (!(await canUseBot(serverId))) {
    if (serverIsPaid) {
      // Pro user hit monthly limit — show days until reset
      const { data: usageData } = await supabase.from('usage').select('month_start').eq('server_id', serverId).single();
      const monthStart = usageData?.month_start ? new Date(usageData.month_start) : new Date();
      const daysUntilReset = Math.max(1, Math.ceil(30 - ((Date.now() - monthStart.getTime()) / (1000 * 60 * 60 * 24))));
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0xf59e0b)
          .setTitle('⚠️ Monthly Limit Reached')
          .setDescription(`You've used all **${CONFIG.PRO_REPORTS_PER_MONTH} reports** this month.\n\nYour reports reset in **${daysUntilReset} day${daysUntilReset === 1 ? '' : 's'}**.`)
          .addFields({ name: '💡 Tip', value: 'Upgrade to yearly to get more reports at a lower cost.', inline: false },
            { name: 'Yearly', value: `[$99/yr — save 8%](${CONFIG.STRIPE_YEARLY_LINK})`, inline: true })
        ],
        components: [new ActionRowBuilder().addComponents(
          ...(CONFIG.YEARLY_ENABLED ? [new ButtonBuilder().setLabel('Upgrade to Yearly').setStyle(ButtonStyle.Link).setURL(CONFIG.STRIPE_YEARLY_LINK)] : [])
        )],
        ephemeral: true
      });
    } else {
      // Free trial ended — notify owner by email then show paywall
      await sendTrialEndedEmail(serverName, serverId, interaction.user.tag);
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0xf59e0b)
          .setTitle('⚠️ Free Trial Ended')
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
    // Timeframe in ms
    const timeMs = {
      '1h': 1 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      '14d': 14 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000
    }[timeframe] || (7 * 24 * 60 * 60 * 1000);

    const timeframeLabel = {
      '1h': '1 hour', '24h': '24 hours', '7d': '7 days',
      '14d': '14 days', '30d': '30 days'
    }[timeframe] || '7 days';

    // Fetch messages from all channels
    const msgsPerChannel = Math.floor(messageCount / channels.length);
    let allMessages = [];
    const channelNames = [];
    const channelMsgCounts = {}; // track per-channel message counts

    for (const ch of channels) {
      if (!canReadChannel(interaction.guild, ch)) {
        return interaction.editReply(`❌ I don't have permission to read **#${ch.name}**. Please check my channel permissions and try again.`);
      }
      const msgs = await fetchChannelMessages(ch, msgsPerChannel, timeMs);
      channelMsgCounts[`#${ch.name}`] = msgs.length;
      allMessages = allMessages.concat(msgs);
      channelNames.push(`#${ch.name}`);
    }

    if (allMessages.length < 5) {
      return interaction.editReply('❌ Not enough messages to analyze. Need at least 5 messages. Try a longer timeframe.');
    }

    // Shuffle to mix channels
    allMessages = allMessages.sort(() => Math.random() - 0.5);

    // Analyze
    const { result, analyzedCount, processingTime, cost, inputTokens, outputTokens } = await analyzeMessages(
      allMessages, channelNames, sensitivity, timeframeLabel
    );

    // Fetch reaction stats from primary channel
    const reactionStats = await getChannelStats(interaction.guild, channels[0], timeMs);

    // Increment usage
    await incrementUsage(serverId);
    const remaining = await getReportsRemaining(serverId);

    // Build embed
    const reportEmbed = buildReportEmbed(
      result, analyzedCount, channelNames,
      timeframeLabel, sensitivity, remaining, serverIsPaid, reactionStats, reactionStats, isPublic, channelMsgCounts
    );

    // Buttons
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('📧 Request Tools')
        .setStyle(ButtonStyle.Link)
        .setURL('https://www.felixagaming.com/vibe'),
      new ButtonBuilder()
        .setLabel('📈 View Progress')
        .setStyle(ButtonStyle.Primary)
        .setCustomId('view_progress')
    );

    if (!serverIsPaid) {
      buttons.addComponents(
        new ButtonBuilder()
          .setLabel('⚡ Upgrade to Pro')
          .setStyle(ButtonStyle.Link)
          .setURL(CONFIG.STRIPE_MONTHLY_LINK)
      );
    }

    await interaction.editReply({ embeds: [reportEmbed], components: [buttons] });

    // Save to Supabase
    await saveReport(
      serverId, serverName, channelNames,
      result.friendlinessScore, result.sentiment,
      result.flaggedMessages?.length || 0,
      sensitivity, timeframe, analyzedCount,
      result.toxicityTypes
    );

    // Log to research_logs
    await logResearchData({
      serverName,
      serverId,
      memberCount:    interaction.guild.memberCount,
      channelNames,
      analyzedCount,
      score:          result.friendlinessScore,
      sentiment:      result.sentiment,
      flaggedCount:   result.flaggedMessages?.length || 0,
      toxicityTypes:  result.toxicityTypes,
      sensitivity,
      timeframe,
      isPro:          serverIsPaid,
      inputTokens,
      outputTokens,
      cost,
      processingTime
    });

    // Send email
    await sendEmailReport(
      serverName, serverId, channelNames,
      result, analyzedCount, timeframeLabel,
      sensitivity, remaining
    );

    // Owner notifications
    const usedNow = await getReportsUsed(serverId);
    if (usedNow === 1) {
      // First ever report — new trial started
      await sendNewTrialEmail(serverName, serverId, interaction.user.tag);
    }

    // Milestone message every 5 reports
    const used = await getReportsUsed(serverId);
    if (used % 5 === 0) {
      const milestoneEmbed = new EmbedBuilder()
        .setColor(0xA78BFA)
        .setDescription(
          `🎉 You've completed **${used} reports**!\nWant to see how your community is improving?`
        );
      const milestoneButton = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('📈 View Progress Report')
          .setStyle(ButtonStyle.Primary)
          .setCustomId('view_progress')
      );
      await interaction.followUp({ embeds: [milestoneEmbed], components: [milestoneButton], ephemeral: true });
    }

    // Low reports warning (free users)
    if (!serverIsPaid && remaining > 0 && remaining <= 2) {
      const reportWord = remaining === 1 ? 'report' : 'reports';
      await interaction.followUp({
        embeds: [new EmbedBuilder()
          .setColor(0xf59e0b)
          .setDescription(`⚠️ Only **${remaining}** free ${reportWord} left. [Get Pro](${CONFIG.STRIPE_MONTHLY_LINK}) for 30/month.`)
        ],
        ephemeral: true
      });
    }

    // Pro expiry warning (7 days or less)
    if (serverIsPaid) {
      const subStatus = await getSubscriptionStatus(serverId);
      if (subStatus.isActive && subStatus.daysLeft <= 7) {
        const dayWord = subStatus.daysLeft === 1 ? 'day' : 'days';
        const expiryEmbed = new EmbedBuilder()
          .setColor(0xf59e0b)
          .setTitle('⏰ Subscription Expiring Soon')
          .setDescription(
            `Your Pro subscription expires in **${subStatus.daysLeft} ${dayWord}**!\n\n` +
            `Renew to keep access to 30 reports/month, multi-channel analysis, and more.`
          );
        const renewButtons = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('🔄 Renew Monthly — $8.99').setStyle(ButtonStyle.Link).setURL(CONFIG.STRIPE_MONTHLY_LINK),
          ...(CONFIG.YEARLY_ENABLED ? [new ButtonBuilder().setLabel('💎 Renew Yearly — $99').setStyle(ButtonStyle.Link).setURL(CONFIG.STRIPE_YEARLY_LINK)] : [])
        );
        await interaction.followUp({ embeds: [expiryEmbed], components: [renewButtons], ephemeral: true });
      }
    }

  } catch (err) {
    console.error('Vibe error:', err);
    await interaction.editReply('❌ Something went wrong. Please try again in a moment.');
  }
}

// ============================================================
// /vibe-progress HANDLER
// ============================================================


// ── Get channel member stats ──────────────────────────────
async function getChannelStats(guild, channel, timeframeMs = 7 * 24 * 60 * 60 * 1000) {
  try {
    // Members with access to this channel
    const allMembers = await guild.members.fetch();
    const membersWithAccess = allMembers.filter(member =>
      channel.permissionsFor(member)?.has('ViewChannel') && !member.user.bot
    ).size;

    // Active members: sent at least 1 message in the timeframe
    const cutoff = Date.now() - timeframeMs;
    let messages = [];
    let lastId;
    const authorIds = new Set();

    while (true) {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;
      const fetched = await channel.messages.fetch(options);
      if (fetched.size === 0) break;
      fetched.forEach(m => {
        if (!m.author.bot && m.createdTimestamp > cutoff) authorIds.add(m.author.id);
      });
      if (fetched.last().createdTimestamp < cutoff) break;
      lastId = fetched.last().id;
      if (authorIds.size > 500) break; // safety cap
    }

    // Reaction stats — scan messages we already fetched
    const POSITIVE = ['👍','❤️','😂','🔥','✅','🎉','😊','💯','⭐','🙌'];
    const NEGATIVE = ['👎','😡','🤮','💀','😤','😒','🤦'];
    let mostReacted = null, mostPositive = null, mostNegative = null;
    let maxTotal = 0, maxPos = 0, maxNeg = 0;

    // Re-fetch recent messages for reactions (up to last 100)
    try {
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
        if (total > maxTotal) { maxTotal = total; mostReacted = { text: m.content.substring(0, 80), reactions: reactionStr }; }
        if (pos > maxPos)     { maxPos = pos;     mostPositive = { text: m.content.substring(0, 80), reactions: reactionStr }; }
        if (neg > maxNeg)     { maxNeg = neg;      mostNegative = { text: m.content.substring(0, 80), reactions: reactionStr }; }
      });
    } catch {}

    return {
      totalMembers: guild.memberCount,
      membersWithAccess,
      activeMembers: authorIds.size,
      mostReacted,
      mostPositive,
      mostNegative
    };
  } catch {
    return { totalMembers: guild.memberCount, membersWithAccess: null, activeMembers: null, mostReacted: null, mostPositive: null, mostNegative: null };
  }
}

async function handleProgressCommand(interaction, range, filterChannels) {
  const serverId = interaction.guildId;
  await interaction.deferReply({ ephemeral: true });

  try {
    // Build base query
    let query = supabase
      .from('reports')
      .select('*')
      .eq('server_id', serverId)
      .order('created_at', { ascending: false });

    if (range === '30d') {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      query = query.gte('created_at', since);
    } else {
      query = query.limit(parseInt(range) || 10);
    }

    const { data: reports, error } = await query;

    if (error || !reports || reports.length === 0) {
      return interaction.editReply('❌ No reports found. Run `/vibe` first to start tracking progress.');
    }

    const sorted = [...reports].reverse(); // oldest to newest

    // ── MULTI-CHANNEL COMPARISON MODE ──────────────────────────
    if (filterChannels && filterChannels.length > 1) {
      const channelNames = filterChannels.map(c => `#${c.name}`);

      // Get per-channel report data
      const channelData = {};
      for (const ch of filterChannels) {
        const chName = `#${ch.name}`;
        channelData[chName] = sorted.filter(r =>
          r.channel_name && r.channel_name.includes(chName)
        );
      }

      // Fetch member stats per channel
      const channelStats = {};
      for (const ch of filterChannels) {
        const chName = `#${ch.name}`;
        channelStats[chName] = await getChannelStats(interaction.guild, ch);
      }

      // Build per-channel summary
      const channelSummaries = channelNames.map(chName => {
        const chReports = channelData[chName];
        if (!chReports || chReports.length === 0) return null;

        const latest = chReports[chReports.length - 1];
        const oldest = chReports[0];
        const avg = (chReports.reduce((s, r) => s + r.score, 0) / chReports.length).toFixed(1);
        const diff = (latest.score - oldest.score).toFixed(1);
        const trend = diff > 0 ? `📈 +${diff}` : diff < 0 ? `📉 ${diff}` : '➡️ 0.0';

        // Toxicity for this channel
        const toxMap = {};
        chReports.forEach(r => {
          try {
            const types = typeof r.toxicity_types === 'string' ? JSON.parse(r.toxicity_types) : r.toxicity_types;
            if (types) Object.entries(types).forEach(([k, v]) => { toxMap[k] = (toxMap[k] || 0) + (v || 0); });
          } catch {}
        });
        const topTox = Object.entries(toxMap)
          .filter(([, v]) => v > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([k, v]) => `${k}(${v})`)
          .join(', ') || 'none';

        // Flagged trend
        const firstFlagged = oldest.flagged_count || 0;
        const lastFlagged = latest.flagged_count || 0;
        const flagDiff = lastFlagged - firstFlagged;
        const flagTrend = flagDiff < 0 ? `✅ ↓${Math.abs(flagDiff)}` : flagDiff > 0 ? `⚠️ ↑${flagDiff}` : '➡️ same';

        // Score bar for latest
        const bar = '█'.repeat(Math.round(latest.score)) + '░'.repeat(10 - Math.round(latest.score));
        const emoji = latest.score >= 7 ? '🟢' : latest.score >= 4 ? '🟡' : '🔴';

        const stats = channelStats[chName] || {};
        return {
          name: chName,
          reports: chReports.length,
          latest: latest.score,
          avg,
          trend,
          bar,
          emoji,
          flagTrend,
          topTox,
          diff: parseFloat(diff),
          totalMembers: stats.totalMembers || null,
          membersWithAccess: stats.membersWithAccess || null,
          activeMembers: stats.activeMembers || null,
          mostReacted: stats.mostReacted || null,
          mostPositive: stats.mostPositive || null,
          mostNegative: stats.mostNegative || null
        };
      }).filter(Boolean);

      if (channelSummaries.length === 0) {
        return interaction.editReply('❌ No report data found for the selected channels. Make sure you have run `/vibe` in those channels first.');
      }

      // Sort: worst first (needs most attention)
      const byScore = [...channelSummaries].sort((a, b) => a.latest - b.latest);
      const needsAttention = byScore[0];
      const healthiest = byScore[byScore.length - 1];
      const escalating = channelSummaries.filter(c => c.diff < -0.5).sort((a, b) => a.diff - b.diff);
      const improving = channelSummaries.filter(c => c.diff > 0.5).sort((a, b) => b.diff - a.diff);

      // Per-channel fields — Section 1: Descriptive
      const channelDescFields = channelSummaries.map(c => {
        const memberLine = c.membersWithAccess !== null
          ? `👥 Access: ${c.membersWithAccess} | 💬 Active (7d): ${c.activeMembers}`
          : `👥 Server members: ${c.totalMembers}`;
        return {
          name: `${c.emoji} ${c.name}`,
          value:
            `\`${c.bar}\` **${c.latest}/10**\n` +
            `Avg: ${c.avg} | Trend: ${c.trend}\n` +
            memberLine,
          inline: false
        };
      });

      // Per-channel fields — Section 2: Toxicity
      const channelToxFields = channelSummaries.map(c => ({
        name: `⚠️ ${c.name} — Toxicity`,
        value: `Flagged: ${c.flagTrend} | Types: ${c.topTox}`,
        inline: false
      }));

      // Per-channel fields — Section 3: Reactions
      const channelReactionFields = channelSummaries.map(c => {
        const lines = [];
        if (c.mostReacted)  lines.push(`⭐ **Most reacted:** "${c.mostReacted.text}" — ${c.mostReacted.reactions}`);
        if (c.mostPositive) lines.push(`👍 **Most positive:** "${c.mostPositive.text}" — ${c.mostPositive.reactions}`);
        if (c.mostNegative) lines.push(`👎 **Most negative:** "${c.mostNegative.text}" — ${c.mostNegative.reactions}`);
        return {
          name: `💬 ${c.name} — Top Comments`,
          value: lines.join('\n') || 'No reactions found.',
          inline: false
        };
      });

      // Insights
      const insights = [];
      if (needsAttention) insights.push(`🔴 **${needsAttention.name}** needs most attention — score ${needsAttention.latest}/10`);
      if (healthiest && healthiest.name !== needsAttention?.name) insights.push(`✅ **${healthiest.name}** is healthiest — score ${healthiest.latest}/10`);
      if (escalating.length > 0) insights.push(`⚠️ **Escalating toxicity:** ${escalating.map(c => c.name).join(', ')}`);
      if (improving.length > 0) insights.push(`📈 **Improving:** ${improving.map(c => c.name).join(', ')}`);

      // Toxicity comparison across channels
      const toxComparison = channelSummaries.map(c => `**${c.name}:** ${c.topTox}`).join('\n');

      const embed = new EmbedBuilder()
        .setColor(0xA78BFA)
        .setTitle(`📊 Channel Comparison — ${interaction.guild.name}`)
        .setDescription(`Comparing **${channelNames.join(', ')}**`)
        .addFields(
          // Section 1 — Descriptive
          ...channelDescFields,
          { name: '🔍 Key Insights', value: insights.join('\n') || 'Not enough data yet.', inline: false },
          // Section 2 — Toxicity
          ...channelToxFields,
          { name: '⚠️ Toxicity by Channel', value: toxComparison, inline: false },
          // Section 3 — Reactions
          ...channelReactionFields,
          // Vibe Check Bot Recommendations (always last)
          {
            name: '💡 Vibe Check Bot Recommendations',
            value: [
              needsAttention ? `🔴 Focus moderation efforts on **${needsAttention.name}** — lowest score at ${needsAttention.latest}/10.` : null,
              escalating.length > 0 ? `⚠️ **${escalating.map(c => c.name).join(', ')}** showing escalating toxicity — review recent flagged messages and consider a warning post.` : null,
              improving.length > 0 ? `📈 **${improving.map(c => c.name).join(', ')}** improving — keep current moderation approach there.` : null,
              `Run \`/vibe\` regularly in each channel to build up more comparison data.`
            ].filter(Boolean).join('\n'),
            inline: false
          }
        )
        .setFooter({ text: 'Vibe Check Bot • Run /vibe regularly to build up comparison data' });

      return interaction.editReply({ embeds: [embed] });
    }

    // ── SINGLE CHANNEL OR ALL CHANNELS MODE ────────────────────
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


    const latest = filteredReports[filteredReports.length - 1];
    const oldest = filteredReports[0];
    const avgScore = (filteredReports.reduce((sum, r) => sum + r.score, 0) / filteredReports.length).toFixed(1);
    const scoreDiff = (latest.score - oldest.score).toFixed(1);
    const trend = scoreDiff > 0 ? `📈 +${scoreDiff}` : scoreDiff < 0 ? `📉 ${scoreDiff}` : '➡️ 0.0';

    // Score graph — coloured bars per data point
    const graphLines = filteredReports.map(r => {
      const date = new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const bar = '█'.repeat(Math.round(r.score)) + '░'.repeat(10 - Math.round(r.score));
      return `\`${date.padEnd(8)}\` ${bar} **${r.score}**`;
    });

    // Sentiment evolution
    const firstFriendlyPct = Math.round((oldest.friendly / (oldest.friendly + oldest.neutral + oldest.unfriendly)) * 100);
    const lastFriendlyPct = Math.round((latest.friendly / (latest.friendly + latest.neutral + latest.unfriendly)) * 100);
    const firstUnfriendlyPct = Math.round((oldest.unfriendly / (oldest.friendly + oldest.neutral + oldest.unfriendly)) * 100);
    const lastUnfriendlyPct = Math.round((latest.unfriendly / (latest.friendly + latest.neutral + latest.unfriendly)) * 100);

    // Toxicity breakdown
    const toxMap = {};
    filteredReports.forEach(r => {
      try {
        const types = typeof r.toxicity_types === 'string' ? JSON.parse(r.toxicity_types) : r.toxicity_types;
        if (types) Object.entries(types).forEach(([k, v]) => { toxMap[k] = (toxMap[k] || 0) + (v || 0); });
      } catch {}
    });
    const topToxicities = Object.entries(toxMap)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, v]) => `• ${k}: ${v}`)
      .join('\n') || 'None detected';

    // Channel breakdown
    const channelCounts = {};
    filteredReports.forEach(r => {
      const ch = r.channel_name || 'unknown';
      channelCounts[ch] = (channelCounts[ch] || 0) + 1;
    });
    const channelBreakdown = Object.entries(channelCounts)
      .map(([ch, count]) => `• ${ch}: ${count} reports`)
      .join('\n');

    // Sensitivity breakdown
    const sensCounts = {};
    filteredReports.forEach(r => { sensCounts[r.sensitivity] = (sensCounts[r.sensitivity] || 0) + 1; });
    const sensBreakdown = Object.entries(sensCounts).map(([s, c]) => `${s}: ${c}`).join(' | ');

    // Flagged trend
    const firstFlagged = oldest.flagged_count || 0;
    const lastFlagged = latest.flagged_count || 0;
    const flaggedDiff = lastFlagged - firstFlagged;
    const flaggedTrend = flaggedDiff < 0 ? `✅ ↓${Math.abs(flaggedDiff)} fewer` : flaggedDiff > 0 ? `⚠️ ↑${flaggedDiff} more` : '➡️ Same';

    const embed = new EmbedBuilder()
      .setColor(0xA78BFA)
      .setTitle(`📈 Progress Report — ${interaction.guild.name}`)
      .setDescription(`**${filteredReports.length} reports analyzed**${filterLabel}`)
      .addFields(
        { name: '📊 Score History (oldest → newest)', value: graphLines.slice(-10).join('\n') || 'No data', inline: false },
        {
          name: '🎯 Overall Trend',
          value: `First: **${oldest.score}/10** → Latest: **${latest.score}/10**\nAverage: **${avgScore}/10** | Change: **${trend}**`,
          inline: false
        },
        {
          name: '💬 Sentiment Evolution',
          value:
            `🟢 Friendly: ${firstFriendlyPct}% → ${lastFriendlyPct}% (${lastFriendlyPct > firstFriendlyPct ? '+' : ''}${lastFriendlyPct - firstFriendlyPct}%)\n` +
            `🔴 Unfriendly: ${firstUnfriendlyPct}% → ${lastUnfriendlyPct}% (${lastUnfriendlyPct > firstUnfriendlyPct ? '+' : ''}${lastUnfriendlyPct - firstUnfriendlyPct}%)`,
          inline: false
        },
        { name: '🚩 Flagged Messages', value: `First: ${firstFlagged} | Latest: ${lastFlagged} | ${flaggedTrend}`, inline: false },
        { name: '⚠️ Top Toxicity Types', value: topToxicities, inline: true },
        { name: '📺 Channels Analyzed', value: channelBreakdown || 'N/A', inline: true },
        { name: '⚙️ Sensitivity Used', value: sensBreakdown || 'N/A', inline: false }
      );



    // Vibe Check Bot Recommendations based on trend data (always last)
    const progressRec = [];
    if (parseFloat(scoreDiff) < -0.5) progressRec.push(`📉 Your score has dropped ${Math.abs(scoreDiff)} points. Review flagged messages and consider a community reminder about server rules.`);
    else if (parseFloat(scoreDiff) > 0.5) progressRec.push(`📈 Great progress! Your score improved by ${scoreDiff} points. Keep up current moderation efforts.`);
    else progressRec.push(`➡️ Your community score is stable. Consider running a targeted analysis on specific channels to identify improvement areas.`);
    if (lastFlagged > firstFlagged) progressRec.push(`⚠️ Flagged messages increased from ${firstFlagged} to ${lastFlagged}. Consider reviewing your sensitivity settings or increasing moderation.`);
    if (lastUnfriendlyPct > firstUnfriendlyPct) progressRec.push(`🔴 Unfriendly messages rose from ${firstUnfriendlyPct}% to ${lastUnfriendlyPct}%. A pinned reminder of community guidelines may help.`);

    embed.addFields({
      name: '💡 Vibe Check Bot Recommendations',
      value: progressRec.join('\n'),
      inline: false
    });

    embed.setFooter({ text: 'Vibe Check Bot • Keep running /vibe to track your progress!' });

    await interaction.editReply({ embeds: [embed] });

    // Email owner with progress summary
    const allChannelNames = filteredReports.map(r => r.channel_name).filter((v, i, a) => a.indexOf(v) === i);
    await sendProgressReportEmail(
      interaction.guild.name, interaction.guildId,
      allChannelNames, filteredReports, interaction.user.tag
    );

  } catch (err) {
    console.error('Progress error:', err);
    await interaction.editReply('❌ Something went wrong loading your progress report.');
  }
}


// ============================================================
// /vibe-admin HANDLER
// ============================================================

async function handleAdminCommand(interaction) {
  // Owner only
  if (interaction.user.id !== CONFIG.OWNER_ID) {
    return interaction.reply({ content: '❌ This command is for the bot owner only.', ephemeral: true });
  }

  const action = interaction.options.getString('action');
  const serverId = interaction.options.getString('server_id');
  const extraReports = interaction.options.getInteger('reports') || 5;

  // Validate server ID format (Discord snowflake: 17-19 digits)
  if (!/^\d{17,19}$/.test(serverId)) {
    return interaction.reply({ content: '❌ Invalid server ID. Must be a 17-19 digit number.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  console.log(`🔧 ADMIN: ${action} on server ${serverId} by ${interaction.user.tag}`);

  try {
    // ── TEST: add extra free reports ──
    if (action === 'test') {
      const { data } = await supabase.from('usage').select('reports_used').eq('server_id', serverId).single();
      const current = data?.reports_used || 0;
      // Store extra allowance as negative offset in a separate field
      if (data) {
        await supabase.from('usage').update({ free_bonus: (data.free_bonus || 0) + extraReports }).eq('server_id', serverId);
      } else {
        await supabase.from('usage').insert({ server_id: serverId, reports_used: 0, free_bonus: extraReports, month_start: new Date().toISOString() });
      }
      return interaction.editReply(
        `🧪 **Test mode activated**
` +
        `Server: \`${serverId}\`
` +
        `Added **${extraReports}** extra free reports on top of their current allowance.`
      );
    }

    // ── PRO: activate Pro ──
    if (action === 'pro') {
      const expires = new Date();
      expires.setDate(expires.getDate() + 30);
      await supabase.from('paid_servers').upsert({
        server_id: serverId,
        activated_at: new Date().toISOString(),
        expires_at: expires.toISOString()
      });
      return interaction.editReply(
        `⚡ **Pro activated**
` +
        `Server: \`${serverId}\`
` +
        `Expires: **${expires.toDateString()}** (30 days)`
      );
    }

    // ── PRO OFF: deactivate Pro ──
    if (action === 'pro_off') {
      await supabase.from('paid_servers').delete().eq('server_id', serverId);
      return interaction.editReply(
        `🔴 **Pro deactivated**
` +
        `Server: \`${serverId}\`
` +
        `They are now on the Free tier.`
      );
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
