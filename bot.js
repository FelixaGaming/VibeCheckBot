const http = require('http');
// ============================================================
// VIBE CHECK BOT v2.4
// ============================================================

// 1. RAILWAY INSTANT-BOOT (Must be at the top)
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Vibe Check 2.4 Active');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Railway Health Check online on port ${PORT}`);
});

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
  MessageFlags
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
  MAX_OPENAI_CHARS: 30000,
  STRIPE_MONTHLY_LINK: 'https://buy.stripe.com/fZu28k00n5s92Oqf4z4ow01',
  STRIPE_YEARLY_LINK:  'https://buy.stripe.com/bJebIUbJ56wd4Wye0v4ow03',
  CONTACT_EMAIL: 'play@felixagaming.com',
  REPORT_EMAIL:  'play@felixagaming.com',
  OWNER_ID:      '1185219817913991220',
  YEARLY_ENABLED: true,
  COOLDOWN_SECONDS: 15,
  SERVER_THROTTLE_PER_MINUTE: 10,
  COST_PER_1M_INPUT_TOKENS:  0.15,
  COST_PER_1M_OUTPUT_TOKENS: 0.60
};

// ============================================================
// SENSITIVITY PROMPTS
// ============================================================

const SENSITIVITY_PROMPTS = {
  low: `SENSITIVITY: LOW (Adult/Gaming communities)
- Casual trash talk and banter is NORMAL — mark as neutral, NOT unfriendly
- Only flag: death threats, slurs, doxxing, severe harassment
- Profanity alone is NOT unfriendly`,
  medium: `SENSITIVITY: MEDIUM (General communities)
- Flag: insults, harassment, bullying, hate speech, threats, repeated negativity
- Mild disagreement = neutral. Personal attacks = unfriendly
- Flag xenophobia, racism, sexism, homophobia`,
  high: `SENSITIVITY: HIGH (Kids / Family / Education)
- Flag: any profanity, mild insults, rude dismissals, negative tone
- Very strict — when in doubt, mark as unfriendly`
};

// ============================================================
// STARTUP VALIDATION
// ============================================================

function validateEnvironment() {
  const required = ['DISCORD_TOKEN', 'CLIENT_ID', 'OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_KEY'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) { console.error('FATAL: Missing env vars:', missing.join(', ')); process.exit(1); }
  if (!CONFIG.STRIPE_YEARLY_LINK || CONFIG.STRIPE_YEARLY_LINK.includes('YOUR_')) CONFIG.YEARLY_ENABLED = false;
  console.log('Environment validated');
}
validateEnvironment();

process.on('unhandledRejection', r => console.error('Unhandled Rejection:', r?.message || r));
process.on('uncaughtException',  e => console.error('Uncaught Exception:',  e.message));

// ============================================================
// CLIENTS
// ============================================================

