const http = require('http');

// ============================================================
// VIBE CHECK BOT v2.1
// ============================================================
//
// Features:
// - /vibe command --- analyze 1 to 5 channels in one report
// - /vibe-progress --- track community health over time (with graphs)
// - OpenAI GPT-4o-mini analysis
// - Sensitivity levels: Low / Medium / High
// - Visibility: Private (DM) / Public
// - Custom timeframes and message counts (any number 1–1000)
// - Supabase report storage
// - Email reports via Resend
// - Stripe paywall (5 free reports, then Pro)
// - Tester system --- owner-approved unlimited access
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
  ChannelType
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
  STRIPE_MONTHLY_LINK: 'https://buy.stripe.com/fZu28k00n5s92Oqf4z4ow01',
  STRIPE_YEARLY_LINK: 'https://buy.stripe.com/bJebIUbJ56wd4Wye0v4ow03',
  CONTACT_EMAIL: 'play@felixagaming.com',
  REPORT_EMAIL: 'play@felixagaming.com',
  OWNER_ID: '1185219817913991220',
  YEARLY_ENABLED: true,
  COOLDOWN_SECONDS: 15,
  SERVER_THROTTLE_PER_MINUTE: 10,
  COST_PER_1M_INPUT_TOKENS: 0.15,
  COST_PER_1M_OUTPUT_TOKENS: 0.60
};

// ============================================================
// SENSITIVITY PROMPTS
// ============================================================

const SENSITIVITY_PROMPTS = {
  low: `SENSITIVITY: LOW (Adult/Gaming communities - CoD, GTA, etc.)
- Casual trash talk and banter is NORMAL --- mark as neutral, NOT unfriendly
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
- Very strict --- when in doubt, mark as unfriendly`
};

// ============================================================
// STARTUP VALIDATION
// ============================================================