const openai   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const resend   = new Resend(process.env.RESEND_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// Prevent Discord.js internal errors from crashing the process
client.on('error', err => console.error('Discord client error:', err));

// ============================================================
// USAGE TRACKING
// ============================================================

const serverUsage = new Map(), cooldowns = new Map(), serverThrottle = new Map();

async function getReportsUsed(serverId) {
  try {
    const { data } = await supabase.from('usage').select('reports_used').eq('server_id', serverId).single();
    return data?.reports_used || 0;
  } catch { return serverUsage.get(serverId)?.reportsUsed || 0; }
}

async function isPaid(serverId) {
  try {
    const { data } = await supabase.from('paid_servers').select('expires_at').eq('server_id', serverId).single();
    if (!data) return false;
    return !data.expires_at || new Date(data.expires_at) >= new Date();
  } catch { return false; }
}

async function isTester(serverId) {
  try {
    const { data } = await supabase.from('testers').select('expires_at').eq('server_id', serverId).single();
    return data && new Date(data.expires_at) > new Date();
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
    if (!data?.expires_at) return { isActive: false, daysLeft: 0 };
    const daysLeft = Math.ceil((new Date(data.expires_at) - Date.now()) / 86400000);
    return { isActive: daysLeft > 0, daysLeft: Math.max(0, daysLeft) };
  } catch { return { isActive: false, daysLeft: 0 }; }
}

async function canUseBot(serverId) {
  if (await isTester(serverId)) return true;
  const paid = await isPaid(serverId), used = await getReportsUsed(serverId);
  if (paid) return used < CONFIG.PRO_REPORTS_PER_MONTH;
  return used < (CONFIG.FREE_REPORTS + await getFreeBonus(serverId));
}

async function getReportsRemaining(serverId) {
  if (await isTester(serverId)) return 999;
  const paid = await isPaid(serverId), used = await getReportsUsed(serverId);
  if (paid) return CONFIG.PRO_REPORTS_PER_MONTH - used;
  return (CONFIG.FREE_REPORTS + await getFreeBonus(serverId)) - used;
}

async function incrementUsage(serverId) {
  if (await isTester(serverId)) return;
  try {
    const { data } = await supabase.from('usage').select('reports_used').eq('server_id', serverId).single();
    if (data) await supabase.from('usage').update({ reports_used: (data.reports_used || 0) + 1 }).eq('server_id', serverId);
    else await supabase.from('usage').insert({ server_id: serverId, reports_used: 1, month_start: new Date().toISOString() });
  } catch {
    if (!serverUsage.has(serverId)) serverUsage.set(serverId, { reportsUsed: 0 });
    serverUsage.get(serverId).reportsUsed++;
  }
}

function isOnCooldown(uid) { const l = cooldowns.get(uid); return l && (Date.now() - l) < CONFIG.COOLDOWN_SECONDS * 1000; }
function setCooldown(uid) { cooldowns.set(uid, Date.now()); }

function isServerThrottled(sid) {
  const now = Date.now(), e = serverThrottle.get(sid);
  if (!e || now > e.resetAt) { serverThrottle.set(sid, { count: 0, resetAt: now + 60000 }); return false; }
  return e.count >= CONFIG.SERVER_THROTTLE_PER_MINUTE;
}
function incrementServerThrottle(sid) {
  const now = Date.now(), e = serverThrottle.get(sid);
  if (!e || now > e.resetAt) serverThrottle.set(sid, { count: 1, resetAt: now + 60000 }); else e.count++;
}

// ============================================================
// MESSAGE FETCH
// ============================================================

function sanitize(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<@!?\d+>/g, '[user]').replace(/<#\d+>/g, '[channel]').replace(/<@&\d+>/g, '[role]')
    .replace(/@(everyone|here)/g, '[mention]').replace(/https?:\/\/\S+/g, '[link]')
    .replace(/\w{50,}/g, '[...]').trim().slice(0, 500);
}

function canReadChannel(guild, ch) {
  const perms = ch.permissionsFor(guild.members.me);
  return perms?.has('ViewChannel') && perms?.has('ReadMessageHistory');
}

async function fetchChannelMessages(channel, count, timeframeMs) {
  const cutoff = Date.now() - timeframeMs;
  let msgs = [], lastId;
  while (msgs.length < count) {
    const opts = { limit: 100 };
    if (lastId) opts.before = lastId;
    const fetched = await channel.messages.fetch(opts);
    if (!fetched.size) break;
    msgs.push(...fetched
      .filter(m => !m.author.bot && m.content.length > 0 && m.createdTimestamp > cutoff)
      .map(m => sanitize(m.content)).filter(Boolean));
    lastId = fetched.last().id;
    if (fetched.last().createdTimestamp < cutoff) break;
  }
  return msgs.slice(0, count);
}

// ============================================================
// CHANNEL STATS
// ============================================================

async function getChannelStats(guild, channel) {
  try {
    const POS = ['👍','❤️','😂','🔥','✅','🎉','😊','💯','⭐','🙌'];
    const NEG = ['👎','😡','🤮','💀','😤','😒','🤦'];
    let mr = null, mp = null, mn = null, maxT = 0, maxP = 0, maxN = 0;
    const recent = await channel.messages.fetch({ limit: 100 });
    recent.forEach(m => {
      if (m.author.bot || !m.content) return;
      let t = 0, p = 0, n = 0, rs = '';
      m.reactions.cache.forEach(r => {
        t += r.count; rs += `${r.emoji.name}x${r.count} `;
        if (POS.includes(r.emoji.name)) p += r.count;
        if (NEG.includes(r.emoji.name)) n += r.count;
      });
      rs = rs.trim();
      if (t > maxT) { maxT = t; mr = { text: m.content.substring(0, 80), reactions: rs || `${t}` }; }
      if (p > maxP) { maxP = p; mp = { text: m.content.substring(0, 80), reactions: rs || `${p}` }; }
      if (n > maxN) { maxN = n; mn = { text: m.content.substring(0, 80), reactions: rs || `${n}` }; }
    });
    return { totalMembers: guild.memberCount, mostReacted: mr, mostPositive: mp, mostNegative: mn };
  } catch { return { totalMembers: guild.memberCount, mostReacted: null, mostPositive: null, mostNegative: null }; }
}

// ============================================================
// QUICKCHART HELPERS
// ============================================================

function chartUrl(cfg, w, h) {
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(cfg))}&w=${w||500}&h=${h||260}&bkg=white`;
}

function pieChart(friendly, neutral, unfriendly) {
  const total = friendly + neutral + unfriendly || 1;
  const fp = Math.round(friendly / total * 100);
  const np = Math.round(neutral  / total * 100);
  const up = Math.round(unfriendly / total * 100);
  return chartUrl({
    type: 'pie',
    data: {
      labels: [`Friendly ${fp}%`, `Neutral ${np}%`, `Unfriendly ${up}%`],
      datasets: [{ data: [friendly, neutral, unfriendly], backgroundColor: ['#22c55e','#94a3b8','#ef4444'], borderWidth: 2 }]
    },
    options: { plugins: { legend: { position: 'bottom' }, title: { display: true, text: 'Sentiment Breakdown', font: { size: 14 } } } }
  });
}

function toxBarChart(toxTypes, title) {
  const entries = Object.entries(toxTypes || {}).filter(([,v]) => v > 0).sort((a,b) => b[1]-a[1]).slice(0,7);
  if (!entries.length) return null;
  return chartUrl({
    type: 'horizontalBar',
    data: {
      labels: entries.map(([k]) => k),
      datasets: [{ label: 'Count', data: entries.map(([,v]) => v), backgroundColor: '#f97316' }]
    },
    options: { plugins: { title: { display: true, text: title || 'Toxicity Types', font: { size: 14 } } }, scales: { xAxes: [{ ticks: { beginAtZero: true } }] } }
  });
}

function scoreLineChart(reports) {
  const labels = reports.map(r => new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  return chartUrl({
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Friendliness Score',
        data: reports.map(r => r.score),
        borderColor: '#f97316', backgroundColor: 'rgba(249,115,22,0.15)',
        fill: true, tension: 0.35, pointRadius: 5, pointBackgroundColor: '#f97316'
      }]
    },
    options: {
      plugins: { title: { display: true, text: 'Friendliness Score Over Time', font: { size: 14 } } },
      scales: { yAxes: [{ ticks: { min: 0, max: 10, stepSize: 1 } }] }
    }
  });
}

function impactLineChart(reports) {
  const labels = reports.map(r => new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  return chartUrl({
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Impact Score',
        data: reports.map(r => r.score),
        borderColor: '#8b5cf6', backgroundColor: 'rgba(139,92,246,0.12)',
        fill: true, tension: 0.35, pointRadius: 5, pointBackgroundColor: '#8b5cf6',
        borderDash: [5, 5]
      }]
    },
    options: {
      plugins: { title: { display: true, text: 'Community Impact Score Over Time', font: { size: 14 } } },
      scales: { yAxes: [{ ticks: { min: 0, max: 10, stepSize: 1 } }] }
    }
  });
}

function sentimentStackedChart(reports) {
  const labels = reports.map(r => new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  const sd = (n, d) => d === 0 ? 0 : Math.round(n / d * 100);
  return chartUrl({
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Friendly %',   data: reports.map(r => { const t=(r.friendly||0)+(r.neutral||0)+(r.unfriendly||0)||1; return sd(r.friendly||0,t); }), backgroundColor: '#22c55e', stack: 's' },
        { label: 'Neutral %',    data: reports.map(r => { const t=(r.friendly||0)+(r.neutral||0)+(r.unfriendly||0)||1; return sd(r.neutral||0,t);   }), backgroundColor: '#94a3b8', stack: 's' },
        { label: 'Unfriendly %', data: reports.map(r => { const t=(r.friendly||0)+(r.neutral||0)+(r.unfriendly||0)||1; return sd(r.unfriendly||0,t);}), backgroundColor: '#ef4444', stack: 's' }
      ]
    },
    options: {
      plugins: { title: { display: true, text: 'Sentiment Per Report (%)', font: { size: 14 } } },
      scales: { yAxes: [{ stacked: true, ticks: { max: 100 } }], xAxes: [{ stacked: true }] }
    }
  });
}

function flaggedLineChart(reports) {
  const labels = reports.map(r => new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  return chartUrl({
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Flagged Messages',
        data: reports.map(r => r.flagged_count || 0),
        borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.15)',
        fill: true, tension: 0.35, pointRadius: 5
      }]
    },
    options: {
      plugins: { title: { display: true, text: 'Flagged Messages Over Time', font: { size: 14 } } },
      scales: { yAxes: [{ ticks: { beginAtZero: true } }] }
    }
  });
}

function cumulativeToxChart(reports) {
  const toxMap = {};
  reports.forEach(r => {
    try {
      const t = typeof r.toxicity_types === 'string' ? JSON.parse(r.toxicity_types) : r.toxicity_types;
      if (t) Object.entries(t).forEach(([k,v]) => { toxMap[k] = (toxMap[k]||0) + (v||0); });
    } catch {}
  });
  return toxBarChart(toxMap, 'Cumulative Toxicity Breakdown');
}

// ============================================================
// BEHAVIOR PROBABILITY CALCULATOR
// ============================================================

function calcBehaviorProbability(reports) {
  if (reports.length < 2) return null;

  const confidence = reports.length >= 8 ? 'High' : reports.length >= 3 ? 'Medium' : 'Low';
  const confidenceEmoji = confidence === 'High' ? '🟢' : confidence === 'Medium' ? '🟡' : '🔴';

  let improveScore = 50;
  const factors = [];

  if (reports.length >= 3) {
    const recentAvg = reports.slice(-3).reduce((s,r) => s + r.score, 0) / 3;
    const olderAvg  = reports.slice(0,-3).reduce((s,r) => s + r.score, 0) / Math.max(reports.length - 3, 1);
    const momentum  = recentAvg - olderAvg;
    const impact    = Math.min(Math.abs(momentum) * 8, 25);
    if (momentum > 0)       { improveScore += impact; factors.push(`Score trending up +${momentum.toFixed(1)} pts recently`); }
    else if (momentum < 0)  { improveScore -= impact; factors.push(`Score trending down ${momentum.toFixed(1)} pts recently`); }
  }

  const overallDiff = reports[reports.length-1].score - reports[0].score;
  if (overallDiff > 0)      { improveScore += Math.min(overallDiff * 4, 15); factors.push(`Overall score improved +${overallDiff.toFixed(1)} pts`); }
  else if (overallDiff < 0) { improveScore -= Math.min(Math.abs(overallDiff) * 4, 15); factors.push(`Overall score dropped ${overallDiff.toFixed(1)} pts`); }

  const sd = (n, d) => d === 0 ? 0 : Math.round(n / d * 100);
  const firstTot  = (reports[0].friendly||0)+(reports[0].neutral||0)+(reports[0].unfriendly||0)||1;
  const latestTot = (reports[reports.length-1].friendly||0)+(reports[reports.length-1].neutral||0)+(reports[reports.length-1].unfriendly||0)||1;
  const uFirst = sd(reports[0].unfriendly||0, firstTot);
  const uLast  = sd(reports[reports.length-1].unfriendly||0, latestTot);
  const uDelta = uLast - uFirst;
  if (uDelta < -3)      { improveScore += Math.min(Math.abs(uDelta) * 1.5, 15); factors.push(`Unfriendly messages decreasing (${uFirst}% to ${uLast}%)`); }
  else if (uDelta > 3)  { improveScore -= Math.min(uDelta * 1.5, 15); factors.push(`Unfriendly messages rising (${uFirst}% to ${uLast}%)`); }

  const flagFirst  = reports[0].flagged_count || 0;
  const flagLatest = reports[reports.length-1].flagged_count || 0;
  if (flagLatest < flagFirst && flagFirst > 0)  { improveScore += 8;  factors.push(`Flagged messages down (${flagFirst} to ${flagLatest})`); }
  else if (flagLatest > flagFirst * 1.3)         { improveScore -= 10; factors.push(`Flagged messages spiking (${flagFirst} to ${flagLatest})`); }

  const latestTox = (() => {
    try { return typeof reports[reports.length-1].toxicity_types === 'string' ? JSON.parse(reports[reports.length-1].toxicity_types) : (reports[reports.length-1].toxicity_types || {}); }
    catch { return {}; }
  })();
  const severeTypes = ['harassment', 'threats', 'hate_speech', 'bullying'];
  const severeCount = severeTypes.reduce((s, k) => s + (latestTox[k]||0), 0);
  if (severeCount === 0)    { improveScore += 8;  factors.push('No severe toxicity in latest report'); }
  else if (severeCount > 5) { improveScore -= 12; factors.push(`High severe toxicity (${severeCount} instances) in latest report`); }
  else                      { improveScore -= 5;  factors.push(`Some severe toxicity (${severeCount} instances) in latest report`); }

  improveScore = Math.min(Math.max(Math.round(improveScore), 5), 95);
  const worsenScore = 100 - improveScore;
  const improveTrend = improveScore >= 70 ? '📈' : improveScore >= 50 ? '🟡' : '📉';
  const worsenTrend  = worsenScore >= 50 ? '⚠️' : '✅';

  return { improveChance: improveScore, worsenChance: worsenScore, confidence, confidenceEmoji, factors, improveTrend, worsenTrend };
}

// ============================================================
// AI ANALYSIS
// ============================================================

async function analyzeMessages(messages, channelNames, sensitivity, timeframeLabel) {
  let msgs = messages;
  if (msgs.join(' ').length > CONFIG.MAX_OPENAI_CHARS) {
    msgs = msgs.slice(0, Math.floor(msgs.length * CONFIG.MAX_OPENAI_CHARS / msgs.join(' ').length));
  }
  const count = msgs.length;
  const sensitivityPrompt = SENSITIVITY_PROMPTS[sensitivity] || SENSITIVITY_PROMPTS.medium;

  const prompt = `You are Vibe Check Bot, a community health analyzer that uses positive psychology principles.

${sensitivityPrompt}

Analyze these ${count} messages from ${channelNames.join(', ')} (last ${timeframeLabel}).

ANALYSIS RULES:
- sentiment counts (friendly + neutral + unfriendly) MUST add up to exactly ${count}
- Flag ALL unfriendly messages — do not limit
- Understand messages in ANY language

RECOMMENDATION RULES — CRITICAL:
- Write recommendations using POSITIVE PSYCHOLOGY principles only
- Focus on what the community is doing WELL and how to amplify it
- Suggest celebrating positive contributors, creating belonging, building shared identity
- Recommend community rituals, recognition systems, shared goals, positive spotlights
- NEVER suggest bans, warnings, mutes, punishments, threats or disciplinary actions
- Frame everything as an opportunity for growth, not a problem to fix
- Use language that is warm, encouraging and strengths-based

MESSAGES:
${msgs.map((m,i) => `${i+1}. ${m}`).join('\n')}

Respond ONLY with this exact JSON (no markdown):
{
  "friendlinessScore": <0-10 number>,
  "sentiment": { "friendly": <int>, "neutral": <int>, "unfriendly": <int> },
  "flaggedMessages": [{ "message": "<text>", "type": "<insult|harassment|threat|hate_speech|bullying|profanity|spam|other>", "severity": <1-10> }],
  "toxicityTypes": { "insults": <n>, "harassment": <n>, "threats": <n>, "hate_speech": <n>, "bullying": <n>, "profanity": <n>, "spam": <n> },
  "communityStrengths": "<1-2 sentences about what the community is doing well>",
  "recommendation": "<2-3 specific positive-psychology-based suggestions to grow community health>",
  "summary": "<1 sentence overall verdict>"
}`;

  const t0 = Date.now();
  let resp;
  for (let a = 1; a <= 3; a++) {
    try {
      resp = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.2, max_tokens: 2000 });
      break;
    } catch (e) {
      if (a === 3 || !(e.status === 429 || e.status >= 500)) throw e;
      await new Promise(r => setTimeout(r, a * 2000));
    }
  }

  const usage = resp.usage;
  const cost  = (usage.prompt_tokens/1e6)*CONFIG.COST_PER_1M_INPUT_TOKENS + (usage.completion_tokens/1e6)*CONFIG.COST_PER_1M_OUTPUT_TOKENS;
  let result  = JSON.parse(resp.choices[0].message.content.trim());
  result.friendlinessScore = Math.min(Math.max(Number(result.friendlinessScore)||0, 0), 10);

  const st = result.sentiment.friendly + result.sentiment.neutral + result.sentiment.unfriendly;
  if (st !== count) {
    const scale = count / st;
    result.sentiment.friendly   = Math.round(result.sentiment.friendly   * scale);
    result.sentiment.neutral    = Math.round(result.sentiment.neutral    * scale);
    result.sentiment.unfriendly = count - result.sentiment.friendly - result.sentiment.neutral;
  }

  return { result, analyzedCount: count, processingTime: Date.now()-t0, cost, inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens };
}

// ============================================================
// HELPERS
// ============================================================

function scoreBar(s)   { const f = Math.round(s); return '█'.repeat(f) + '░'.repeat(10-f); }
function scoreColor(s) { return s >= 7 ? 0x22c55e : s >= 4 ? 0xf59e0b : 0xef4444; }
function scoreEmoji(s) { return s >= 8 ? '🟢' : s >= 5 ? '🟡' : '🔴'; }
function scoreLabel(s) { return s >= 8 ? 'Excellent' : s >= 6 ? 'Good' : s >= 4 ? 'Needs Attention' : 'Poor'; }

// ============================================================
// BUILD /vibe EMBEDS
// ============================================================

function buildVibeEmbeds(result, analyzedCount, channelNames, timeframeLabel, sensitivity, remaining, isPaidServer, reactions, isPublic, channelMsgCounts, channelResults, memberCount) {
  const score = result.friendlinessScore;
  const { friendly, neutral, unfriendly } = result.sentiment;
  const total = friendly + neutral + unfriendly || 1;
  const fp = Math.round(friendly   / total * 100);
  const np = Math.round(neutral    / total * 100);
  const up = Math.round(unfriendly / total * 100);
  const isMultiChannel = channelNames.length > 1;
  const chDisplay = isMultiChannel ? channelNames.join(', ') : channelNames[0];

  const embed1 = new EmbedBuilder()
    .setColor(scoreColor(score))
    .setTitle(isMultiChannel ? '📊 Multi-Channel Vibe Report' : '📊 Community Vibe Report')
    .setDescription(
      `**${chDisplay}** • Last ${timeframeLabel} • ${analyzedCount} messages • Sensitivity: **${sensitivity.charAt(0).toUpperCase()+sensitivity.slice(1)}**\n\n` +
      `\`\`\`\n${scoreEmoji(score)}  FRIENDLINESS SCORE: ${score} / 10  — ${scoreLabel(score).toUpperCase()}\n\`\`\`\n` +
      `\`${scoreBar(score)}\``
    )
    .addFields({ name: '📋 Server Info', value: `👥 Members: **${memberCount||'—'}**`, inline: false });

  if (result.communityStrengths) embed1.addFields({ name: '✨ Community Strengths', value: result.communityStrengths, inline: false });
  if (result.summary)            embed1.addFields({ name: '🗒️ Vibe Verdict',         value: result.summary,            inline: false });
  if (result.recommendation)    embed1.addFields({ name: '💡 Recommendations',       value: result.recommendation,    inline: false });
  embed1.addFields({ name: '🔧 Need Help?', value: `📧 **${CONFIG.CONTACT_EMAIL}**`, inline: false });
  embed1.setFooter({ text: `Vibe Check Bot • ${isPaidServer?'⚡ Pro':'🎁 Free Trial'} • ${remaining} ${remaining===1?'report':'reports'} remaining • Sensitivity: ${sensitivity}` });

  const embed2 = new EmbedBuilder().setColor(0xf97316).setTitle('🧪 Toxicity Breakdown');
  if (isPublic) {
    const fc = result.flaggedMessages?.length || 0;
    embed2.setDescription(fc > 0 ? `**${fc} flagged messages** detected.` : '✅ No harmful content detected.');
    if (fc > 0 && result.toxicityTypes) {
      const tb = Object.entries(result.toxicityTypes).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`• ${k}: ${v}`).join('\n');
      if (tb) embed2.addFields({ name: 'Types', value: tb.substring(0,1024), inline: false });
    }
  } else {
    if (result.toxicityTypes) {
      const types = Object.entries(result.toxicityTypes).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]);
      if (types.length > 0) {
        const mv = types[0][1] || 1;
        embed2.addFields({ name: 'Breakdown', value: types.map(([k,v])=>`\`${'█'.repeat(Math.round(v/mv*8))}${'░'.repeat(8-Math.round(v/mv*8))}\` **${k}**: ${v}`).join('\n'), inline: false });
      } else {
        embed2.setDescription('✅ No toxicity detected.');
      }
    }
    if (result.flaggedMessages?.length > 0) {
      const list = result.flaggedMessages.sort((a,b)=>b.severity-a.severity).slice(0,10)
        .map(f=>`• [\`${f.type}\` ${f.severity}/10] ${f.message.substring(0,80)}${f.message.length>80?'...':''}`).join('\n');
      embed2.addFields({ name: `⚠️ Flagged Messages (${result.flaggedMessages.length})`, value: list.substring(0,1024), inline: false });
      if (result.flaggedMessages.length > 10) embed2.addFields({ name: '', value: `_...and ${result.flaggedMessages.length-10} more in the email report_`, inline: false });
    } else {
      embed2.addFields({ name: '✅ No Flagged Messages', value: 'No harmful content detected.', inline: false });
    }
  }
  if (!isPublic && result.toxicityTypes) {
    const tUrl = toxBarChart(result.toxicityTypes, 'Toxicity Types');
    if (tUrl) embed2.setImage(tUrl);
  }

  let embed3 = null;
  if (isMultiChannel) {
    embed3 = new EmbedBuilder().setColor(0x8b5cf6).setTitle(`⚡ Impact Score: ${score}/10`);
    embed3.setDescription(`The Impact Score is the **weighted average** across all channels, based on message volume.\nChannels where members spend more time have greater influence on this score.`);
    embed3.addFields({
      name: 'Per-Channel Breakdown',
      value: channelNames.map(ch => {
        const r = channelResults[ch]; if (!r) return `${ch} — not enough data`;
        const s = r.result.friendlinessScore;
        return `${s>=7?'🟢':s>=4?'🟡':'🔴'} **${ch}** \`${scoreBar(s)}\`  **${s}/10** (${channelMsgCounts[ch]||0} msgs)`;
      }).join('\n'),
      inline: false
    });
  }

  const embed4 = new EmbedBuilder()
    .setColor(scoreColor(score))
    .setTitle('💬 Sentiment Breakdown')
    .addFields({
      name: 'Message Breakdown',
      value:
        `🟢 Friendly   \`${String(friendly).padStart(4)}\`  **${fp}%**\n` +
        `⚪ Neutral     \`${String(neutral).padStart(4)}\`  **${np}%**\n` +
        `🔴 Unfriendly \`${String(unfriendly).padStart(4)}\`  **${up}%**`,
      inline: false
    })
    .setImage(pieChart(friendly, neutral, unfriendly));

  let embed5 = null;
  if (reactions && !isPublic && (reactions.mostReacted || reactions.mostPositive || reactions.mostNegative)) {
    embed5 = new EmbedBuilder().setColor(0x6366f1).setTitle('💬 Most Reacted Messages');
    const lines = [];
    if (reactions.mostReacted)  lines.push(`⭐ **Most reacted:** "${reactions.mostReacted.text}" — ${reactions.mostReacted.reactions}`);
    if (reactions.mostPositive) lines.push(`👍 **Most positive:** "${reactions.mostPositive.text}" — ${reactions.mostPositive.reactions}`);
    if (reactions.mostNegative) lines.push(`👎 **Most negative:** "${reactions.mostNegative.text}" — ${reactions.mostNegative.reactions}`);
    embed5.setDescription(lines.join('\n'));
  }

  const embeds = [embed1, embed2];
  if (embed3) embeds.push(embed3);
  embeds.push(embed4);
  if (embed5) embeds.push(embed5);
  return embeds;
}