function validateEnvironment() {
  const required = ['DISCORD_TOKEN', 'CLIENT_ID', 'OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_KEY', 'RESEND_API_KEY'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    console.error('❌ FATAL: Missing required environment variables:');
    missing.forEach(key => console.error(` - ${key}`));
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
const trialEndedNotified = new Set(); // prevents spamming trial-ended email on every retry

// ── SINGLE STATUS RESOLVER ────────────────────────────────────────────────────
// Fetches everything in 3 parallel queries instead of 16 sequential ones.
// Also handles Pro monthly reset: if month_start > 30 days ago, resets reports_used.
async function getServerStatus(serverId) {
  try {
    const [testerRes, paidRes, usageRes] = await Promise.all([
      supabase.from('testers').select('expires_at').eq('server_id', serverId).single(),
      supabase.from('paid_servers').select('expires_at').eq('server_id', serverId).single(),
      supabase.from('usage').select('*').eq('server_id', serverId).single()
    ]);

    const now = new Date();

    // Tester check
    const testerData = testerRes.data;
    const isTester = !!(testerData && new Date(testerData.expires_at) > now);

    // Paid check
    const paidData = paidRes.data;
    const isPaid = !!(paidData && (!paidData.expires_at || new Date(paidData.expires_at) > now));

    // Subscription days left
    let subDaysLeft = 0;
    if (paidData?.expires_at) {
      subDaysLeft = Math.max(0, Math.ceil((new Date(paidData.expires_at).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
    }

    // Usage + monthly reset for Pro
    let usageData = usageRes.data;
    let reportsUsed = usageData?.reports_used || 0;
    const freeBonus = usageData?.free_bonus || 0;
    const monthStart = usageData?.month_start ? new Date(usageData.month_start) : null;

    if (isPaid && usageData) {
      if (!monthStart) {
        // No month_start (old row or manual insert) — set it now so reset cycle begins
        await supabase.from('usage').update({ reports_used: 0, month_start: now.toISOString() }).eq('server_id', serverId);
        reportsUsed = 0;
        console.log(`🔄 Initialized month_start for Pro server ${serverId}`);
      } else {
        const daysSinceReset = (now.getTime() - monthStart.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceReset >= 30) {
          reportsUsed = 0;
          await supabase.from('usage').update({ reports_used: 0, month_start: now.toISOString() }).eq('server_id', serverId);
          console.log(`🔄 Monthly reset for server ${serverId}`);
        }
      }
    }

    // Compute remaining + canUse
    let remaining, canUse;
    if (isTester) {
      remaining = 999;
      canUse = true;
    } else if (isPaid) {
      remaining = CONFIG.PRO_REPORTS_PER_MONTH - reportsUsed;
      canUse = reportsUsed < CONFIG.PRO_REPORTS_PER_MONTH;
    } else {
      remaining = (CONFIG.FREE_REPORTS + freeBonus) - reportsUsed;
      canUse = reportsUsed < (CONFIG.FREE_REPORTS + freeBonus);
    }

    return { isTester, isPaid, reportsUsed, freeBonus, remaining, canUse, subDaysLeft, usageExists: !!usageData, monthStart: monthStart?.getTime() || Date.now() };
  } catch (err) {
    console.error('getServerStatus error:', err.message);
    // Safe fallback
    return { isTester: false, isPaid: false, reportsUsed: 0, freeBonus: 0, remaining: CONFIG.FREE_REPORTS, canUse: true, subDaysLeft: 0, usageExists: false, monthStart: Date.now() };
  }
}

async function incrementUsage(serverId, status) {
  if (status.isTester) return;
  try {
    if (status.usageExists) {
      await supabase.from('usage').update({ reports_used: status.reportsUsed + 1 }).eq('server_id', serverId);
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
  const maxPages = Math.ceil(messageCount / 100) + 5; // cap: expected pages + 5 buffer for bot-heavy channels
  let allMessages = [];
  let lastId;
  let pages = 0;
  while (allMessages.length < messageCount && pages < maxPages) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;
    const fetched = await channel.messages.fetch(options);
    if (fetched.size === 0) break;
    pages++;
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
// FAST CHANNEL STATS
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
      if (pos > maxPos) { maxPos = pos; mostPositive = { text: m.content.substring(0, 80), reactions: reactionStr || `${pos} positive` }; }
      if (neg > maxNeg) { maxNeg = neg; mostNegative = { text: m.content.substring(0, 80), reactions: reactionStr || `${neg} negative` }; }
    });
    return { totalMembers: guild.memberCount, membersWithAccess: null, activeMembers: null, mostReacted, mostPositive, mostNegative };
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
- Flag unfriendly messages — include up to 20 of the most severe ones
- Understand messages in ANY language --- translate mentally before judging
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
        max_tokens: 4000
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

  let rawContent = response.choices[0].message.content.trim();
  // Strip markdown code fences GPT sometimes wraps around JSON
  rawContent = rawContent.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  let result;
  try {
    result = JSON.parse(rawContent);
  } catch (parseErr) {
    console.error('⚠️ GPT returned invalid JSON:', rawContent.substring(0, 200));
    throw new Error('GPT returned malformed JSON. Please try again.');
  }
  result.friendlinessScore = clamp(result.friendlinessScore, 0, 10);

  const sentimentTotal = result.sentiment.friendly + result.sentiment.neutral + result.sentiment.unfriendly;
  if (sentimentTotal === 0) {
    // GPT returned all zeros — distribute evenly rather than divide by zero
    result.sentiment.neutral = analyzedCount;
  } else if (sentimentTotal !== analyzedCount) {
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
  const filled = Math.min(10, Math.max(0, Math.round(Number(score) || 0)));
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
// QUICKCHART GRAPH GENERATORS
// ============================================================

// Chart 1: Score + Flagged trend (dual-axis line chart)
function generateScoreTrendChart(reports) {
  if (!reports || reports.length < 2) return null;
  const chron = [...reports].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const labels = chron.map(r => new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  const scores  = chron.map(r => clamp(parseFloat(r.score) || 0, 0, 10));
  const flagged = chron.map(r => Math.max(0, r.flagged_count || 0));

  const config = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Health Score',
          data: scores,
          borderColor: '#22c55e',
          backgroundColor: 'rgba(34,197,94,0.15)',
          fill: true,
          tension: 0.4,
          pointBackgroundColor: scores.map(s => s >= 7 ? '#22c55e' : s >= 4 ? '#f59e0b' : '#ef4444'),
          pointRadius: 5,
          yAxisID: 'y'
        },
        {
          label: 'Flagged Messages',
          data: flagged,
          borderColor: '#ef4444',
          backgroundColor: 'rgba(239,68,68,0.1)',
          fill: false,
          tension: 0.4,
          borderDash: [5, 3],
          pointBackgroundColor: '#ef4444',
          pointRadius: 4,
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      plugins: {
        title: { display: true, text: 'Community Health Trend', font: { size: 16, weight: 'bold' }, color: '#111827' },
        legend: { position: 'bottom', labels: { color: '#374151', font: { size: 12 } } }
      },
      scales: {
        y:  { type: 'linear', position: 'left',  min: 0, max: 10, title: { display: true, text: 'Score /10', color: '#22c55e' }, grid: { color: 'rgba(0,0,0,0.06)' } },
        y1: { type: 'linear', position: 'right', min: 0, title: { display: true, text: 'Flagged',   color: '#ef4444' }, grid: { drawOnChartArea: false } }
      }
    }
  };
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}&w=700&h=320&bkg=%23ffffff&version=3`;
}

// Chart 2: Friendly vs Unfriendly sentiment over time (stacked area)
function generateSentimentTrendChart(reports) {
  if (!reports || reports.length < 2) return null;
  const chron = [...reports].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const labels     = chron.map(r => new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  const friendly   = chron.map(r => { const t = (r.friendly||0)+(r.neutral||0)+(r.unfriendly||0); return t > 0 ? Math.round((r.friendly||0)/t*100) : 0; });
  const neutral    = chron.map(r => { const t = (r.friendly||0)+(r.neutral||0)+(r.unfriendly||0); return t > 0 ? Math.round((r.neutral||0)/t*100) : 0; });
  const unfriendly = chron.map(r => { const t = (r.friendly||0)+(r.neutral||0)+(r.unfriendly||0); return t > 0 ? Math.round((r.unfriendly||0)/t*100) : 0; });

  const config = {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Friendly %',   data: friendly,   borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.15)',  fill: false, tension: 0.4, pointBackgroundColor: '#22c55e', pointRadius: 4 },
        { label: 'Neutral %',    data: neutral,    borderColor: '#9ca3af', backgroundColor: 'rgba(156,163,175,0.1)', fill: false, tension: 0.4, pointBackgroundColor: '#9ca3af', pointRadius: 4 },
        { label: 'Unfriendly %', data: unfriendly, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.15)',  fill: false, tension: 0.4, pointBackgroundColor: '#ef4444', pointRadius: 4 }
      ]
    },
    options: {
      plugins: {
        title: { display: true, text: 'Sentiment Evolution', font: { size: 16, weight: 'bold' }, color: '#111827' },
        legend: { position: 'bottom', labels: { color: '#374151', font: { size: 12 } } }
      },
      scales: {
        y: { min: 0, max: 100, title: { display: true, text: 'Percentage %', color: '#374151' }, grid: { color: 'rgba(0,0,0,0.06)' } }
      }
    }
  };
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}&w=700&h=300&bkg=%23ffffff&version=3`;
}

// Chart 3: Cumulative toxicity types — doughnut
function generateToxicityDoughnut(toxMap) {
  if (!toxMap || Object.keys(toxMap).length === 0) return null;
  const sorted = Object.entries(toxMap).filter(([,v]) => v > 0).sort((a,b) => b[1]-a[1]).slice(0, 7);
  if (sorted.length === 0) return null;
  const labels = sorted.map(([k]) => k);
  const data   = sorted.map(([,v]) => v);
  const colors = ['#ef4444','#f97316','#f59e0b','#eab308','#84cc16','#22c55e','#3b82f6'];

  const config = {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors.slice(0, data.length), borderWidth: 2, borderColor: '#ffffff' }]
    },
    options: {
      plugins: {
        title: { display: true, text: 'Cumulative Toxicity Breakdown', font: { size: 16, weight: 'bold' }, color: '#111827' },
        legend: { position: 'right', labels: { color: '#374151', font: { size: 12 } } }
      }
    }
  };
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}&w=500&h=280&bkg=%23ffffff&version=3`;
}

// Chart 4: Per-channel health ranking — horizontal bar
function generateChannelRankingChart(channelStats) {
  // channelStats: { '#general': { latestScore, reportCount }, ... }
  if (!channelStats || Object.keys(channelStats).length < 2) return null;
  const sorted = Object.entries(channelStats)
    .sort((a,b) => b[1].latestScore - a[1].latestScore)
    .slice(0, 8);
  const labels = sorted.map(([ch]) => ch);
  const scores = sorted.map(([,s]) => s.latestScore);
  const colors = scores.map(s => s >= 7 ? '#22c55e' : s >= 4 ? '#f59e0b' : '#ef4444');

  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: 'Latest Score', data: scores, backgroundColor: colors, borderRadius: 5 }]
    },
    options: {
      indexAxis: 'y',
      plugins: {
        title: { display: true, text: 'Channel Health Ranking', font: { size: 16, weight: 'bold' }, color: '#111827' },
        legend: { display: false }
      },
      scales: {
        x: { min: 0, max: 10, title: { display: true, text: 'Score /10', color: '#374151' }, grid: { color: 'rgba(0,0,0,0.06)' } },
        y: { grid: { display: false }, ticks: { color: '#374151', font: { size: 12 } } }
      }
    }
  };
  const height = 60 + sorted.length * 36;
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}&w=600&h=${height}&bkg=%23ffffff&version=3`;
}

// Chart 5: Toxicity type evolution — stacked bar over time
function generateToxicityEvolutionChart(reports) {
  if (!reports || reports.length < 2) return null;
  const chron = [...reports].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const labels = chron.map(r => new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));

  // Collect all tox types and rank by total count across all reports
  const typeTotals = {};
  chron.forEach(r => {
    try {
      const t = typeof r.toxicity_types === 'string' ? JSON.parse(r.toxicity_types) : r.toxicity_types;
      if (t) Object.entries(t).forEach(([k, v]) => { typeTotals[k] = (typeTotals[k] || 0) + (v || 0); });
    } catch {}
  });
  const types = Object.entries(typeTotals)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k]) => k);
  if (types.length === 0) return null;

  const palette = ['#ef4444','#f97316','#f59e0b','#3b82f6','#8b5cf6'];
  const datasets = types.map((type, i) => ({
    label: type,
    data: chron.map(r => {
      try {
        const t = typeof r.toxicity_types === 'string' ? JSON.parse(r.toxicity_types) : r.toxicity_types;
        return t?.[type] || 0;
      } catch { return 0; }
    }),
    backgroundColor: palette[i],
    borderRadius: 3
  }));

  const config = {
    type: 'bar',
    data: { labels, datasets },
    options: {
      plugins: {
        title: { display: true, text: 'Toxicity Type Evolution', font: { size: 16, weight: 'bold' }, color: '#111827' },
        legend: { position: 'bottom', labels: { color: '#374151', font: { size: 11 } } }
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: '#374151' } },
        y: { stacked: true, title: { display: true, text: 'Count', color: '#374151' }, grid: { color: 'rgba(0,0,0,0.06)' } }
      }
    }
  };
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}&w=700&h=300&bkg=%23ffffff&version=3`;
}

// Simple linear regression prediction
function predictNextScore(reports) {
  if (!reports || reports.length < 3) return null;
  const chron = [...reports].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const n = chron.length;
  const xs = chron.map((_, i) => i);
  const ys = chron.map(r => parseFloat(r.score) || 0);
  const xMean = xs.reduce((s,x) => s+x, 0) / n;
  const yMean = ys.reduce((s,y) => s+y, 0) / n;
  const slope = xs.reduce((s,x,i) => s + (x-xMean)*(ys[i]-yMean), 0) / xs.reduce((s,x) => s + (x-xMean)**2, 0);
  const intercept = yMean - slope * xMean;
  const predicted = clamp(parseFloat((slope * n + intercept).toFixed(1)), 0, 10);
  const direction = slope > 0.05 ? '📈 improving' : slope < -0.05 ? '📉 declining' : '➡️ stable';
  return { predicted, slope: parseFloat(slope.toFixed(3)), direction };
}

// ============================================================
// BUILD DISCORD EMBED REPORT
// ============================================================

// Helper: build a compact toxicity bar string for a result
function buildToxBars(toxicityTypes, maxBars = 8) {
  if (!toxicityTypes) return null;
  const entries = Object.entries(toxicityTypes).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  const maxVal = entries[0][1] || 1;
  return entries.map(([k, v]) => {
    const filled = Math.round((v / maxVal) * maxBars);
    return `\`${'█'.repeat(filled)}${'░'.repeat(maxBars - filled)}\` **${k}** ${v}`;
  }).join('\n');
}