// ============================================================
// SAVE + LOG + EMAILS
// ============================================================

async function saveReport(serverId, serverName, channelNames, score, sentiment, flaggedCount, sensitivity, timeframe, analyzedCount, toxicityTypes) {
  try {
    await supabase.from('reports').insert({
      server_id: serverId, server_name: serverName, channel_name: channelNames.join(', '),
      score, friendly: sentiment.friendly, neutral: sentiment.neutral, unfriendly: sentiment.unfriendly,
      flagged_count: flaggedCount, sensitivity, timeframe, messages_analyzed: analyzedCount,
      toxicity_types: JSON.stringify(toxicityTypes||{}), created_at: new Date().toISOString()
    });
  } catch (e) { console.error('Save report error:', e.message); }
}

async function logResearchData(data) {
  try {
    const rows = data.channelNames.map(ch => {
      const r = data.channelResults?.[ch];
      return {
        server_name: data.serverName, server_id: data.serverId, member_count: data.memberCount,
        channel_name: ch, messages_analyzed: r ? r.analyzedCount : data.analyzedCount,
        score: r ? r.result.friendlinessScore : data.score,
        friendly:    r ? r.result.sentiment.friendly    : 0,
        neutral:     r ? r.result.sentiment.neutral     : 0,
        unfriendly:  r ? r.result.sentiment.unfriendly  : 0,
        flagged_count: r ? (r.result.flaggedMessages?.length||0) : data.flaggedCount,
        toxicity_types: r ? (r.result.toxicityTypes||{}) : data.toxicityTypes,
        sensitivity: data.sensitivity, timeframe: data.timeframe, is_pro: data.isPro,
        input_tokens: data.inputTokens, output_tokens: data.outputTokens,
        cost_usd: data.cost, processing_time_ms: data.processingTime
      };
    });
    const { error } = await supabase.from('research_logs').insert(rows);
    if (error) console.error('Research log error:', error.message);
    else console.log(`Research logged: ${rows.length} channel(s), score ${data.score}`);
  } catch (e) { console.error('Research logging failed:', e.message); }
}