// Helper: build a compact sentiment bar row
function sentimentRow(label, emoji, count, total) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  const filled = Math.round(pct / 10);
  return `${emoji} ${label.padEnd(10)} \`${String(count).padStart(4)}\` ${String(pct).padStart(3)}% ${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
}

// Helper: format reaction highlights for one channel
function formatReactions(reactions) {
  if (!reactions) return null;
  const lines = [];
  if (reactions.mostReacted)  lines.push(`⭐ **Top reacted:** "${sanitizeForEmbed(reactions.mostReacted.text).substring(0, 60)}" — ${reactions.mostReacted.reactions}`);
  if (reactions.mostPositive) lines.push(`👍 **Most positive:** "${sanitizeForEmbed(reactions.mostPositive.text).substring(0, 60)}" — ${reactions.mostPositive.reactions}`);
  if (reactions.mostNegative) lines.push(`👎 **Most negative:** "${sanitizeForEmbed(reactions.mostNegative.text).substring(0, 60)}" — ${reactions.mostNegative.reactions}`);
  return lines.length > 0 ? lines.join('\n') : null;
}

function buildReportEmbed(result, analyzedCount, channelNames, timeframeLabel, sensitivity, remaining, isPaidServer, channelReactions = {}, stats = null, isPublic = false, channelMsgCounts = {}, channelResults = {}, isTesterAccount = false) {
  const score = result.friendlinessScore;
  const bar = buildScoreBar(score);
  const isMulti = channelNames.length > 1;
  const sensitivityLabel = sensitivity.charAt(0).toUpperCase() + sensitivity.slice(1);
  const communityDesc = score >= 8 ? 'Your community is thriving and welcoming! 🎉'
    : score >= 6 ? 'Your community is generally positive. 👍'
    : score >= 4 ? 'Your community has a mixed atmosphere. ⚠️'
    : 'Your community needs immediate attention. 🚨';

  const embed = new EmbedBuilder()
    .setColor(scoreColor(score))
    .setTitle(isMulti ? '📊 Multi-Channel Vibe Report' : '📊 Community Vibe Report')
    .setDescription(
      `**${isMulti ? `${channelNames.length} channels` : channelNames[0]}** • Last ${timeframeLabel} • **${analyzedCount}** messages • Sensitivity: **${sensitivityLabel}**\n\n` +
      `${scoreEmoji(score)} **Overall Score: ${score}/10 — ${scoreLabel(score)}**\n` +
      `\`${bar}\`\n` +
      `*${communityDesc}*`
    );

  // ── SERVER MEMBERS ────────────────────────────────────────────
  if (stats?.totalMembers) {
    embed.addFields({ name: '📋 Channel Info', value: `👥 Server members: **${stats.totalMembers.toLocaleString()}**`, inline: false });
  }

  // ── CHANNEL SCOREBOARD (multi only) ──────────────────────────
  if (isMulti) {
    const validChs = channelNames.filter(ch => channelResults[ch]);
    const sortedChs = [...validChs].sort((a, b) =>
      channelResults[b].result.friendlinessScore - channelResults[a].result.friendlinessScore
    );

    // Scoreboard table
    const tableLines = ['```'];
    tableLines.push('Channel        Score  Msgs   Health');
    tableLines.push('─'.repeat(37));
    sortedChs.forEach(ch => {
      const res = channelResults[ch];
      const chScore = res.result.friendlinessScore;
      const chBar = '█'.repeat(Math.round(chScore)) + '░'.repeat(10 - Math.round(chScore));
      const chEmoji = chScore >= 7 ? '✓' : chScore >= 4 ? '~' : '✗';
      const chName = ch.padEnd(14).substring(0, 14);
      const msgCount = String(channelMsgCounts[ch] || 0).padStart(4);
      tableLines.push(`${chName} ${String(chScore).padStart(5)}  ${msgCount}   ${chBar} ${chEmoji}`);
    });
    tableLines.push('─'.repeat(37));
    const overallBar = '█'.repeat(Math.round(score)) + '░'.repeat(10 - Math.round(score));
    tableLines.push(`${'OVERALL'.padEnd(14)} ${String(score).padStart(5)}  ${String(analyzedCount).padStart(4)}   ${overallBar} ★`);
    tableLines.push('```');
    embed.addFields({ name: '🏆 Channel Scoreboard', value: tableLines.join('\n'), inline: false });
  }

  // ── OVERALL SENTIMENT ─────────────────────────────────────────
  const { friendly, neutral, unfriendly } = result.sentiment;
  const sentTotal = friendly + neutral + unfriendly || 1;
  embed.addFields({
    name: '💬 Overall Sentiment',
    value:
      sentimentRow('Friendly', '🟢', friendly, sentTotal) + '\n' +
      sentimentRow('Neutral', '⚪', neutral, sentTotal) + '\n' +
      sentimentRow('Unfriendly', '🔴', unfriendly, sentTotal),
    inline: false
  });

  // ── PER-CHANNEL SENTIMENT COMPARISON (multi only) ────────────
  if (isMulti) {
    const validChs = channelNames.filter(ch => channelResults[ch]);
    const sentLines = validChs.map(ch => {
      const res = channelResults[ch];
      const chSent = res.result.sentiment;
      const chTotal = chSent.friendly + chSent.neutral + chSent.unfriendly || 1;
      const fPct = Math.round((chSent.friendly / chTotal) * 100);
      const uPct = Math.round((chSent.unfriendly / chTotal) * 100);
      const fBar = '█'.repeat(Math.round(fPct / 10)) + '░'.repeat(10 - Math.round(fPct / 10));
      const chEmoji = res.result.friendlinessScore >= 7 ? '🟢' : res.result.friendlinessScore >= 4 ? '🟡' : '🔴';
      return `${chEmoji} **${ch}**\n` +
             `  🟢 \`${fBar}\` ${fPct}% friendly   🔴 ${uPct}% unfriendly`;
    });
    embed.addFields({ name: '📊 Sentiment by Channel', value: sentLines.join('\n'), inline: false });
  }

  // ── OVERALL TOXICITY ──────────────────────────────────────────
  const totalFlagged = result.flaggedMessages?.length || 0;
  const overallToxBars = buildToxBars(result.toxicityTypes);

  if (isPublic) {
    // Public: show only counts, no message text
    if (totalFlagged > 0) {
      embed.addFields({
        name: `⚠️ Overall Toxicity — ${totalFlagged} flagged`,
        value: overallToxBars || 'No type breakdown available.',
        inline: false
      });
    } else {
      embed.addFields({ name: '✅ No Toxic Content Detected', value: 'All messages passed analysis.', inline: false });
    }
  } else {
    // Private: full toxicity bars + flagged messages
    if (overallToxBars) {
      embed.addFields({ name: `🧪 Overall Toxicity — ${totalFlagged} flagged`, value: overallToxBars, inline: false });
    } else {
      embed.addFields({ name: '✅ No Toxic Content Detected', value: 'All messages passed analysis.', inline: false });
    }

    if (totalFlagged > 0) {
      const topFlagged = [...(result.flaggedMessages || [])]
        .sort((a, b) => b.severity - a.severity)
        .slice(0, isMulti ? 5 : 10)
        .map(f => `• [\`${f.type}\` **${f.severity}/10**] ${sanitizeForEmbed((f.message || '').substring(0, 75))}${(f.message || '').length > 75 ? '…' : ''}`)
        .filter(line => line.trim().length > 0)
        .join('\n');
      const flaggedValue = (topFlagged + (totalFlagged > (isMulti ? 5 : 10) ? `\n_…and ${totalFlagged - (isMulti ? 5 : 10)} more in the email report_` : '')).substring(0, 1024);
      if (flaggedValue.trim().length > 0) {
        embed.addFields({
          name: `🚨 Most Severe Flagged Messages`,
          value: flaggedValue,
          inline: false
        });
      }
    }
  }

  // ── OVERALL REACTIONS (single channel) ────────────────────────
  if (!isMulti) {
    const singleReactions = channelReactions[channelNames[0]];
    const reactionText = formatReactions(singleReactions);
    if (reactionText && !isPublic) {
      embed.addFields({ name: '💬 Most Reacted Messages', value: reactionText, inline: false });
    }
  }

  // ── PER-CHANNEL DEEP DIVE (multi only) ───────────────────────
  if (isMulti && !isPublic) {
    const validChs = channelNames.filter(ch => channelResults[ch]);
    const worstFirst = [...validChs].sort((a, b) =>
      channelResults[a].result.friendlinessScore - channelResults[b].result.friendlinessScore
    );

    for (const ch of worstFirst) {
      const res = channelResults[ch];
      const chScore = res.result.friendlinessScore;
      const chBar = buildScoreBar(chScore);
      const chEmoji = scoreEmoji(chScore);
      const chFlagged = res.result.flaggedMessages || [];
      const chMsgCount = channelMsgCounts[ch] || 0;

      let chValue = `${chEmoji} **${chScore}/10** \`${chBar}\` — ${scoreLabel(chScore)} | **${chMsgCount}** msgs analyzed\n`;

      // Toxicity bars for this channel
      const chToxBars = buildToxBars(res.result.toxicityTypes, 6);
      if (chToxBars) {
        chValue += `\n🧪 **Toxicity** (${chFlagged.length} flagged)\n${chToxBars}\n`;
      } else {
        chValue += `\n✅ No toxicity detected\n`;
      }

      // Top 2 flagged messages for this channel
      if (chFlagged.length > 0) {
        const top2 = [...chFlagged].sort((a, b) => b.severity - a.severity).slice(0, 2);
        chValue += `\n🚨 **Worst flagged:**\n`;
        top2.forEach(f => {
          chValue += `• [\`${f.type}\` ${f.severity}/10] ${sanitizeForEmbed((f.message || '').substring(0, 65))}${(f.message || '').length > 65 ? '…' : ''}\n`;
        });
      }

      // Reactions for this channel
      const chReactions = channelReactions[ch];
      const reactionText = formatReactions(chReactions);
      if (reactionText) {
        chValue += `\n💬 **Reactions**\n${reactionText}`;
      }

      embed.addFields({
        name: `🔍 ${ch}`,
        value: chValue.substring(0, 1024),
        inline: false
      });
    }
  }

  // ── PUBLIC MULTI-CHANNEL REACTIONS SUMMARY ────────────────────
  if (isMulti && isPublic) {
    const reactionSummary = channelNames
      .filter(ch => channelReactions[ch])
      .map(ch => {
        const r = channelReactions[ch];
        const lines = [];
        if (r.mostReacted) lines.push(`⭐ "${sanitizeForEmbed(r.mostReacted.text).substring(0, 45)}" — ${r.mostReacted.reactions}`);
        return lines.length > 0 ? `**${ch}**\n${lines.join('\n')}` : null;
      })
      .filter(Boolean);
    if (reactionSummary.length > 0) {
      embed.addFields({ name: '💬 Top Reacted Messages by Channel', value: reactionSummary.join('\n\n').substring(0, 1024), inline: false });
    }
  }

  // ── SUMMARY + RECOMMENDATION ──────────────────────────────────
  if (result.summary) {
    embed.addFields({ name: '🗒️ Vibe Insights', value: result.summary.substring(0, 1024), inline: false });
  }
  if (result.recommendation) {
    embed.addFields({ name: '💡 AI Recommendations', value: result.recommendation.substring(0, 1024), inline: false });
  }

  embed.addFields({
    name: '🔧 Need Help?',
    value: `Request research-based strategies to improve your community.\n📧 **${CONFIG.CONTACT_EMAIL}**`,
    inline: false
  });

  const planType = isTesterAccount ? '🧪 Tester' : isPaidServer ? '⚡ Pro' : '🎁 Free Trial';
  const footerRemaining = isTesterAccount ? 'Unlimited' : `${remaining} ${remaining === 1 ? 'report' : 'reports'} remaining`;
  embed.setFooter({ text: `Vibe Check Bot • ${planType} • ${footerRemaining} • Sensitivity: ${sensitivityLabel}` });

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
        server_name: data.serverName,
        server_id: data.serverId,
        member_count: data.memberCount,
        channel_name: channelName,
        messages_analyzed: chMsgs,
        score: chScore,
        friendly: chSentiment.friendly,
        neutral: chSentiment.neutral,
        unfriendly: chSentiment.unfriendly,
        flagged_count: chFlagged,
        toxicity_types: chToxTypes,
        sensitivity: data.sensitivity,
        timeframe: data.timeframe,
        is_pro: data.isPro,
        input_tokens: data.inputTokens,
        output_tokens: data.outputTokens,
        cost_usd: data.cost,
        processing_time_ms: data.processingTime
      };
    });
    const { error } = await supabase.from('research_logs').insert(rows);
    if (error) console.error('Research log error:', error.message);
    else console.log(`📊 Research logged: ${rows.length} channel(s), score ${data.score}, $${data.cost?.toFixed(6)}`);
  } catch (err) { console.error('Research logging failed:', err.message); }
}

// ============================================================
// ============================================================
// EMAIL REPORTS
// ============================================================

// Prevent @everyone / @here / user/role mentions from pinging when shown in Discord embeds
function sanitizeForEmbed(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/@(everyone|here)/gi, '@\u200b$1')   // zero-width space breaks the ping
    .replace(/<@[!&]?\d+>/g, '[mention]')          // strip <@123> / <@&123> user/role mentions
    .replace(/<#\d+>/g, '[channel]');              // strip <#123> channel mentions
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function sendEmailReport(serverName, serverId, channelNames, result, analyzedCount, timeframe, sensitivity, remaining) {
  try {
    const flaggedHtml = result.flaggedMessages && result.flaggedMessages.length > 0
      ? result.flaggedMessages.sort((a, b) => b.severity - a.severity).map(f => `<li><strong>[${escHtml(f.type)} - ${escHtml(String(f.severity))}/10]</strong> ${escHtml(f.message)}</li>`).join('')
      : '<li>No flagged messages</li>';

    await resend.emails.send({
      from: 'Vibe Check Bot <noreply@vibecheckbot.com>',
      to: CONFIG.REPORT_EMAIL,
      subject: `📊 Vibe Report --- ${serverName} | Score: ${result.friendlinessScore}/10`,
      html: `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
  <h2 style="color:#F97316">📊 Vibe Check Bot Report</h2>
  <table style="width:100%;border-collapse:collapse">
    <tr><td style="padding:6px;border-bottom:1px solid #eee"><strong>Server</strong></td><td>${escHtml(serverName)}</td></tr>
    <tr><td style="padding:6px;border-bottom:1px solid #eee"><strong>Channel(s)</strong></td><td>${escHtml(channelNames.join(', '))}</td></tr>
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
  <p>${escHtml(result.recommendation || 'N/A')}</p>
</div>`
    });
  } catch (err) { console.error('Email error:', err.message); }
}

async function sendNewTrialEmail(serverName, serverId, userName) {
  try {
    await resend.emails.send({
      from: 'Vibe Check Bot <noreply@vibecheckbot.com>',
      to: CONFIG.REPORT_EMAIL,
      subject: `🆕 New Free Trial: ${serverName}`,
      html: `<div style="font-family:Arial,sans-serif"><h2>🆕 New Free Trial</h2><p><strong>Server:</strong> ${escHtml(serverName)}</p><p><strong>ID:</strong> ${escHtml(serverId)}</p><p><strong>By:</strong> ${escHtml(userName)}</p></div>`
    });
  } catch (err) { console.error('New trial email error:', err.message); }
}

async function sendTrialEndedEmail(serverName, serverId, userName) {
  try {
    await resend.emails.send({
      from: 'Vibe Check Bot <noreply@vibecheckbot.com>',
      to: CONFIG.REPORT_EMAIL,
      subject: `🔔 Trial Ended: ${serverName}`,
      html: `<div style="font-family:Arial,sans-serif"><h2>🔔 Trial Ended</h2><p><strong>Server:</strong> ${escHtml(serverName)}</p><p><strong>ID:</strong> ${escHtml(serverId)}</p><p><strong>By:</strong> ${escHtml(userName)}</p><p>To give extra reports: <code>/vibe-admin action:test server_id:${escHtml(serverId)}</code></p></div>`
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
    .addChannelOption(opt =>
      opt.setName('channel').setDescription('Channel to analyze (default: current)').setRequired(false).addChannelTypes(ChannelType.GuildText))
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
    .addStringOption(opt =>
      opt.setName('sensitivity').setDescription('How strict the analysis is (default: medium)').setRequired(false).addChoices(
        { name: '🎮 Low --- Gaming/Adult', value: 'low' },
        { name: '⚖️ Medium --- General', value: 'medium' },
        { name: '👶 High --- Kids/Family', value: 'high' }
      ))
    .addStringOption(opt =>
      opt.setName('visibility').setDescription('Who sees the report (default: private)').setRequired(false).addChoices(
        { name: '🔒 Private --- sent to your DMs', value: 'private' },
        { name: '📢 Public --- everyone in channel', value: 'public' }
      ))
    // FIX #3: Removed preset choices — now accepts any integer from 1 to 1000
    .addIntegerOption(opt =>
      opt.setName('messages')
        .setDescription('Messages per channel to analyze (default: 100, max: 1000 for Pro)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(1000)
    );

  const progressCommand = new SlashCommandBuilder()
    .setName('vibe-progress')
    .setDescription('See your community friendliness trend over time')
    .addStringOption(opt => opt.setName('range').setDescription('How many past reports to show (default: 10)').setRequired(false).addChoices(
      { name: 'Last 5 reports', value: '5' },
      { name: 'Last 10 reports', value: '10' },
      { name: 'Last 20 reports', value: '20' },
      { name: 'Last 30 days', value: '30d' }
    ))
    .addStringOption(opt =>
      opt.setName('sensitivity').setDescription('Filter by sensitivity level used when running /vibe').setRequired(false).addChoices(
        { name: '🎮 Low — Gaming/Adult', value: 'low' },
        { name: '⚖️ Medium — General', value: 'medium' },
        { name: '👶 High — Kids/Family', value: 'high' }
      ))
    .addChannelOption(opt =>
      opt.setName('channel').setDescription('Filter by channel').setRequired(false).addChannelTypes(ChannelType.GuildText))
    .addChannelOption(opt =>
      opt.setName('channel2').setDescription('Compare channel 2').setRequired(false).addChannelTypes(ChannelType.GuildText))
    .addChannelOption(opt =>
      opt.setName('channel3').setDescription('Compare channel 3').setRequired(false).addChannelTypes(ChannelType.GuildText));

  const adminCommand = new SlashCommandBuilder()
    .setName('vibe-admin')
    .setDescription('Admin controls (owner only)')
    .addStringOption(opt => opt.setName('action').setDescription('Action to perform').setRequired(true).addChoices(
      { name: '🧪 Test --- give extra free reports', value: 'test' },
      { name: '👥 Tester --- unlimited access for 2 weeks', value: 'tester' },
      { name: '❌ Remove Tester --- revoke tester access', value: 'tester_off' },
      { name: '⚡ Pro --- activate Pro', value: 'pro' },
      { name: '🔴 Pro Off --- deactivate Pro', value: 'pro_off' }
    ))
    .addStringOption(opt =>
      opt.setName('server_id').setDescription('Server ID').setRequired(true))
    .addIntegerOption(opt =>
      opt.setName('reports').setDescription('Extra reports to add (Test only, default: 5)').setRequired(false));

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
  console.log(' ✅ VIBE CHECK BOT IS ONLINE');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(` Bot: ${client.user.tag}`);
  console.log(` Servers: ${client.guilds.cache.size}`);
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
    if (!interaction.guildId) {
      return interaction.reply({ content: '❌ Progress reports can only be viewed from inside a server.', ephemeral: true });
    }
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
    const sensitivity = interaction.options.getString('sensitivity') || null;
    const filterChannels = [
      interaction.options.getChannel('channel'),
      interaction.options.getChannel('channel2'),
      interaction.options.getChannel('channel3')
    ].filter(Boolean);
    await handleProgressCommand(interaction, range, filterChannels, sensitivity);
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

  const visibility = interaction.options.getString('visibility') || 'private';
  const sensitivity = interaction.options.getString('sensitivity') || 'medium';
  const timeframe = interaction.options.getString('timeframe') || '7d';
  const isPrivate = visibility === 'private';
  const isPublic = !isPrivate;

  const status = await getServerStatus(serverId);
  const { isTester: tester, isPaid: serverIsPaid, canUse, remaining: initialRemaining, subDaysLeft } = status;

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

  // Enforce channel limits per plan
  const maxChannels = (serverIsPaid || tester) ? CONFIG.PRO_MAX_CHANNELS : CONFIG.FREE_MAX_CHANNELS;
  if (channels.length > maxChannels) {
    const upgradeNote = !serverIsPaid && !tester
      ? `\n\nUpgrade to Pro to analyze up to **${CONFIG.PRO_MAX_CHANNELS} channels** at once.`
      : '';
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xf59e0b)
        .setTitle('⚠️ Too Many Channels')
        .setDescription(`Your plan allows up to **${maxChannels} channel${maxChannels === 1 ? '' : 's'}** per report. You selected **${channels.length}**.${upgradeNote}`)
      ],
      components: (!serverIsPaid && !tester) ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('⚡ Upgrade to Pro').setStyle(ButtonStyle.Link).setURL(CONFIG.STRIPE_MONTHLY_LINK)
      )] : [],
      ephemeral: true
    });
  }

  // Clamp message count to plan limits
  let messageCount = interaction.options.getInteger('messages') || 100;
  if (!serverIsPaid && !tester && messageCount > CONFIG.FREE_MAX_MESSAGES) {
    messageCount = CONFIG.FREE_MAX_MESSAGES;
  }

  // Trial / limit check — before throttling or deferring
  if (!tester && !canUse) {
    if (serverIsPaid) {
      const daysUntilReset = Math.max(1, 30 - Math.round((Date.now() - (status.monthStart || Date.now())) / (1000 * 60 * 60 * 24)));
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xf59e0b).setTitle('⚠️ Monthly Limit Reached')
          .setDescription(`You've used all **${CONFIG.PRO_REPORTS_PER_MONTH} reports** this month.\nResets in **${daysUntilReset} day${daysUntilReset === 1 ? '' : 's'}**.`)
        ],
        ephemeral: true
      });
    } else {
      if (!trialEndedNotified.has(serverId)) {
        trialEndedNotified.add(serverId);
        await sendTrialEndedEmail(serverName, serverId, interaction.user.tag);
      }
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xf59e0b).setTitle('⚠️ Free Trial Ended')
          .setDescription(`You've used all **${CONFIG.FREE_REPORTS}** free reports.`)
          .addFields(
            { name: '⚡ Upgrade to Pro', value: `30 reports/month • Up to 1,000 messages • Multi-channel` },
            { name: 'Monthly', value: `[$8.99/mo](${CONFIG.STRIPE_MONTHLY_LINK})`, inline: true },
            { name: 'Yearly', value: `[$99/yr --- save 8%](${CONFIG.STRIPE_YEARLY_LINK})`, inline: true }
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

  // Only count against throttle if we're actually going to run the analysis
  incrementServerThrottle(serverId);

  // Private: defer ephemerally (DM delivery). Public: defer non-ephemerally so editReply is visible to all.
  await interaction.deferReply({ ephemeral: isPrivate });
  setCooldown(interaction.user.id);

  try {
    const timeMs = { '1h': 3600000, '24h': 86400000, '7d': 604800000, '14d': 1209600000, '30d': 2592000000 }[timeframe] || 604800000;
    const timeframeLabel = { '1h': '1 hour', '24h': '24 hours', '7d': '7 days', '14d': '14 days', '30d': '30 days' }[timeframe] || '7 days';

    const msgsPerChannel = Math.max(10, Math.floor(messageCount / channels.length));

    const cachedMessages = {};
    const channelNames = [];
    const channelMsgCounts = {};

    for (const ch of channels) {
      if (!canReadChannel(interaction.guild, ch)) {
        return interaction.editReply(`❌ I don't have permission to read **#${ch.name}**. Please check my channel permissions.`);
      }
      const msgs = await fetchChannelMessages(ch, msgsPerChannel, timeMs);
      const chName = `#${ch.name}`;
      cachedMessages[chName] = msgs;
      channelMsgCounts[chName] = msgs.length;
      channelNames.push(chName);
    }

    const totalMsgs = Object.values(cachedMessages).reduce((s, m) => s + m.length, 0);
    if (totalMsgs < 5) {
      return interaction.editReply('❌ Not enough messages to analyze. Need at least 5 messages in the selected timeframe. Try a longer timeframe or a different channel.');
    }

    const channelResults = {};
    let totalProcessingTime = 0, totalCost = 0, totalInputTokens = 0, totalOutputTokens = 0, totalAnalyzed = 0;

    for (const ch of channels) {
      const chName = `#${ch.name}`;
      const chMsgs = cachedMessages[chName] || [];
      if (chMsgs.length < 2) { channelResults[chName] = null; continue; }
      const res = await analyzeMessages(chMsgs, [chName], sensitivity, timeframeLabel);
      channelResults[chName] = res;
      totalProcessingTime += res.processingTime || 0;
      totalCost += res.cost || 0;
      totalInputTokens += res.inputTokens || 0;
      totalOutputTokens += res.outputTokens || 0;
      totalAnalyzed += res.analyzedCount || 0;
    }

    const validChannels = Object.entries(channelResults).filter(([, r]) => r !== null);
    if (validChannels.length === 0) {
      return interaction.editReply('❌ Not enough messages in any channel. Try a longer timeframe.');
    }

    const totalMsgsForWeight = validChannels.reduce((s, [, r]) => s + r.analyzedCount, 0) || 1;
    const impactScore = parseFloat(
      (validChannels.reduce((s, [, r]) => s + r.result.friendlinessScore * r.analyzedCount, 0) / totalMsgsForWeight).toFixed(1)
    );

    const combinedSentiment = { friendly: 0, neutral: 0, unfriendly: 0 };
    const combinedToxTypes = {};
    const combinedFlagged = [];

    for (const [, res] of validChannels) {
      combinedSentiment.friendly += res.result.sentiment.friendly || 0;
      combinedSentiment.neutral += res.result.sentiment.neutral || 0;
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
      sentiment: combinedSentiment,
      flaggedMessages: combinedFlagged.sort((a, b) => b.severity - a.severity).slice(0, 10),
      toxicityTypes: combinedToxTypes,
      summary: combinedSummary,
      recommendation: combinedRec
    };

    // Fetch reactions for every channel
    const channelReactions = {};
    for (const ch of channels) {
      const chName = `#${ch.name}`;
      channelReactions[chName] = await getChannelStats(interaction.guild, ch);
    }

    await incrementUsage(serverId, status);
    const remaining = Math.max(0, initialRemaining - 1);

    const reportEmbed = buildReportEmbed(
      result, totalAnalyzed, channelNames,
      timeframeLabel, sensitivity, remaining, serverIsPaid,
      channelReactions, channelReactions[channelNames[0]], isPublic, channelMsgCounts, channelResults, tester
    );

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('📧 Request Tools').setStyle(ButtonStyle.Link).setURL('https://www.felixagaming.com/vibe'),
      new ButtonBuilder().setLabel('📈 View Progress').setStyle(ButtonStyle.Primary).setCustomId('view_progress')
    );

    if (!serverIsPaid && !tester) {
      buttons.addComponents(new ButtonBuilder().setLabel('⚡ Upgrade to Pro').setStyle(ButtonStyle.Link).setURL(CONFIG.STRIPE_MONTHLY_LINK));
    }

    // FIX #2: Private reports go to DMs so they persist permanently.
    // Public reports are posted in the channel for everyone to see.
    if (isPrivate) {
      try {
        await interaction.user.send({ embeds: [reportEmbed], components: [buttons] });
        await interaction.editReply('📬 Your private Vibe Report has been sent to your DMs! It will stay there permanently.');
      } catch {
        // DMs disabled — fall back to ephemeral in channel with a note
        await interaction.editReply({
          content: '⚠️ Couldn\'t send to your DMs (they may be disabled). Here\'s your report — note it will disappear when you close Discord.',
          embeds: [reportEmbed],
          components: [buttons]
        });
      }
    } else {
      // Public: post non-ephemeral in the channel so everyone can see and it persists
      await interaction.editReply({ content: null, embeds: [reportEmbed], components: [buttons] });
    }

    // Background tasks — run in parallel, don't await so followUp notifications fire immediately
    Promise.all([
      saveReport(serverId, serverName, channelNames, result.friendlinessScore, result.sentiment, result.flaggedMessages?.length || 0, sensitivity, timeframe, totalAnalyzed, result.toxicityTypes),
      logResearchData({ serverName, serverId, memberCount: interaction.guild.memberCount, channelNames, channelResults, analyzedCount: totalAnalyzed, score: result.friendlinessScore, sentiment: result.sentiment, flaggedCount: result.flaggedMessages?.length || 0, toxicityTypes: result.toxicityTypes, sensitivity, timeframe, isPro: serverIsPaid, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cost: totalCost, processingTime: totalProcessingTime }),
      sendEmailReport(serverName, serverId, channelNames, result, totalAnalyzed, timeframeLabel, sensitivity, remaining)
    ]).catch(err => console.error('Background task error:', err.message));

    const usedNow = status.reportsUsed + 1;
    if (usedNow === 1 && !serverIsPaid && !tester) await sendNewTrialEmail(serverName, serverId, interaction.user.tag);

    if (usedNow % 5 === 0 && usedNow > 0) {
      await interaction.followUp({
        embeds: [new EmbedBuilder().setColor(0xA78BFA).setDescription(`🎉 **${usedNow} reports** completed! Want to see how your community is improving?`)],
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('📈 View Progress Report').setStyle(ButtonStyle.Primary).setCustomId('view_progress'))],
        ephemeral: true
      });
    }

    if (!serverIsPaid && !tester && remaining > 0 && remaining <= 2) {
      await interaction.followUp({
        embeds: [new EmbedBuilder().setColor(0xf59e0b).setDescription(`⚠️ Only **${remaining}** free ${remaining === 1 ? 'report' : 'reports'} left. [Get Pro](${CONFIG.STRIPE_MONTHLY_LINK}) for 30/month.`)],
        ephemeral: true
      });
    }

    if (serverIsPaid && subDaysLeft <= 7 && subDaysLeft > 0) {
      await interaction.followUp({
        embeds: [new EmbedBuilder().setColor(0xf59e0b).setTitle('⏰ Subscription Expiring Soon').setDescription(`Your Pro subscription expires in **${subDaysLeft} day${subDaysLeft === 1 ? '' : 's'}**!\n\nRenew to keep access.`)],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('🔄 Renew Monthly --- $8.99').setStyle(ButtonStyle.Link).setURL(CONFIG.STRIPE_MONTHLY_LINK),
          ...(CONFIG.YEARLY_ENABLED ? [new ButtonBuilder().setLabel('💎 Renew Yearly --- $99').setStyle(ButtonStyle.Link).setURL(CONFIG.STRIPE_YEARLY_LINK)] : [])
        )],
        ephemeral: true
      });
    }

  } catch (err) {
    console.error('Vibe error:', err);
    try { await interaction.editReply('❌ Something went wrong. Please try again in a moment.'); } catch {}
  }
}