async function sendEmailReport(serverName, serverId, channelNames, result, analyzedCount, timeframe, sensitivity, remaining) {
  try {
    const fHtml = result.flaggedMessages?.length > 0
      ? result.flaggedMessages.sort((a,b)=>b.severity-a.severity).map(f=>`<li><strong>[${f.type} - ${f.severity}/10]</strong> ${f.message}</li>`).join('')
      : '<li>No flagged messages</li>';
    await resend.emails.send({
      from: 'Vibe Check Bot <noreply@vibecheckbot.com>', to: CONFIG.REPORT_EMAIL,
      subject: `Vibe Report — ${serverName} | Score: ${result.friendlinessScore}/10`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <h2 style="color:#F97316">Vibe Check Bot Report</h2>
        <p><strong>Server:</strong> ${serverName} (${serverId})</p>
        <p><strong>Channels:</strong> ${channelNames.join(', ')}</p>
        <p><strong>Score:</strong> ${result.friendlinessScore}/10 | <strong>Messages:</strong> ${analyzedCount}</p>
        <p>Friendly: ${result.sentiment.friendly} | Neutral: ${result.sentiment.neutral} | Unfriendly: ${result.sentiment.unfriendly}</p>
        <p>Flagged: ${result.flaggedMessages?.length||0} | Remaining: ${remaining}</p>
        <h3>Community Strengths</h3><p>${result.communityStrengths||'N/A'}</p>
        <h3>Recommendations</h3><p>${result.recommendation||'N/A'}</p>
        <h3>All Flagged Messages</h3><ul>${fHtml}</ul>
      </div>`
    });
  } catch (e) { console.error('Email error:', e.message); }
}

async function sendNewTrialEmail(serverName, serverId, userName) {
  try {
    await resend.emails.send({ from: 'Vibe Check Bot <noreply@vibecheckbot.com>', to: CONFIG.REPORT_EMAIL,
      subject: `New Free Trial: ${serverName}`,
      html: `<h2>New Free Trial</h2><p><strong>Server:</strong> ${serverName} (${serverId})</p><p><strong>By:</strong> ${userName}</p>`
    });
  } catch (e) { console.error('New trial email error:', e.message); }
}

async function sendTrialEndedEmail(serverName, serverId, userName) {
  try {
    await resend.emails.send({ from: 'Vibe Check Bot <noreply@vibecheckbot.com>', to: CONFIG.REPORT_EMAIL,
      subject: `Trial Ended: ${serverName}`,
      html: `<h2>Trial Ended</h2><p><strong>Server:</strong> ${serverName} (${serverId})</p><p><strong>By:</strong> ${userName}</p>`
    });
  } catch (e) { console.error('Trial ended email error:', e.message); }
}

// ============================================================
// REGISTER COMMANDS
// ============================================================

async function registerCommands() {
  const vibe = new SlashCommandBuilder().setName('vibe').setDescription('Check the friendliness of one or more channels')
    .addChannelOption(o=>o.setName('channel') .setDescription('Channel to analyze (default: current)').setRequired(false).addChannelTypes(ChannelType.GuildText))
    .addChannelOption(o=>o.setName('channel2').setDescription('2nd channel').setRequired(false).addChannelTypes(ChannelType.GuildText))
    .addChannelOption(o=>o.setName('channel3').setDescription('3rd channel').setRequired(false).addChannelTypes(ChannelType.GuildText))
    .addChannelOption(o=>o.setName('channel4').setDescription('4th channel').setRequired(false).addChannelTypes(ChannelType.GuildText))
    .addChannelOption(o=>o.setName('channel5').setDescription('5th channel').setRequired(false).addChannelTypes(ChannelType.GuildText))
    .addStringOption(o=>o.setName('timeframe').setDescription('How far back (default: 7d)').setRequired(false).addChoices(
      {name:'1 hour',value:'1h'},{name:'24 hours',value:'24h'},{name:'7 days',value:'7d'},{name:'14 days',value:'14d'},{name:'30 days',value:'30d'}))
    .addStringOption(o=>o.setName('sensitivity').setDescription('Analysis strictness (default: medium)').setRequired(false).addChoices(
      {name:'🎮 Low — Gaming/Adult',value:'low'},{name:'⚖️ Medium — General',value:'medium'},{name:'👶 High — Kids/Family',value:'high'}))
    .addStringOption(o=>o.setName('visibility').setDescription('Who sees the report (default: private)').setRequired(false).addChoices(
      {name:'🔒 Private — only you',value:'private'},{name:'📢 Public — everyone',value:'public'}))
    .addIntegerOption(o=>o.setName('messages').setDescription('Messages per channel (default: 100)').setRequired(false).addChoices(
      {name:'50',value:50},{name:'100',value:100},{name:'250',value:250},{name:'500',value:500},{name:'1000 (Pro)',value:1000}));

  const progress = new SlashCommandBuilder().setName('vibe-progress').setDescription('Track your community friendliness over time')
    .addStringOption(o=>o.setName('range').setDescription('Reports to show (default: 10)').setRequired(false).addChoices(
      {name:'Last 5',value:'5'},{name:'Last 10',value:'10'},{name:'Last 20',value:'20'},{name:'Last 30 days',value:'30d'}))
    .addChannelOption(o=>o.setName('channel') .setDescription('Filter by channel').setRequired(false).addChannelTypes(ChannelType.GuildText))
    .addChannelOption(o=>o.setName('channel2').setDescription('Compare channel 2').setRequired(false).addChannelTypes(ChannelType.GuildText))
    .addChannelOption(o=>o.setName('channel3').setDescription('Compare channel 3').setRequired(false).addChannelTypes(ChannelType.GuildText));

  const admin = new SlashCommandBuilder().setName('vibe-admin').setDescription('Admin controls (owner only)')
    .addStringOption(o=>o.setName('action').setDescription('Action').setRequired(true).addChoices(
      {name:'🧪 Test — extra free reports',value:'test'},
      {name:'👥 Tester — unlimited 2 weeks',value:'tester'},
      {name:'❌ Remove Tester',value:'tester_off'},
      {name:'⚡ Pro — activate',value:'pro'},
      {name:'🔴 Pro Off — deactivate',value:'pro_off'}))
    .addStringOption(o=>o.setName('server_id').setDescription('Server ID').setRequired(true))
    .addIntegerOption(o=>o.setName('reports').setDescription('Extra reports (Test only)').setRequired(false));

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [vibe.toJSON(), progress.toJSON(), admin.toJSON()] });
    console.log('✅ Commands registered');
  } catch (e) { console.error('Failed to register commands:', e); }
}

// ============================================================
// BOT READY + GUILD EVENTS
// ============================================================

client.once('clientReady', c => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🚀 Vibe Check Bot 2.4 is online: ${c.user.tag}`);
  console.log(`   Servers: ${c.guilds.cache.size}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  registerCommands();
});

client.on('guildCreate', async guild => {
  console.log(`Joined: ${guild.name}`);
  try {
    const ch = guild.systemChannel || guild.channels.cache.find(c => c.type===ChannelType.GuildText && c.permissionsFor(guild.members.me)?.has('SendMessages'));
    if (!ch) return;
    await ch.send({ embeds: [new EmbedBuilder().setColor(0xF97316).setTitle('👋 Vibe Check Bot has arrived!')
      .setDescription('Use `/vibe` to check how friendly your community is.\n\nAnalyze multiple channels:\n`/vibe channel:#general channel2:#gaming`')
      .addFields({name:'🎮 Low',value:'Gaming/Adult',inline:true},{name:'⚖️ Medium',value:'General',inline:true},{name:'👶 High',value:'Kids/Family',inline:true})
      .setFooter({text:'How friendly is your community?'})] });
  } catch (e) { console.error('guildCreate error:', e.message); }
});

client.on('guildDelete', g => console.log(`Removed from: ${g.name} (${g.id})`));

// ============================================================
// INTERACTIONS
// ============================================================

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isButton() && interaction.customId === 'view_progress') {
      await handleProgressCommand(interaction, '10', []);
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'vibe')          { await handleVibeCommand(interaction);    return; }
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
    if (interaction.commandName === 'vibe-admin') { await handleAdminCommand(interaction); return; }

  } catch (err) {
    console.error('Interaction error:', err);
    try {
      const msg = { content: '❌ Something went wrong. Please try again.', flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) await interaction.followUp(msg);
      else await interaction.reply(msg);
    } catch {}
  }
});

// ============================================================
// /vibe HANDLER
// ============================================================

async function handleVibeCommand(interaction) {
  const serverId = interaction.guildId, serverName = interaction.guild.name;

  if (isOnCooldown(interaction.user.id)) return interaction.reply({ content: `Please wait ${CONFIG.COOLDOWN_SECONDS}s between reports.`, flags: MessageFlags.Ephemeral });
  if (isServerThrottled(serverId))       return interaction.reply({ content: `Too many reports at once. Wait a minute.`,               flags: MessageFlags.Ephemeral });
  incrementServerThrottle(serverId);

  const visibility   = interaction.options.getString('visibility')  || 'private';
  const sensitivity  = interaction.options.getString('sensitivity') || 'medium';
  const timeframe    = interaction.options.getString('timeframe')   || '7d';
  const isPrivate    = visibility === 'private';
  const serverIsPaid = await isPaid(serverId);
  const tester       = await isTester(serverId);

  const rawChs = [
    interaction.options.getChannel('channel') || interaction.channel,
    interaction.options.getChannel('channel2'),
    interaction.options.getChannel('channel3'),
    interaction.options.getChannel('channel4'),
    interaction.options.getChannel('channel5')
  ].filter(Boolean);
  const seen = new Set();
  const channels = rawChs.filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true; });

  let msgCount = interaction.options.getInteger('messages') || 100;
  if (!serverIsPaid && !tester && msgCount > CONFIG.FREE_MAX_MESSAGES) msgCount = CONFIG.FREE_MAX_MESSAGES;

  if (!tester && !(await canUseBot(serverId))) {
    if (serverIsPaid) {
      const {data:ud} = await supabase.from('usage').select('month_start').eq('server_id',serverId).single();
      const dLeft = Math.max(1, Math.ceil(30 - ((Date.now() - new Date(ud?.month_start||Date.now()).getTime()) / 86400000)));
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xf59e0b).setTitle('Monthly Limit Reached').setDescription(`All ${CONFIG.PRO_REPORTS_PER_MONTH} reports used. Resets in **${dLeft} day${dLeft===1?'':'s'}**.`)], flags: MessageFlags.Ephemeral });
    } else {
      await sendTrialEndedEmail(serverName, serverId, interaction.user.tag);
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xf59e0b).setTitle('Free Trial Ended').setDescription(`All **${CONFIG.FREE_REPORTS}** free reports used.`)
          .addFields({name:'Upgrade to Pro',value:`30 reports/month • Multi-channel`},{name:'Monthly',value:`[$8.99/mo](${CONFIG.STRIPE_MONTHLY_LINK})`,inline:true},{name:'Yearly',value:`[$99/yr](${CONFIG.STRIPE_YEARLY_LINK})`,inline:true})],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('Get Pro Monthly').setStyle(ButtonStyle.Link).setURL(CONFIG.STRIPE_MONTHLY_LINK),
          ...(CONFIG.YEARLY_ENABLED ? [new ButtonBuilder().setLabel('Get Pro Yearly').setStyle(ButtonStyle.Link).setURL(CONFIG.STRIPE_YEARLY_LINK)] : [])
        )],
        flags: MessageFlags.Ephemeral
      });
    }
  }

  await interaction.deferReply({ flags: isPrivate ? MessageFlags.Ephemeral : 0 });
  setCooldown(interaction.user.id);

  try {
    const timeMs    = {'1h':3600000,'24h':86400000,'7d':604800000,'14d':1209600000,'30d':2592000000}[timeframe]||604800000;
    const timeLabel = {'1h':'1 hour','24h':'24 hours','7d':'7 days','14d':'14 days','30d':'30 days'}[timeframe]||'7 days';
    const mpc = Math.floor(msgCount / channels.length);

    const cached = {}, channelNames = [], chMsgCounts = {};
    for (const ch of channels) {
      if (!canReadChannel(interaction.guild, ch)) return interaction.editReply(`No permission to read **#${ch.name}**.`);
      const msgs = await fetchChannelMessages(ch, mpc, timeMs);
      const n = `#${ch.name}`; cached[n] = msgs; chMsgCounts[n] = msgs.length; channelNames.push(n);
    }

    if (Object.values(cached).reduce((s,m) => s+m.length, 0) < 5) {
      return interaction.editReply('Not enough messages. Need at least 5 in the selected timeframe. Try a longer timeframe.');
    }

    const channelResults = {};
    let totTime=0, totCost=0, totIn=0, totOut=0, totAnalyzed=0;
    for (const ch of channels) {
      const n = `#${ch.name}`, msgs = cached[n]||[];
      if (msgs.length < 2) { channelResults[n] = null; continue; }
      const r = await analyzeMessages(msgs, [n], sensitivity, timeLabel);
      channelResults[n] = r;
      totTime += r.processingTime||0; totCost += r.cost||0; totIn += r.inputTokens||0; totOut += r.outputTokens||0; totAnalyzed += r.analyzedCount||0;
    }

    const valid = Object.entries(channelResults).filter(([,r]) => r !== null);
    if (!valid.length) return interaction.editReply('Not enough messages in any channel. Try a longer timeframe.');

    const tw     = valid.reduce((s,[,r]) => s + r.analyzedCount, 0) || 1;
    const impact = parseFloat((valid.reduce((s,[,r]) => s + r.result.friendlinessScore * r.analyzedCount, 0) / tw).toFixed(1));

    const cSent = {friendly:0,neutral:0,unfriendly:0}, cTox = {}, cFlagged = [];
    let cStrengths = '', cRec = '', cSummary = '';
    for (const [,r] of valid) {
      cSent.friendly   += r.result.sentiment.friendly   || 0;
      cSent.neutral    += r.result.sentiment.neutral    || 0;
      cSent.unfriendly += r.result.sentiment.unfriendly || 0;
      if (r.result.toxicityTypes) Object.entries(r.result.toxicityTypes).forEach(([k,v]) => { cTox[k] = (cTox[k]||0)+(v||0); });
      if (r.result.flaggedMessages) cFlagged.push(...r.result.flaggedMessages);
    }
    const worst = [...valid].sort((a,b) => a[1].result.friendlinessScore - b[1].result.friendlinessScore)[0];
    if (valid.length > 1) {
      cStrengths = valid.filter(([,r]) => r.result.communityStrengths).map(([n,r]) => `${n}: ${r.result.communityStrengths}`).join(' ');
      cRec       = `Focus growth energy on ${worst[0]} (${worst[1].result.friendlinessScore}/10). ${worst[1].result.recommendation||''}`;
      cSummary   = `Impact score across ${valid.length} channels: ${impact}/10. ${worst[0]} has the most opportunity for growth.`;
    } else {
      cStrengths = valid[0][1].result.communityStrengths || '';
      cRec       = valid[0][1].result.recommendation     || '';
      cSummary   = valid[0][1].result.summary            || '';
    }

    const result = {
      friendlinessScore: impact,
      sentiment: cSent,
      flaggedMessages: cFlagged.sort((a,b)=>b.severity-a.severity).slice(0,10),
      toxicityTypes: cTox,
      communityStrengths: cStrengths,
      recommendation: cRec,
      summary: cSummary
    };

    const reactions = await getChannelStats(interaction.guild, channels[0]);
    await incrementUsage(serverId);
    const remaining = await getReportsRemaining(serverId);

    const embeds  = buildVibeEmbeds(result, totAnalyzed, channelNames, timeLabel, sensitivity, remaining, serverIsPaid, reactions, !isPrivate, chMsgCounts, channelResults, interaction.guild.memberCount);
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('📧 Request Tools').setStyle(ButtonStyle.Link).setURL('https://www.felixagaming.com/vibe'),
      new ButtonBuilder().setLabel('📈 View Progress').setStyle(ButtonStyle.Primary).setCustomId('view_progress')
    );
    if (!serverIsPaid && !tester) buttons.addComponents(new ButtonBuilder().setLabel('⚡ Upgrade to Pro').setStyle(ButtonStyle.Link).setURL(CONFIG.STRIPE_MONTHLY_LINK));

    await interaction.editReply({ embeds, components: [buttons] });

    await saveReport(serverId, serverName, channelNames, result.friendlinessScore, result.sentiment, result.flaggedMessages?.length||0, sensitivity, timeframe, totAnalyzed, result.toxicityTypes);
    await logResearchData({ serverName, serverId, memberCount: interaction.guild.memberCount, channelNames, channelResults, analyzedCount: totAnalyzed, score: result.friendlinessScore, sentiment: result.sentiment, flaggedCount: result.flaggedMessages?.length||0, toxicityTypes: result.toxicityTypes, sensitivity, timeframe, isPro: serverIsPaid, inputTokens: totIn, outputTokens: totOut, cost: totCost, processingTime: totTime });
    await sendEmailReport(serverName, serverId, channelNames, result, totAnalyzed, timeLabel, sensitivity, remaining);

    const usedNow = await getReportsUsed(serverId);
    if (usedNow === 1) await sendNewTrialEmail(serverName, serverId, interaction.user.tag);

    if (usedNow % 5 === 0 && usedNow > 0) {
      await interaction.followUp({
        embeds: [new EmbedBuilder().setColor(0xA78BFA).setDescription(`🎉 **${usedNow} reports** done! Track your community's growth.`)],
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('📈 View Progress').setStyle(ButtonStyle.Primary).setCustomId('view_progress'))],
        flags: MessageFlags.Ephemeral
      });
    }

    if (!serverIsPaid && !tester && remaining > 0 && remaining <= 2) {
      await interaction.followUp({ embeds: [new EmbedBuilder().setColor(0xf59e0b).setDescription(`Only **${remaining}** free ${remaining===1?'report':'reports'} left. [Get Pro](${CONFIG.STRIPE_MONTHLY_LINK}).`)], flags: MessageFlags.Ephemeral });
    }

    if (serverIsPaid) {
      const sub = await getSubscriptionStatus(serverId);
      if (sub.isActive && sub.daysLeft <= 7) {
        await interaction.followUp({
          embeds: [new EmbedBuilder().setColor(0xf59e0b).setTitle('Subscription Expiring Soon').setDescription(`Pro expires in **${sub.daysLeft} day${sub.daysLeft===1?'':'s'}**.`)],
          components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Renew Monthly').setStyle(ButtonStyle.Link).setURL(CONFIG.STRIPE_MONTHLY_LINK))],
          flags: MessageFlags.Ephemeral
        });
      }
    }

  } catch (err) {
    console.error('Vibe error:', err);
    try { await interaction.editReply('Something went wrong. Please try again.'); } catch {}
  }
}