// ============================================================
// /vibe-progress HANDLER
// ============================================================

async function handleProgressCommand(interaction, range, filterChannels, sensitivity = null) {
  const serverId = interaction.guildId;
  if (!serverId || !interaction.guild) {
    return interaction.reply({ content: '❌ This command can only be used inside a server.', ephemeral: true });
  }
  try {
    await interaction.deferReply({ ephemeral: true });

    let query = supabase.from('reports').select('*').eq('server_id', serverId).order('created_at', { ascending: false });
    if (range === '30d') {
      // Cap 30d at 200 rows — prevents Supabase timeouts and matches chart data cap
      query = query
        .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
        .limit(200);
    } else {
      // Fetch extra headroom when a channel filter is active — the limit is applied AFTER filtering
      const baseLimit = parseInt(range) || 10;
      const fetchLimit = (filterChannels && filterChannels.length > 0) ? Math.max(baseLimit * 5, 50) : baseLimit;
      query = query.limit(fetchLimit);
    }

    const { data: reports, error } = await query;
    if (error) {
      console.error('Progress DB error:', error);
      return interaction.editReply('❌ Database error loading reports. Please try again.');
    }
    if (!reports || reports.length === 0) {
      return interaction.editReply('❌ No reports found. Run `/vibe` first to start tracking progress.');
    }

    const sorted = [...reports].reverse(); // oldest → newest
    let filteredReports = sorted;
    let filterLabel = '';

    // Apply sensitivity filter if provided
    if (sensitivity) {
      filteredReports = filteredReports.filter(r => r.sensitivity === sensitivity);
      filterLabel += ` • ${sensitivity} sensitivity`;
      if (filteredReports.length === 0) {
        return interaction.editReply(`❌ No reports found with **${sensitivity}** sensitivity. Run \`/vibe sensitivity:${sensitivity}\` first.`);
      }
    }

    if (filterChannels && filterChannels.length > 0) {
      const chNames = filterChannels.map(c => `#${c.name}`);
      // Match exactly: split CSV channel_name field and check for intersection
      filteredReports = sorted.filter(r => {
        if (!r.channel_name) return false;
        const reportChs = r.channel_name.split(',').map(s => s.trim());
        return chNames.some(ch => reportChs.includes(ch));
      });
      filterLabel = ` • ${chNames.join(', ')}`;
      if (filteredReports.length === 0) {
        const chList = chNames.join(', ');
        return interaction.editReply(`❌ No reports found for ${chList}. Run \`/vibe\` in that channel first.`);
      }
      // Trim to the originally requested range (we over-fetched to account for filtering)
      if (range !== '30d') {
        const baseLimit = parseInt(range) || 10;
        filteredReports = filteredReports.slice(-baseLimit); // keep the most recent N
      }
    }

    const latest      = filteredReports[filteredReports.length - 1];
    const oldest      = filteredReports[0];
    const latestScore = parseFloat(latest.score) || 0;

    // ── SHARED HELPERS ────────────────────────────────────────
    const safeDiv    = (n, d) => d === 0 ? 0 : Math.round((n / d) * 100);
    const avgScore   = (filteredReports.reduce((s, r) => s + (parseFloat(r.score) || 0), 0) / filteredReports.length).toFixed(1);
    const scoreDiff  = parseFloat((latestScore - (parseFloat(oldest.score) || 0)).toFixed(1));
    const diffStr    = scoreDiff > 0 ? `+${scoreDiff}` : `${scoreDiff}`;
    const trendEmoji = scoreDiff > 0 ? '📈' : scoreDiff < 0 ? '📉' : '➡️';

    const newTotal = (latest.friendly||0)+(latest.neutral||0)+(latest.unfriendly||0) || 1;
    const oldTotal = (oldest.friendly||0)+(oldest.neutral||0)+(oldest.unfriendly||0) || 1;
    const lastFPct  = safeDiv(latest.friendly,   newTotal);
    const lastUPct  = safeDiv(latest.unfriendly,  newTotal);
    const firstFPct = safeDiv(oldest.friendly,    oldTotal);
    const firstUPct = safeDiv(oldest.unfriendly,  oldTotal);
    const firstFlagged = oldest.flagged_count  || 0;
    const lastFlagged  = latest.flagged_count  || 0;
    const flagDiff     = lastFlagged - firstFlagged;

    // Cumulative tox map
    const toxMap = {};
    filteredReports.forEach(r => {
      try {
        const t = typeof r.toxicity_types === 'string' ? JSON.parse(r.toxicity_types) : r.toxicity_types;
        if (t) Object.entries(t).forEach(([k, v]) => { toxMap[k] = (toxMap[k] || 0) + (v || 0); });
      } catch {}
    });
    const toxEntries = Object.entries(toxMap).filter(([,v]) => v > 0).sort((a,b) => b[1]-a[1]);

    // Channel stats map for ranking chart — split CSV channel_name so multi-channel runs
    // contribute to individual channel stats rather than appearing as their own entry
    const indivChannelSet = new Set();
    filteredReports.forEach(r => {
      if (r.channel_name) r.channel_name.split(',').map(s => s.trim()).filter(Boolean).forEach(ch => indivChannelSet.add(ch));
    });
    const channelStats = {};
    [...indivChannelSet].forEach(ch => {
      const chReps = filteredReports.filter(r =>
        r.channel_name && r.channel_name.split(',').map(s => s.trim()).includes(ch)
      );
      if (chReps.length > 0) {
        channelStats[ch] = { latestScore: parseFloat(chReps[chReps.length - 1].score) || 0, reportCount: chReps.length };
      }
    });
    const isMulti = Object.keys(channelStats).length > 1;

    // Prediction
    const prediction = predictNextScore(filteredReports);

    // Trend description
    const trendDesc = (() => {
      if (filteredReports.length < 2) return 'Only one report so far — run `/vibe` again to start tracking trends.';
      if (scoreDiff >= 2)    return `🚀 **Major improvement!** Community jumped **${diffStr} pts**. Something is working — keep it up.`;
      if (scoreDiff >= 0.5)  return `📈 **Trending upward** by **${diffStr} pts**. Moderation efforts are paying off.`;
      if (scoreDiff >= 0)    return `➡️ **Holding steady** at **${latestScore}/10**. Community is stable.`;
      if (scoreDiff >= -0.5) return `⚠️ **Slight dip** of **${diffStr} pts**. Keep an eye on flagged messages.`;
      if (scoreDiff >= -2)   return `📉 **Score dropped ${diffStr} pts**. Review recent flagged messages and remind members of the rules.`;
      return `🚨 **Significant drop of ${diffStr} pts**. Immediate moderation attention recommended.`;
    })();

    // Recommendations
    const recommendations = [];
    if (scoreDiff < -0.5) recommendations.push(`📉 Score dropped ${Math.abs(scoreDiff)} pts — post community guidelines and review flagged messages.`);
    else if (scoreDiff > 0.5) recommendations.push(`📈 Great progress (${diffStr} pts) — keep current moderation. Consider highlighting positive contributors.`);
    else recommendations.push(`➡️ Score is stable — run a targeted /vibe on your lowest-performing channel.`);
    if (lastFlagged > firstFlagged) recommendations.push(`⚠️ Flagged messages increased (${firstFlagged} → ${lastFlagged}) — consider stricter auto-mod rules.`);
    if (lastUPct > firstUPct) recommendations.push(`🔴 Unfriendly % rose ${firstUPct}% → ${lastUPct}% — a pinned community rules reminder may help.`);
    if (toxEntries.length > 0) recommendations.push(`⚠️ Top recurring issue: **${toxEntries[0][0]}** (${toxEntries[0][1]} total instances).`);
    if (prediction) recommendations.push(`${prediction.direction === '📈 improving' ? '🟢' : prediction.direction === '📉 declining' ? '🔴' : '⚪'} **Predicted next score: ${prediction.predicted}/10** (trend: ${prediction.direction})`);

    // Chart data capped at 50 most recent to keep QuickChart URLs under limits
    const chartReports = filteredReports.slice(-50);

    // ── GENERATE ALL CHART URLs ───────────────────────────────
    const scoreTrendUrl   = generateScoreTrendChart(chartReports);
    const sentimentUrl    = generateSentimentTrendChart(chartReports);
    const toxDoughnutUrl  = generateToxicityDoughnut(toxMap);
    const toxEvolutionUrl = generateToxicityEvolutionChart(chartReports);
    const channelRankUrl  = isMulti ? generateChannelRankingChart(channelStats) : null;

    // ── EMBED 1: OVERALL SUMMARY + SCORE TREND CHART ─────────
    const embed1 = new EmbedBuilder()
      .setColor(scoreColor(latestScore))
      .setTitle(`📈 Progress Report — ${interaction.guild.name}`)
      .setDescription(
        `**${filteredReports.length} report${filteredReports.length === 1 ? '' : 's'}**${filterLabel} • ` +
        `First: **${parseFloat(oldest.score) || 0}/10** → Latest: **${latestScore}/10**\n\n` +
        `${scoreEmoji(latestScore)} **Current: ${latestScore}/10 — ${scoreLabel(latestScore)}**\n` +
        `\`${buildScoreBar(latestScore)}\`\n` +
        `Avg: **${avgScore}/10** • Change: **${trendEmoji} ${diffStr}**` +
        (prediction ? `\n🔮 **Next report prediction: ${prediction.predicted}/10** (${prediction.direction})` : '')
      )
      .addFields(
        { name: '🎯 Trend Analysis', value: trendDesc, inline: false },
        {
          name: '🔍 Community Health Analysis',
          value: (() => {
            const lines = [];
            if (latestScore >= 8) lines.push(`✨ **Thriving Community** — Your server is in excellent health with a score of ${latestScore}/10.`);
            else if (latestScore >= 6) lines.push(`👍 **Healthy Community** — Your server is generally positive at ${latestScore}/10.`);
            else if (latestScore >= 4) lines.push(`⚠️ **Mixed Atmosphere** — Your server score of ${latestScore}/10 suggests room for improvement.`);
            else lines.push(`🚨 **Needs Attention** — A score of ${latestScore}/10 indicates significant toxicity issues.`);
            if (lastFPct >= 70) lines.push(`🟢 **${lastFPct}% of messages are friendly** — your community is welcoming to new members.`);
            else if (lastFPct >= 50) lines.push(`🟡 **${lastFPct}% friendly messages** — most interactions are positive but there's room to grow.`);
            else lines.push(`🔴 **Only ${lastFPct}% friendly messages** — consider posting community guidelines and increasing moderation.`);
            if (scoreDiff > 0) lines.push(`📈 Score improved by **${diffStr} pts** since first report — your efforts are working!`);
            else if (scoreDiff < 0) lines.push(`📉 Score dropped by **${diffStr} pts** — recent events may have impacted community health.`);
            if (toxEntries.length > 0) lines.push(`⚠️ Most common issue: **${toxEntries[0][0]}** (${toxEntries[0][1]} instances across all reports).`);
            return lines.join('\n');
          })(),
          inline: false
        },
        {
          name: '💬 Sentiment (latest)',
          value:
            sentimentRow('Friendly',   '🟢', latest.friendly   || 0, newTotal) + `  _(was ${firstFPct}%${lastFPct-firstFPct !== 0 ? ` ${lastFPct-firstFPct > 0 ? '↑' : '↓'}${Math.abs(lastFPct-firstFPct)}%` : ''})_\n` +
            sentimentRow('Neutral',    '⚪', latest.neutral    || 0, newTotal) + '\n' +
            sentimentRow('Unfriendly', '🔴', latest.unfriendly || 0, newTotal) + `  _(was ${firstUPct}%${lastUPct-firstUPct !== 0 ? ` ${lastUPct-firstUPct > 0 ? '↑' : '↓'}${Math.abs(lastUPct-firstUPct)}%` : ''})_`,
          inline: false
        },
        {
          name: `🚩 Flagged Messages`,
          value: `${firstFlagged} → ${lastFlagged} (${flagDiff < 0 ? `✅ ↓ Down ${Math.abs(flagDiff)}` : flagDiff > 0 ? `⚠️ ↑ Up ${flagDiff}` : `➡️ Stable`})`,
          inline: true
        },
        {
          name: '📋 Reports Span',
          value: `${new Date(oldest.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} → ${new Date(latest.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
          inline: true
        }
      );
    if (scoreTrendUrl) embed1.setImage(scoreTrendUrl);

    const embeds = [embed1];

    // ── EMBED 2: SENTIMENT EVOLUTION CHART ───────────────────
    if (sentimentUrl && filteredReports.length >= 2) {
      const fChange = lastFPct - firstFPct;
      const uChange = lastUPct - firstUPct;
      const embed2 = new EmbedBuilder()
        .setColor(0x3b82f6)
        .setTitle('💬 Sentiment Evolution')
        .setDescription(
          `**Friendly:** ${firstFPct}% → ${lastFPct}% ${fChange > 0 ? `🟢 ↑+${fChange}%` : fChange < 0 ? `🔴 ↓${Math.abs(fChange)}%` : '→ unchanged'}\n` +
          `**Unfriendly:** ${firstUPct}% → ${lastUPct}% ${uChange > 0 ? `🔴 ↑+${uChange}%` : uChange < 0 ? `🟢 ↓${Math.abs(uChange)}%` : '→ unchanged'}`
        )
        .setImage(sentimentUrl);
      embeds.push(embed2);
    }

    // ── EMBED 3: TOXICITY DOUGHNUT ────────────────────────────
    if (toxDoughnutUrl) {
      const toxSummary = toxEntries.slice(0, 5).map(([k, v]) => `• **${k}**: ${v}`).join('\n') || 'None detected ✅';
      const embed3 = new EmbedBuilder()
        .setColor(0xf97316)
        .setTitle('⚠️ Cumulative Toxicity Breakdown')
        .setDescription(`Across all ${filteredReports.length} reports:\n${toxSummary}`)
        .setImage(toxDoughnutUrl);
      embeds.push(embed3);
    }

    // ── EMBED 4: TOXICITY TYPE EVOLUTION ─────────────────────
    if (toxEvolutionUrl && filteredReports.length >= 2) {
      const embed4 = new EmbedBuilder()
        .setColor(0xef4444)
        .setTitle('🧪 Toxicity Type Evolution')
        .setDescription('How each toxicity type changed across reports — stacked bars show volume per report.')
        .setImage(toxEvolutionUrl);
      embeds.push(embed4);
    }

    // ── EMBED 5: CHANNEL RANKING (multi only) ─────────────────
    if (channelRankUrl) {
      const rankLines = Object.entries(channelStats)
        .sort((a,b) => b[1].latestScore - a[1].latestScore)
        .map(([ch, s]) => `${scoreEmoji(s.latestScore)} **${ch}** — ${s.latestScore}/10 \`${buildScoreBar(s.latestScore)}\` (${s.reportCount} run${s.reportCount===1?'':'s'})`)
        .join('\n');
      const embed5 = new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle('📍 Channel Health Ranking')
        .setDescription(rankLines)
        .setImage(channelRankUrl);
      embeds.push(embed5);
    }

    // ── EMBED 6: RECOMMENDATIONS ──────────────────────────────
    const embedLast = new EmbedBuilder()
      .setColor(scoreColor(latestScore))
      .setTitle('💡 AI Recommendations')
      .setDescription(recommendations.join('\n\n'))
      .setFooter({ text: `Vibe Check Bot • ${filteredReports.length} report${filteredReports.length===1?'':'s'} • Run /vibe regularly to build your history` });
    embeds.push(embedLast);

    // ── SEND ALL EMBEDS ───────────────────────────────────────
    // Discord allows max 10 embeds per message; we stay well under
    await interaction.editReply({ embeds });

  } catch (err) {
    console.error('Progress error:', err);
    const detail = err?.message ? ` (${err.message.substring(0, 100)})` : '';
    try { await interaction.editReply(`❌ Something went wrong loading your progress report.${detail}`); } catch {}
  }
}

// ============================================================
// /vibe-admin HANDLER
// ============================================================

async function handleAdminCommand(interaction) {
  if (interaction.user.id !== CONFIG.OWNER_ID) {
    return interaction.reply({ content: '❌ This command is for the bot owner only.', ephemeral: true });
  }

  const action = interaction.options.getString('action');
  const serverId = interaction.options.getString('server_id');
  const extraReports = interaction.options.getInteger('reports') || 5;

  if (!/^\d{17,19}$/.test(serverId)) {
    return interaction.reply({ content: '❌ Invalid server ID. Must be a 17-19 digit number.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  console.log(`🔧 ADMIN: ${action} on server ${serverId} by ${interaction.user.tag}`);

  try {
    if (action === 'tester') {
      const expires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
      await supabase.from('testers').upsert({ server_id: serverId, approved_at: new Date().toISOString(), expires_at: expires.toISOString() });
      return interaction.editReply(
        `👥 **Tester approved --- unlimited access**\n` +
        `Server: \`${serverId}\`\n` +
        `Expires: **${expires.toDateString()}**\n\n` +
        `✅ No report limits, no message limits, multi-channel --- all unlocked.`
      );
    }

    if (action === 'tester_off') {
      await supabase.from('testers').delete().eq('server_id', serverId);
      return interaction.editReply(`❌ **Tester access revoked**\nServer \`${serverId}\` is back to Free tier.`);
    }

    if (action === 'test') {
      const { data } = await supabase.from('usage').select('reports_used, free_bonus').eq('server_id', serverId).single();
      if (data) {
        await supabase.from('usage').update({ free_bonus: (data.free_bonus || 0) + extraReports }).eq('server_id', serverId);
      } else {
        await supabase.from('usage').insert({ server_id: serverId, reports_used: 0, free_bonus: extraReports, month_start: new Date().toISOString() });
      }
      return interaction.editReply(`🧪 **Test mode**\nServer: \`${serverId}\`\nAdded **${extraReports}** extra free reports.`);
    }

    if (action === 'pro') {
      const { data: existing } = await supabase.from('paid_servers').select('expires_at').eq('server_id', serverId).single();
      const base = (existing?.expires_at && new Date(existing.expires_at) > new Date())
        ? new Date(existing.expires_at)  // extend from current expiry
        : new Date();                    // start from now
      const expires = new Date(base);
      expires.setDate(expires.getDate() + 30);
      await supabase.from('paid_servers').upsert({ server_id: serverId, activated_at: new Date().toISOString(), expires_at: expires.toISOString() });
      const wasActive = existing?.expires_at && new Date(existing.expires_at) > new Date();
      return interaction.editReply(`⚡ **Pro ${wasActive ? 'extended' : 'activated'}**\nServer: \`${serverId}\`\nExpires: **${expires.toDateString()}**${wasActive ? ` _(+30 days from previous expiry)_` : ''}`);
    }

    if (action === 'pro_off') {
      await supabase.from('paid_servers').delete().eq('server_id', serverId);
      return interaction.editReply(`🔴 **Pro deactivated**\nServer \`${serverId}\` is now on Free tier.`);
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