// ============================================================
// /vibe-progress HANDLER
// ============================================================

async function handleProgressCommand(interaction, range, filterChannels) {
  const serverId = interaction.guildId;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    let q = supabase.from('reports').select('*').eq('server_id', serverId).order('created_at', { ascending: false });
    if (range === '30d') q = q.gte('created_at', new Date(Date.now()-30*86400000).toISOString());
    else q = q.limit(parseInt(range)||10);

    const { data: reports, error } = await q;
    if (error || !reports?.length) return interaction.editReply('No reports found. Run `/vibe` first.');

    const sorted = [...reports].reverse();
    let filtered = sorted, filterLabel = '';
    if (filterChannels?.length === 1) {
      const n = `#${filterChannels[0].name}`;
      filtered = sorted.filter(r => r.channel_name?.includes(n));
      filterLabel = ` • ${n}`;
      if (!filtered.length) return interaction.editReply(`No reports for ${n}. Run /vibe there first.`);
    }

    const latest = filtered[filtered.length-1];
    const oldest = filtered[0];
    const avg    = (filtered.reduce((s,r) => s+r.score, 0) / filtered.length).toFixed(1);
    const diff   = parseFloat((latest.score - oldest.score).toFixed(1));
    const arrow  = diff > 0 ? `📈 +${diff}` : diff < 0 ? `📉 ${diff}` : '➡️ Stable';

    const sd = (n,d) => d===0?0:Math.round(n/d*100);
    const ot = (oldest.friendly||0)+(oldest.neutral||0)+(oldest.unfriendly||0)||1;
    const nt = (latest.friendly||0)+(latest.neutral||0)+(latest.unfriendly||0)||1;
    const fFirst=sd(oldest.friendly||0,ot), fLast=sd(latest.friendly||0,nt);
    const uFirst=sd(oldest.unfriendly||0,ot), uLast=sd(latest.unfriendly||0,nt);
    const fDelta=fLast-fFirst, uDelta=uLast-uFirst;

    const toxMap = {};
    filtered.forEach(r => {
      try { const t=typeof r.toxicity_types==='string'?JSON.parse(r.toxicity_types):r.toxicity_types; if(t)Object.entries(t).forEach(([k,v])=>{toxMap[k]=(toxMap[k]||0)+(v||0);}); } catch {}
    });
    const toxEntries = Object.entries(toxMap).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]);

    const fFlag = oldest.flagged_count||0, lFlag = latest.flagged_count||0;
    const prob  = calcBehaviorProbability(filtered);

    const trendText = (() => {
      if (filtered.length < 2) return 'Only one report so far — run `/vibe` again to start tracking trends.';
      if (diff >= 2)    return `🚀 **Major improvement!** Score up **+${diff} pts**. Your community is flourishing.`;
      if (diff >= 0.5)  return `📈 **Trending upward** (+${diff} pts). Positive momentum — your community is growing stronger.`;
      if (diff === 0)   return `➡️ **Stable** at ${latest.score}/10. Community health is consistent.`;
      if (diff >= -0.5) return `⚠️ **Slight dip** (${diff} pts). A great time to amplify what's working well.`;
      if (diff >= -2)   return `📉 **Declining** (${diff} pts). Focus on celebrating positive interactions to shift energy.`;
      return `🚨 **Significant drop** (${diff} pts). Now is the time to spotlight positive members and reinvigorate the community.`;
    })();

    const healthLines = [];
    if (latest.score >= 8)      healthLines.push(`✨ **Thriving** — Your community is in excellent health at ${latest.score}/10.`);
    else if (latest.score >= 6) healthLines.push(`👍 **Healthy** — Generally positive at ${latest.score}/10.`);
    else if (latest.score >= 4) healthLines.push(`⚠️ **Mixed** — Score of ${latest.score}/10 shows room to grow.`);
    else                         healthLines.push(`🚨 **Needs attention** — Score of ${latest.score}/10. Time to invest in community building.`);

    if (fLast >= 70)      healthLines.push(`🟢 **${fLast}% friendly** — your community is warm and welcoming.`);
    else if (fLast >= 50) healthLines.push(`🟡 **${fLast}% friendly** — mostly positive with room to grow.`);
    else                   healthLines.push(`🔴 **Only ${fLast}% friendly** — there is a great opportunity to build more connection and belonging.`);

    if (diff > 0)       healthLines.push(`📈 Score improved **+${diff} pts** since first report — your community is on an upward journey.`);
    else if (diff < 0)  healthLines.push(`📉 Score down **${diff} pts** — this is an invitation to reinvest in what makes your community special.`);
    if (toxEntries.length > 0) healthLines.push(`⚠️ Most common issue: **${toxEntries[0][0]}** (${toxEntries[0][1]} instances) — see toxicity section below.`);

    const e1 = new EmbedBuilder()
      .setColor(latest.score>=7?0x22c55e:latest.score>=4?0xf59e0b:0xef4444)
      .setTitle(`📈 Progress Report — ${interaction.guild.name}`)
      .setDescription(`**${filtered.length} report${filtered.length===1?'':'s'}**${filterLabel}  •  Oldest: **${oldest.score}/10** → Latest: **${latest.score}/10** •  ${arrow}\nAverage: **${avg}/10**`)
      .addFields(
        { name: '🎯 Trend Analysis',   value: trendText,               inline: false },
        { name: '🔍 Community Health', value: healthLines.join('\n'), inline: false }
      )
      .setImage(scoreLineChart(filtered))
      .setFooter({ text: `Vibe Check Bot  •  ${filtered.length} reports  •  Run /vibe regularly to improve predictions` });

    const toxText = toxEntries.length > 0
      ? toxEntries.slice(0,6).map(([k,v]) => { const f=Math.round(v/(toxEntries[0][1]||1)*10); return `\`${'█'.repeat(f)}${'░'.repeat(10-f)}\` **${k}**: ${v}`; }).join('\n')
      : '✅ No toxicity detected across all reports';

    const e2 = new EmbedBuilder().setColor(0xf97316).setTitle('🧪 Cumulative Toxicity Breakdown')
      .addFields({ name: 'All Reports Combined', value: toxText, inline: false });
    const toxUrl2 = cumulativeToxChart(filtered);
    if (toxUrl2) e2.setImage(toxUrl2);

    const allChs  = [...new Set(sorted.map(r => r.channel_name).filter(Boolean))];
    const isMulti = allChs.length > 1;
    const e3 = new EmbedBuilder().setColor(0x8b5cf6).setTitle(isMulti ? '⚡ Impact Score Over Time' : '📊 Friendliness Score Over Time');
    if (isMulti) {
      e3.setDescription('The Impact Score reflects the weighted average across all channels, showing overall community health.');
      const perChLines = allChs.map(n => {
        const cr = sorted.filter(r => r.channel_name===n); if (!cr.length) return null;
        const cl=cr[cr.length-1].score, co=cr[0].score, cd=(cl-co).toFixed(1);
        return `${cl>=7?'🟢':cl>=4?'🟡':'🔴'} **${n}** \`${scoreBar(cl)}\`  **${cl}/10** ${cd>0?`📈 +${cd}`:cd<0?`📉 ${cd}`:'➡️'}`;
      }).filter(Boolean);
      if (perChLines.length) e3.addFields({ name: 'Per-Channel Latest Scores', value: perChLines.join('\n'), inline: false });
      e3.setImage(impactLineChart(filtered));
    } else {
      e3.setImage(scoreLineChart(filtered));
    }

    const e4 = new EmbedBuilder().setColor(0x22c55e).setTitle('💬 Sentiment Evolution')
      .addFields({
        name: 'Change Over Time',
        value:
          `🟢 Friendly:   **${fFirst}%** → **${fLast}%** (${fDelta>=0?'+':''}${fDelta}%)\n` +
          `🔴 Unfriendly: **${uFirst}%** → **${uLast}%** (${uDelta>=0?'+':''}${uDelta}%)`,
        inline: false
      })
      .setImage(sentimentStackedChart(filtered));

    const e5 = new EmbedBuilder().setColor(0xef4444).setTitle('🚩 Flagged Messages Trend')
      .addFields({
        name: 'Summary',
        value: `First report: **${fFlag}** flagged | Latest: **${lFlag}** flagged\n${lFlag<fFlag?`✅ Down ${fFlag-lFlag} — great progress`:lFlag>fFlag?`⚠️ Up ${lFlag-fFlag} — opportunity to reinforce positive norms`:'➡️ Stable'}`,
        inline: false
      })
      .setImage(flaggedLineChart(filtered));

    const predLines = [];
    if (filtered.length >= 3) {
      const ra = filtered.slice(-3).reduce((s,r)=>s+r.score,0)/3;
      const oa = filtered.slice(0,-3).reduce((s,r)=>s+r.score,0)/Math.max(filtered.length-3,1);
      const m  = ra-oa;
      if (m >= 1)        predLines.push(`📈 **Accelerating upward** — community energy is building. Expect continued improvement.`);
      else if (m >= 0)   predLines.push(`🟢 **Positive momentum** — health is stable and likely to improve.`);
      else if (m >= -1)  predLines.push(`🟡 **Slight downward drift** — a good moment to reinvigorate engagement with a community event or spotlight.`);
      else               predLines.push(`🔴 **Declining momentum** — investing in member recognition and shared goals now can shift this trend.`);
    }
    if (uDelta > 5)       predLines.push(`⚠️ **Unfriendly behavior rising** (${uFirst}% → ${uLast}%) — consider highlighting your most positive members to reset the tone.`);
    else if (uDelta < -5) predLines.push(`✅ **Positive behavior increasing** (${uFirst}% → ${uLast}%) — your community norms are strengthening.`);
    if (lFlag > fFlag*1.5 && lFlag > 2) predLines.push(`🚨 **Flagged messages spiking** — this is a signal to double down on celebrating what makes your community great.`);
    else if (lFlag === 0) predLines.push(`✨ **Zero harmful content** in latest report — your community standards are working beautifully.`);

    const recLines = [];
    if (diff < -0.5)     recLines.push(`💡 Score dipped — create a "community highlight" post celebrating your most positive recent conversations.`);
    else if (diff > 0.5) recLines.push(`🌟 Score is rising — keep the momentum by publicly recognizing the members who contribute most positively.`);
    else                  recLines.push(`🎯 Stable community — try a "spotlight of the week" feature to proactively reinforce the positive tone.`);

    if (fLast >= 70)      recLines.push(`🏆 **${fLast}% friendly** — your community has a strong foundation. Channel this energy into a shared goal or community challenge.`);
    else if (fLast >= 50) recLines.push(`🌱 Build on the **${fLast}% friendly** baseline by creating more opportunities for members to connect over shared interests.`);
    else                   recLines.push(`❤️ Focus on building **belonging** — small acts like welcoming new members publicly can shift community culture over time.`);

    if (toxEntries.length > 0) {
      const typeRec = {
        harassment: 'Shift attention by spotlighting respectful conversations — what gets celebrated gets repeated.',
        insults:    'Create a "kindness challenge" — invite members to share something they appreciate about the community.',
        hate_speech:'Build a stronger shared identity — when members feel proud of who they are together, exclusionary behavior naturally decreases.',
        spam:       'Low engagement often drives spam — try a community Q&A or AMA to spark genuine conversation.',
        threats:    'Build psychological safety by celebrating vulnerability and openness in conversations.',
        bullying:   'Empower bystanders — recognize members who stand up for others and create a culture of mutual support.',
        profanity:  'If this does not fit your community, model the tone you want to see rather than focusing on what you want to stop.'
      };
      recLines.push(`🔮 **For ${toxEntries[0][0]}:** ${typeRec[toxEntries[0][0]] || 'Focus on amplifying positive interactions to naturally crowd out negative ones.'}`);
    }

    const e6 = new EmbedBuilder().setColor(0x6366f1).setTitle('🔮 Behavior Forecast & Recommendations');
    if (prob) {
      const probText =
        `${prob.improveTrend} **${prob.improveChance}%** probability community improves\n` +
        `${prob.worsenTrend} **${prob.worsenChance}%** probability toxicity increases\n\n` +
        `${prob.confidenceEmoji} **Confidence: ${prob.confidence}** (based on ${filtered.length} reports)\n\n` +
        `**Why:**\n${prob.factors.map(f=>`• ${f}`).join('\n')}`;
      e6.addFields({ name: '📊 Probability Forecast', value: probText, inline: false });
    } else {
      e6.addFields({ name: '📊 Probability Forecast', value: 'Run at least 2 reports to see behavior probability forecasts.', inline: false });
    }
    if (predLines.length) e6.addFields({ name: '🔭 Predictions', value: predLines.join('\n'), inline: false });
    e6.addFields({ name: '💡 Positive Psychology Recommendations', value: recLines.join('\n'), inline: false });

    await interaction.editReply({ embeds: [e1, e2, e3, e4, e5, e6] });

  } catch (err) {
    console.error('Progress error:', err);
    try { await interaction.editReply('Something went wrong loading your progress report.'); } catch {}
  }
}

// ============================================================
// /vibe-admin HANDLER
// ============================================================

async function handleAdminCommand(interaction) {
  if (interaction.user.id !== CONFIG.OWNER_ID) return interaction.reply({ content: 'Owner only.', flags: MessageFlags.Ephemeral });
  const action = interaction.options.getString('action');
  const sid    = interaction.options.getString('server_id');
  const extra  = interaction.options.getInteger('reports') || 5;
  if (!/^\d{17,19}$/.test(sid)) return interaction.reply({ content: 'Invalid server ID.', flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  console.log(`ADMIN: ${action} on ${sid} by ${interaction.user.tag}`);
  try {
    if (action === 'tester') {
      const exp = new Date(Date.now()+14*86400000);
      await supabase.from('testers').upsert({ server_id: sid, approved_at: new Date().toISOString(), expires_at: exp.toISOString() });
      return interaction.editReply(`Tester approved — \`${sid}\`\nExpires: **${exp.toDateString()}**\nUnlimited access unlocked.`);
    }
    if (action === 'tester_off') {
      await supabase.from('testers').delete().eq('server_id', sid);
      return interaction.editReply(`Tester revoked — \`${sid}\` back to Free tier.`);
    }
    if (action === 'test') {
      const { data } = await supabase.from('usage').select('free_bonus').eq('server_id', sid).single();
      if (data) await supabase.from('usage').update({ free_bonus: (data.free_bonus||0)+extra }).eq('server_id', sid);
      else await supabase.from('usage').insert({ server_id: sid, reports_used: 0, free_bonus: extra, month_start: new Date().toISOString() });
      return interaction.editReply(`Added ${extra} extra reports to \`${sid}\`.`);
    }
    if (action === 'pro') {
      const exp = new Date(); exp.setDate(exp.getDate()+30);
      await supabase.from('paid_servers').upsert({ server_id: sid, activated_at: new Date().toISOString(), expires_at: exp.toISOString() });
      return interaction.editReply(`Pro activated — \`${sid}\` expires **${exp.toDateString()}**.`);
    }
    if (action === 'pro_off') {
      await supabase.from('paid_servers').delete().eq('server_id', sid);
      return interaction.editReply(`Pro deactivated — \`${sid}\` back to Free tier.`);
    }
  } catch (e) { console.error('Admin error:', e); return interaction.editReply(`Error: ${e.message}`); }
}

// ============================================================
// LOGIN
// ============================================================

client.login(process.env.DISCORD_TOKEN);
