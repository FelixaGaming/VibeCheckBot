const http = require('http');
// ============================================================
// VIBE CHECK BOT v2.6
// ============================================================

// 1. RAILWAY INSTANT-BOOT (Must be at the top)
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Vibe Check 2.6 Active');
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
  REPORT_EMAIL:  'go@vibecheckbot.com',
  OWNER_ID:      '1185219817913991220',
  YEARLY_ENABLED: true,
  COOLDOWN_SECONDS: 15,
  SERVER_THROTTLE_PER_MINUTE: 10,
  COST_PER_1M_INPUT_TOKENS:  0.15,
  COST_PER_1M_OUTPUT_TOKENS: 0.60,
  ADMIN_CHANNEL_ID: "1468063704196186145"
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

async function chartUrl(cfg, w, h) {
  try {
    const res = await fetch('https://quickchart.io/chart/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chart: cfg, width: w||500, height: h||260, backgroundColor: 'white' })
    });
    const data = await res.json();
    return data.url || null;
  } catch (e) {
    console.error('Chart URL error:', e.message);
    return null;
  }
}

async function pieChart(friendly, neutral, unfriendly) {
  const total = friendly + neutral + unfriendly || 1;
  const fp = Math.round(friendly / total * 100);
  const np = Math.round(neutral  / total * 100);
  const up = Math.round(unfriendly / total * 100);
  return await chartUrl({
    type: 'pie',
    data: {
      labels: [`Friendly ${fp}%`, `Neutral ${np}%`, `Unfriendly ${up}%`],
      datasets: [{ data: [friendly, neutral, unfriendly], backgroundColor: ['#22c55e','#94a3b8','#ef4444'], borderWidth: 2 }]
    },
    options: { plugins: { legend: { position: 'bottom' }, title: { display: true, text: 'Sentiment Breakdown', font: { size: 14 } } } }
  });
}

async function toxBarChart(toxTypes, title) {
  const entries = Object.entries(toxTypes || {}).filter(([,v]) => v > 0).sort((a,b) => b[1]-a[1]).slice(0,7);
  if (!entries.length) return null;
  return await chartUrl({
    type: 'horizontalBar',
    data: {
      labels: entries.map(([k]) => k),
      datasets: [{ label: 'Count', data: entries.map(([,v]) => v), backgroundColor: '#f97316' }]
    },
    options: { plugins: { title: { display: true, text: title || 'Toxicity Types', font: { size: 14 } } }, scales: { xAxes: [{ ticks: { beginAtZero: true } }] } }
  });
}

async function multiChannelToxChart(channelNames, channelResults) {
  // Collect all unique toxicity types across all channels
  const allTypes = new Set();
  channelNames.forEach(ch => {
    const r = channelResults[ch];
    if (r?.result?.toxicityTypes) Object.keys(r.result.toxicityTypes).forEach(t => allTypes.add(t));
  });
  const types = [...allTypes].filter(t => {
    return channelNames.some(ch => (channelResults[ch]?.result?.toxicityTypes?.[t] || 0) > 0);
  }).slice(0, 6); // max 6 types for readability
  if (!types.length) return null;

  const colors = ['#f97316','#8b5cf6','#22c55e','#3b82f6','#ef4444','#ec4899','#14b8a6'];
  const datasets = channelNames.map((ch, i) => {
    const tox = channelResults[ch]?.result?.toxicityTypes || {};
    return {
      label: ch,
      data: types.map(t => tox[t] || 0),
      backgroundColor: colors[i % colors.length],
      borderColor: colors[i % colors.length],
      borderWidth: 1
    };
  });

  return await chartUrl({
    type: 'bar',
    data: { labels: types, datasets },
    options: {
      plugins: {
        title: { display: true, text: 'Toxicity Breakdown — Channel Comparison', font: { size: 14 } },
        legend: { position: 'bottom' }
      },
      scales: {
        xAxes: [{ stacked: false }],
        yAxes: [{ ticks: { beginAtZero: true } }]
      }
    }
  }, 600, 320);
}

async function scoreLineChart(reports) {
  const labelCount = {};
  const labels = reports.map(r => {
    const d = new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    labelCount[d] = (labelCount[d] || 0) + 1;
    return labelCount[d] > 1 ? `${d} (${labelCount[d]})` : d;
  });
  const scores = reports.map(r => typeof r.score === 'number' ? r.score : parseFloat(r.score) || null);
  return await chartUrl({
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Friendliness Score',
        data: scores,
        borderColor: '#f97316', backgroundColor: 'rgba(249,115,22,0.15)',
        fill: true, tension: 0.35, pointRadius: 6, pointBackgroundColor: '#f97316',
        pointHoverRadius: 8
      }]
    },
    options: {
      plugins: { title: { display: true, text: 'Friendliness Score Over Time', font: { size: 14 } } },
      scales: { yAxes: [{ ticks: { min: 0, max: 10, stepSize: 1, beginAtZero: false } }] }
    }
  });
}

async function impactLineChart(reports) {
  const labels = reports.map(r => new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  return await chartUrl({
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

async function sentimentStackedChart(reports) {
  const labels = reports.map(r => new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  const sd = (n, d) => d === 0 ? 0 : Math.round(n / d * 100);
  return await chartUrl({
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

async function flaggedLineChart(reports) {
  const labels = reports.map(r => new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  return await chartUrl({
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

async function cumulativeToxChart(reports) {
  const toxMap = {};
  reports.forEach(r => {
    try {
      const t = typeof r.toxicity_types === 'string' ? JSON.parse(r.toxicity_types) : r.toxicity_types;
      if (t) Object.entries(t).forEach(([k,v]) => { toxMap[k] = (toxMap[k]||0) + (v||0); });
    } catch {}
  });
  return await toxBarChart(toxMap, 'Cumulative Toxicity Breakdown');
}

async function multiChannelLineChart(reports, allChs) {
  // Build unique date labels with index for duplicates
  const labelCount = {};
  const labels = reports.map(r => {
    const d = new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    labelCount[d] = (labelCount[d] || 0) + 1;
    return labelCount[d] > 1 ? `${d} (${labelCount[d]})` : d;
  });

  const colors = ['#f97316','#8b5cf6','#22c55e','#3b82f6','#ef4444','#ec4899','#14b8a6'];

  const datasets = allChs.map((ch, i) => {
    // ch may be like "#test" — match against comma-separated channel_name field
    const chLower = ch.toLowerCase().trim();
    const data = reports.map(r => {
      if (!r.channel_name) return null;
      // channel_name can be "#test" or "#test, #help, #vibecheck"
      const names = r.channel_name.split(',').map(n => n.trim().toLowerCase());
      if (!names.some(n => n === chLower)) return null;
      // If this report covers multiple channels, we use the global score as approximation
      return typeof r.score === 'number' ? r.score : parseFloat(r.score) || null;
    });
    // Only include channel if it has at least one data point
    if (data.every(d => d === null)) return null;
    return {
      label: ch,
      data,
      borderColor: colors[i % colors.length],
      backgroundColor: 'transparent',
      fill: false,
      tension: 0.35,
      pointRadius: 6,
      pointBackgroundColor: colors[i % colors.length],
      spanGaps: true
    };
  }).filter(Boolean);

  if (!datasets.length) return null;

  return await chartUrl({
    type: 'line',
    data: { labels, datasets },
    options: {
      plugins: {
        title: { display: true, text: 'Vibe Level Trajectory — All Channels', font: { size: 14 } },
        legend: { position: 'bottom' }
      },
      scales: { yAxes: [{ ticks: { min: 0, max: 10, stepSize: 1 } }] }
    }
  }, 600, 320);
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

async function buildVibeEmbeds(result, analyzedCount, channelNames, timeframeLabel, sensitivity, remaining, isPaidServer, reactions, isPublic, channelMsgCounts, channelResults, memberCount, reactionsPerChannel={}) {
  const score = result.friendlinessScore;
  const { friendly, neutral, unfriendly } = result.sentiment;
  const total = friendly + neutral + unfriendly || 1;
  const fp = Math.round(friendly   / total * 100);
  const np = Math.round(neutral    / total * 100);
  const up = Math.round(unfriendly / total * 100);
  const isMultiChannel = channelNames.length > 1;
  const chDisplay = channelNames.join(', ');
  const sensLabel = sensitivity === 'low' ? '🎮 Low — Gaming/Adult' : sensitivity === 'high' ? '👶 High — Kids/Family' : '⚖️ Medium — General';

  // ── Section 1: Community Overview ──
  const embed1 = new EmbedBuilder()
    .setColor(scoreColor(score))
    .setTitle(isMultiChannel ? '📊 Vibe Check Report — Multi-Channel Overview' : '📊 Vibe Check Report — Community Overview')
    .setDescription(
      `_A snapshot of your community's health based on the last ${timeframeLabel} of messages. ` +
      `${isMultiChannel ? 'Each channel is analyzed individually and combined into a weighted Impact Score.' : 'Higher scores mean a warmer, more welcoming community.'}_`
    )
    .addFields(
      { name: '📺 Channels Analyzed', value: chDisplay, inline: true },
      { name: '👥 Members',           value: `**${memberCount||'—'}**`, inline: true },
      { name: '💬 Messages Evaluated', value: `**${analyzedCount}**`, inline: true },
      { name: '🕐 Timeframe',         value: `Last **${timeframeLabel}**`, inline: true },
      { name: '🎛️ Sensitivity',       value: sensLabel, inline: true },
      { name: '👁️ Visibility',        value: isPublic ? '📢 Public' : '🔒 Private', inline: true },
      { name: isMultiChannel ? '⚡ Overall Vibe Score' : '✨ Vibe Strength',
        value: `**${score}/10** \`${scoreBar(score)}\` — **${scoreLabel(score)}** ${scoreEmoji(score)}`, inline: false }
    );
  if (result.communityStrengths) embed1.addFields({ name: '✨ Community Strengths', value: result.communityStrengths, inline: false });
  if (result.summary)            embed1.addFields({ name: '🗒️ Vibe Verdict',        value: result.summary, inline: false });
  if (result.recommendation)    embed1.addFields({ name: '💡 Next Steps',
    value: result.recommendation + '\n\n🎮 **Try [Vibe Quest](https://felixagaming.github.io/vibe-quest/)** — a fun game that shows members the real impact of their words on the community vibe.',
    inline: false });
  embed1.addFields({ name: '🔧 Need Help?', value: `📧 **${CONFIG.CONTACT_EMAIL}**`, inline: false });
  embed1.setFooter({ text: `Vibe Check Bot • ${isPaidServer?'⚡ Pro':'🎁 Free Trial'} • ${remaining} ${remaining===1?'report':'reports'} remaining` });

  // ── Section 2: Per-Channel Vibe Level (multi only) ──
  let embed2 = null;
  let embed2b = null;
  if (isMultiChannel) {
    const perChLines = channelNames.map(ch => {
      const r = channelResults[ch]; if (!r) return `🔘 **${ch}** — not enough data`;
      const s = r.result.friendlinessScore;
      return `${s>=7?'🟢':s>=4?'🟡':'🔴'} **${ch}** \`${scoreBar(s)}\` **${s}/10** — ${scoreLabel(s)} (${channelMsgCounts[ch]||0} msgs)`;
    }).join('\n');
    embed2 = new EmbedBuilder()
      .setColor(0x8b5cf6)
      .setTitle('🧪 Vibe Level Per Channel')
      .setDescription('_Individual health scores for each channel. 🟢 Thriving channels are your community strengths. 🔴 Channels need focused positive energy._')
      .addFields({ name: 'Channel Breakdown', value: perChLines, inline: false });

    // Toxicity comparison chart — one bar per channel per toxicity type
    if (!isPublic) {
      const toxChartUrl = await multiChannelToxChart(channelNames, channelResults);
      if (toxChartUrl) {
        embed2b = new EmbedBuilder()
          .setColor(0xf97316)
          .setTitle('📊 Chart: Toxicity Comparison — All Channels')
          .setDescription('_Side-by-side toxicity breakdown per channel. Each bar group represents a toxicity type, and each color represents a channel. Use this to identify which channels have specific issues._')
          .setImage(toxChartUrl);
      }
    }
  }

  // ── Section 3: Toxicity Breakdown ──
  const embed3 = new EmbedBuilder()
    .setColor(0xf97316)
    .setTitle('🧪 Toxicity Breakdown')
    .setDescription('_Types and volume of harmful content detected. Every flag is an opportunity to strengthen your community norms._');

  if (isPublic) {
    const fc = result.flaggedMessages?.length || 0;
    embed3.addFields({ name: fc > 0 ? `⚠️ ${fc} Flagged Messages` : '✅ No Flagged Messages',
      value: fc > 0 ? 'Full details available in the private report.' : 'No harmful content detected in this timeframe.', inline: false });
    if (fc > 0 && result.toxicityTypes) {
      const tb = Object.entries(result.toxicityTypes).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`• ${k}: ${v}`).join('\n');
      if (tb) embed3.addFields({ name: 'Issue Types', value: tb.substring(0,1024), inline: false });
    }
  } else {
    if (result.toxicityTypes) {
      const types = Object.entries(result.toxicityTypes).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]);
      if (types.length > 0) {
        const mv = types[0][1] || 1;
        embed3.addFields({ name: 'Cumulative Toxicity Breakdown', value: types.map(([k,v])=>`\`${'█'.repeat(Math.round(v/mv*10))}${'░'.repeat(10-Math.round(v/mv*10))}\` **${k}**: ${v}`).join('\n'), inline: false });
      } else {
        embed3.addFields({ name: '✅ No Toxicity Detected', value: 'No harmful content found in this timeframe.', inline: false });
      }
    }
    if (result.flaggedMessages?.length > 0) {
      const list = result.flaggedMessages.sort((a,b)=>b.severity-a.severity).slice(0,10)
        .map(f=>`• [\`${f.type}\` ${f.severity}/10] ${f.message.substring(0,80)}${f.message.length>80?'...':''}`).join('\n');
      embed3.addFields({ name: `⚠️ Flagged Messages (${result.flaggedMessages.length})`, value: list.substring(0,1024), inline: false });
      if (result.flaggedMessages.length > 10) embed3.addFields({ name: '', value: `_...and ${result.flaggedMessages.length-10} more in the email report_`, inline: false });
    } else {
      embed3.addFields({ name: '✅ No Flagged Messages', value: 'No harmful content detected.', inline: false });
    }
    const tUrl = await toxBarChart(result.toxicityTypes, 'Toxicity Breakdown');
    if (tUrl) embed3.setImage(tUrl);
  }

  // ── Section 4: Sentiment Breakdown ──
  const embed4 = new EmbedBuilder()
    .setColor(scoreColor(score))
    .setTitle('💬 Sentiment Breakdown')
    .setDescription('_How messages break down by tone. A healthy community trends green over time. Watch this number grow as your community strengthens._')
    .addFields({
      name: 'Sentiment Distribution',
      value:
        `🟢 Friendly   \`${String(friendly).padStart(4)}\`  **${fp}%**\n` +
        `⚪ Neutral     \`${String(neutral).padStart(4)}\`  **${np}%**\n` +
        `🔴 Unfriendly \`${String(unfriendly).padStart(4)}\`  **${up}%**`,
      inline: false
    })
    .setImage(await pieChart(friendly, neutral, unfriendly));

  // ── Section 5: Most Reacted Messages (per channel) ──
  let embed5 = null;
  if (!isPublic) {
    const hasReactions = isMultiChannel
      ? Object.values(reactionsPerChannel).some(r => r?.mostReacted || r?.mostPositive || r?.mostNegative)
      : (reactions?.mostReacted || reactions?.mostPositive || reactions?.mostNegative);

    if (hasReactions) {
      embed5 = new EmbedBuilder()
        .setColor(0x6366f1)
        .setTitle('⭐ Most Reacted Messages')
        .setDescription('_The messages that sparked the most engagement per channel. These reveal what your community truly responds to — amplify this energy._');

      if (isMultiChannel) {
        // Show per-channel breakdown
        for (const ch of channelNames) {
          const r = reactionsPerChannel[ch];
          if (!r) continue;
          const lines = [];
          if (r.mostReacted)  lines.push(`⭐ **Most reacted:** "${r.mostReacted.text}" — ${r.mostReacted.reactions}`);
          if (r.mostPositive) lines.push(`👍 **Most positive:** "${r.mostPositive.text}" — ${r.mostPositive.reactions}`);
          if (r.mostNegative) lines.push(`👎 **Most negative:** "${r.mostNegative.text}" — ${r.mostNegative.reactions}`);
          if (lines.length) embed5.addFields({ name: `${ch}`, value: lines.join('\n'), inline: false });
        }
      } else {
        // Single channel
        const lines = [];
        if (reactions.mostReacted)  lines.push(`⭐ **Most reacted:** "${reactions.mostReacted.text}" — ${reactions.mostReacted.reactions}`);
        if (reactions.mostPositive) lines.push(`👍 **Most positive:** "${reactions.mostPositive.text}" — ${reactions.mostPositive.reactions}`);
        if (reactions.mostNegative) lines.push(`👎 **Most negative:** "${reactions.mostNegative.text}" — ${reactions.mostNegative.reactions}`);
        embed5.addFields({ name: 'Engagement Highlights', value: lines.join('\n'), inline: false });
      }
    }
  }

  const embeds = [embed1];
  if (embed2) embeds.push(embed2);
  if (embed2b) embeds.push(embed2b);
  embeds.push(embed3, embed4);
  if (embed5) embeds.push(embed5);
  return embeds;
}

// ============================================================
// SAVE + LOG + EMAILS
// ============================================================

async function saveReport(serverId, serverName, channelNames, score, sentiment, flaggedCount, sensitivity, timeframe, analyzedCount, toxicityTypes, reactions) {
  try {
    // Build most_reacted_message string from reactions data
    const topReacted = reactions?.mostReacted
      ? `${reactions.mostReacted.text} [${reactions.mostReacted.reactions}]`
      : null;

    await supabase.from('reports').insert({
      server_id: serverId, server_name: serverName, channel_name: channelNames.join(', '),
      score, friendly: sentiment.friendly, neutral: sentiment.neutral, unfriendly: sentiment.unfriendly,
      flagged_count: flaggedCount, sensitivity, timeframe, messages_analyzed: analyzedCount,
      toxicity_types: JSON.stringify(toxicityTypes||{}),
      most_reacted_message: topReacted,
      created_at: new Date().toISOString()
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
    const score      = result.friendlinessScore;
    const scoreColor = score >= 7 ? '#22c55e' : score >= 4 ? '#f59e0b' : '#ef4444';
    const scoreLabel = score >= 8 ? 'Excellent' : score >= 6 ? 'Good' : score >= 4 ? 'Needs Attention' : 'Poor';
    const total      = (result.sentiment.friendly||0) + (result.sentiment.neutral||0) + (result.sentiment.unfriendly||0) || 1;
    const fp         = Math.round(result.sentiment.friendly   / total * 100);
    const np         = Math.round(result.sentiment.neutral    / total * 100);
    const up         = Math.round(result.sentiment.unfriendly / total * 100);

    const toxRows = result.toxicityTypes
      ? Object.entries(result.toxicityTypes).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1])
          .map(([k,v]) => `<tr><td style="padding:6px 12px;border-bottom:1px solid #f3f4f6;text-transform:capitalize">${k}</td><td style="padding:6px 12px;border-bottom:1px solid #f3f4f6;font-weight:bold;color:#f97316">${v}</td></tr>`).join('')
      : '<tr><td colspan="2" style="padding:8px 12px;color:#6b7280">No toxicity detected</td></tr>';

    const flagRows = result.flaggedMessages?.length > 0
      ? result.flaggedMessages.sort((a,b)=>b.severity-a.severity)
          .map(f => {
            const sevColor = f.severity >= 8 ? '#ef4444' : f.severity >= 5 ? '#f59e0b' : '#6b7280';
            return `<tr>
              <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;font-size:13px">${f.message}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;text-transform:capitalize;font-size:13px">${f.type}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;font-weight:bold;color:${sevColor};font-size:13px">${f.severity}/10</td>
            </tr>`;
          }).join('')
      : '<tr><td colspan="3" style="padding:8px 12px;color:#22c55e">✅ No flagged messages</td></tr>';

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:'Segoe UI',Arial,sans-serif">
<div style="max-width:640px;margin:32px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">

  <!-- HEADER -->
  <div style="background:linear-gradient(135deg,#f97316,#fb923c);padding:32px 40px">
    <div style="font-size:13px;color:rgba(255,255,255,0.8);letter-spacing:1px;text-transform:uppercase;margin-bottom:8px">Vibe Check Bot Report</div>
    <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700">${serverName}</h1>
    <div style="margin-top:8px;color:rgba(255,255,255,0.9);font-size:14px">
      Server ID: ${serverId} &nbsp;•&nbsp; ${new Date().toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}
    </div>
  </div>

  <!-- SCORE HERO -->
  <div style="background:#fff7ed;padding:32px 40px;text-align:center;border-bottom:1px solid #fed7aa">
    <div style="font-size:13px;color:#9a3412;letter-spacing:1px;text-transform:uppercase;margin-bottom:12px">Friendliness Score</div>
    <div style="font-size:72px;font-weight:800;color:${scoreColor};line-height:1">${score}</div>
    <div style="font-size:18px;color:#6b7280;margin-top:4px">/10 &nbsp;—&nbsp; <strong style="color:${scoreColor}">${scoreLabel}</strong></div>
    <div style="margin-top:16px;font-size:28px;letter-spacing:2px;color:${scoreColor}">${'█'.repeat(Math.round(score))}${'░'.repeat(10-Math.round(score))}</div>
  </div>

  <!-- METADATA -->
  <div style="padding:24px 40px;background:#f9fafb;border-bottom:1px solid #e5e7eb;display:flex;gap:24px;flex-wrap:wrap">
    <div style="flex:1;min-width:140px">
      <div style="font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:1px">Channels</div>
      <div style="margin-top:4px;font-weight:600;color:#111827">${channelNames.join(', ')}</div>
    </div>
    <div style="flex:1;min-width:120px">
      <div style="font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:1px">Messages Analyzed</div>
      <div style="margin-top:4px;font-weight:600;color:#111827">${analyzedCount}</div>
    </div>
    <div style="flex:1;min-width:120px">
      <div style="font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:1px">Timeframe</div>
      <div style="margin-top:4px;font-weight:600;color:#111827">${timeframe}</div>
    </div>
    <div style="flex:1;min-width:120px">
      <div style="font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:1px">Sensitivity</div>
      <div style="margin-top:4px;font-weight:600;color:#111827;text-transform:capitalize">${sensitivity}</div>
    </div>
    <div style="flex:1;min-width:120px">
      <div style="font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:1px">Reports Remaining</div>
      <div style="margin-top:4px;font-weight:600;color:#111827">${remaining}</div>
    </div>
  </div>

  <!-- SENTIMENT -->
  <div style="padding:32px 40px;border-bottom:1px solid #e5e7eb">
    <h2 style="margin:0 0 20px;font-size:16px;color:#111827;font-weight:700">💬 Sentiment Breakdown</h2>
    <div style="display:flex;gap:16px;flex-wrap:wrap">
      <div style="flex:1;min-width:140px;background:#f0fdf4;border-radius:12px;padding:16px;text-align:center">
        <div style="font-size:28px;font-weight:800;color:#22c55e">${fp}%</div>
        <div style="font-size:13px;color:#15803d;margin-top:4px">🟢 Friendly</div>
        <div style="font-size:12px;color:#6b7280;margin-top:2px">${result.sentiment.friendly} messages</div>
      </div>
      <div style="flex:1;min-width:140px;background:#f8fafc;border-radius:12px;padding:16px;text-align:center">
        <div style="font-size:28px;font-weight:800;color:#94a3b8">${np}%</div>
        <div style="font-size:13px;color:#475569;margin-top:4px">⚪ Neutral</div>
        <div style="font-size:12px;color:#6b7280;margin-top:2px">${result.sentiment.neutral} messages</div>
      </div>
      <div style="flex:1;min-width:140px;background:#fef2f2;border-radius:12px;padding:16px;text-align:center">
        <div style="font-size:28px;font-weight:800;color:#ef4444">${up}%</div>
        <div style="font-size:13px;color:#b91c1c;margin-top:4px">🔴 Unfriendly</div>
        <div style="font-size:12px;color:#6b7280;margin-top:2px">${result.sentiment.unfriendly} messages</div>
      </div>
    </div>
  </div>

  <!-- COMMUNITY STRENGTHS -->
  ${result.communityStrengths ? `
  <div style="padding:32px 40px;border-bottom:1px solid #e5e7eb;background:#f0fdf4">
    <h2 style="margin:0 0 12px;font-size:16px;color:#111827;font-weight:700">✨ Community Strengths</h2>
    <p style="margin:0;color:#15803d;font-size:15px;line-height:1.6">${result.communityStrengths}</p>
  </div>` : ''}

  <!-- SUMMARY -->
  ${result.summary ? `
  <div style="padding:32px 40px;border-bottom:1px solid #e5e7eb">
    <h2 style="margin:0 0 12px;font-size:16px;color:#111827;font-weight:700">🗒️ Vibe Verdict</h2>
    <p style="margin:0;color:#374151;font-size:15px;line-height:1.6">${result.summary}</p>
  </div>` : ''}

  <!-- RECOMMENDATIONS -->
  ${result.recommendation ? `
  <div style="padding:32px 40px;border-bottom:1px solid #e5e7eb;background:#fff7ed">
    <h2 style="margin:0 0 12px;font-size:16px;color:#111827;font-weight:700">💡 Recommendations</h2>
    <p style="margin:0;color:#9a3412;font-size:15px;line-height:1.6">${result.recommendation}</p>
  </div>` : ''}

  <!-- TOXICITY BREAKDOWN -->
  <div style="padding:32px 40px;border-bottom:1px solid #e5e7eb">
    <h2 style="margin:0 0 16px;font-size:16px;color:#111827;font-weight:700">🧪 Toxicity Breakdown</h2>
    <table style="width:100%;border-collapse:collapse;background:#f9fafb;border-radius:10px;overflow:hidden">
      <thead>
        <tr style="background:#f3f4f6">
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase">Type</th>
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase">Count</th>
        </tr>
      </thead>
      <tbody>${toxRows}</tbody>
    </table>
  </div>

  <!-- FLAGGED MESSAGES -->
  <div style="padding:32px 40px;border-bottom:1px solid #e5e7eb">
    <h2 style="margin:0 0 16px;font-size:16px;color:#111827;font-weight:700">⚠️ All Flagged Messages <span style="font-size:13px;color:#6b7280;font-weight:400">(${result.flaggedMessages?.length||0} total)</span></h2>
    <table style="width:100%;border-collapse:collapse;background:#f9fafb;border-radius:10px;overflow:hidden">
      <thead>
        <tr style="background:#f3f4f6">
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase">Message</th>
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase">Type</th>
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase">Severity</th>
        </tr>
      </thead>
      <tbody>${flagRows}</tbody>
    </table>
  </div>

  <!-- FOOTER -->
  <div style="padding:24px 40px;background:#f9fafb;text-align:center">
    <div style="font-size:13px;color:#9ca3af">Vibe Check Bot &nbsp;•&nbsp; <a href="https://www.vibecheckbot.com" style="color:#f97316;text-decoration:none">vibecheckbot.com</a></div>
    <div style="font-size:12px;color:#d1d5db;margin-top:4px">This report was automatically generated after a /vibe command was run in ${serverName}</div>
  </div>

</div>
</body>
</html>`;

    const result2 = await resend.emails.send({
      from: 'Vibe Check Bot <reports@vibecheckbot.com>',
      to: CONFIG.REPORT_EMAIL,
      subject: `${scoreEmoji(score)} Vibe Report — ${serverName} | ${score}/10 ${scoreLabel} | ${channelNames.join(', ')}`,
      html
    });

    if (result2.error) console.error('Email send error:', result2.error);
    else console.log(`Email sent to ${CONFIG.REPORT_EMAIL} for ${serverName}`);

  } catch (e) { console.error('Email error:', e.message); }
}

// ============================================================
// ADMIN NOTIFICATION SYSTEM
// ============================================================

function adminEmail(subject, headerColor, headerTitle, bodyHtml) {
  return resend.emails.send({
    from: 'Vibe Check Bot <reports@vibecheckbot.com>',
    to: CONFIG.REPORT_EMAIL,
    subject,
    html: `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f9fafb;font-family:'Segoe UI',Arial,sans-serif">
<div style="max-width:580px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
  <div style="background:${headerColor};padding:28px 36px">
    <h1 style="margin:0;color:#fff;font-size:20px;font-weight:700">${headerTitle}</h1>
    <div style="margin-top:6px;color:rgba(255,255,255,0.85);font-size:13px">${new Date().toLocaleString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'})}</div>
  </div>
  <div style="padding:28px 36px">${bodyHtml}</div>
  <div style="padding:16px 36px;background:#f9fafb;text-align:center;font-size:12px;color:#9ca3af">Vibe Check Bot Admin Alerts &nbsp;•&nbsp; go@vibecheckbot.com</div>
</div>
</body>
</html>`
  });
}

function infoRow(label, value) {
  return `<tr>
    <td style="padding:10px 0;color:#6b7280;font-size:14px;border-bottom:1px solid #f3f4f6;width:40%">${label}</td>
    <td style="padding:10px 0;font-weight:600;color:#111827;font-size:14px;border-bottom:1px solid #f3f4f6">${value}</td>
  </tr>`;
}

async function notifyAdminChannel(embed, buttons) {
  try {
    console.log(`[ADMIN NOTIFY] Fetching channel ${CONFIG.ADMIN_CHANNEL_ID}...`);
    const ch = await client.channels.fetch(CONFIG.ADMIN_CHANNEL_ID);
    if (!ch) { console.error('[ADMIN NOTIFY] Channel not found!'); return; }
    console.log(`[ADMIN NOTIFY] Channel found: #${ch.name} in ${ch.guild?.name}. Sending...`);
    const payload = { embeds: [embed] };
    if (buttons) payload.components = [buttons];
    await ch.send(payload);
    console.log('[ADMIN NOTIFY] ✅ Notification sent successfully!');
  } catch (e) { console.error('[ADMIN NOTIFY] ❌ Error:', e.message); }
}

// ── New Install ──
async function notifyNewInstall(guild) {
  const sid = guild.id, name = guild.name, members = guild.memberCount;

  // Discord alert with action buttons
  const embed = new EmbedBuilder()
    .setColor(0x22c55e)
    .setTitle('🎉 New Server Installed Vibe Check Bot!')
    .addFields(
      { name: 'Server', value: name, inline: true },
      { name: 'Members', value: `${members}`, inline: true },
      { name: 'Server ID', value: `\`${sid}\``, inline: false },
      { name: 'Free Reports', value: `${CONFIG.FREE_REPORTS} reports available`, inline: true },
      { name: 'Status', value: '🟢 Free Trial', inline: true }
    )
    .setFooter({ text: `Installed at ${new Date().toLocaleString()}` });

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`admin_tester_${sid}`).setLabel('🧪 Give Tester Access').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`admin_pro_${sid}`).setLabel('⚡ Activate Pro').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`admin_bonus_${sid}`).setLabel('➕ Add 5 Reports').setStyle(ButtonStyle.Secondary)
  );

  await notifyAdminChannel(embed, buttons);

  // Email alert
  try {
    await adminEmail(
      `🎉 New Install — ${name} (${members} members)`,
      'linear-gradient(135deg,#22c55e,#16a34a)',
      '🎉 New Server Installed Vibe Check Bot!',
      `<table style="width:100%;border-collapse:collapse">
        ${infoRow('Server Name', name)}
        ${infoRow('Server ID', sid)}
        ${infoRow('Member Count', members)}
        ${infoRow('Free Reports', CONFIG.FREE_REPORTS)}
        ${infoRow('Status', '🟢 Free Trial Started')}
      </table>
      <div style="margin-top:20px;padding:16px;background:#f0fdf4;border-radius:10px;font-size:14px;color:#15803d">
        Use <strong>/vibe-admin action:tester server_id:${sid}</strong> to give unlimited tester access, or <strong>action:pro</strong> to activate Pro.
      </div>`
    );
  } catch (e) { console.error('New install email error:', e.message); }
}

// ── Server Uninstalled ──
async function notifyUninstall(guild) {
  const embed = new EmbedBuilder()
    .setColor(0xef4444)
    .setTitle('👋 Server Removed Vibe Check Bot')
    .addFields(
      { name: 'Server', value: guild.name, inline: true },
      { name: 'Members', value: `${guild.memberCount}`, inline: true },
      { name: 'Server ID', value: `\`${guild.id}\``, inline: false }
    )
    .setFooter({ text: `Removed at ${new Date().toLocaleString()}` });

  await notifyAdminChannel(embed, null);

  try {
    await adminEmail(
      `👋 Uninstall — ${guild.name}`,
      'linear-gradient(135deg,#ef4444,#dc2626)',
      '👋 Server Removed Vibe Check Bot',
      `<table style="width:100%;border-collapse:collapse">
        ${infoRow('Server Name', guild.name)}
        ${infoRow('Server ID', guild.id)}
        ${infoRow('Member Count', guild.memberCount)}
        ${infoRow('Removed At', new Date().toLocaleString())}
      </table>`
    );
  } catch (e) { console.error('Uninstall email error:', e.message); }
}

// ── First Report (Trial Started) ──
async function sendNewTrialEmail(serverName, serverId, userName) {
  const embed = new EmbedBuilder()
    .setColor(0x3b82f6)
    .setTitle('🚀 Server Ran First /vibe Report!')
    .addFields(
      { name: 'Server', value: serverName, inline: true },
      { name: 'Triggered By', value: userName, inline: true },
      { name: 'Server ID', value: `\`${serverId}\``, inline: false },
      { name: 'Reports Used', value: '1 of 5 free', inline: true },
      { name: 'Remaining', value: `${CONFIG.FREE_REPORTS - 1}`, inline: true }
    )
    .setFooter({ text: new Date().toLocaleString() });

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`admin_tester_${serverId}`).setLabel('🧪 Give Tester Access').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`admin_pro_${serverId}`).setLabel('⚡ Activate Pro').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`admin_bonus_${serverId}`).setLabel('➕ Add 5 Reports').setStyle(ButtonStyle.Secondary)
  );

  await notifyAdminChannel(embed, buttons);

  try {
    await adminEmail(
      `🚀 First Report — ${serverName}`,
      'linear-gradient(135deg,#3b82f6,#2563eb)',
      '🚀 Server Ran Their First /vibe Report!',
      `<table style="width:100%;border-collapse:collapse">
        ${infoRow('Server Name', serverName)}
        ${infoRow('Server ID', serverId)}
        ${infoRow('Triggered By', userName)}
        ${infoRow('Reports Used', '1 of 5 free')}
        ${infoRow('Reports Remaining', CONFIG.FREE_REPORTS - 1)}
      </table>`
    );
  } catch (e) { console.error('First report email error:', e.message); }
}

// ── Trial Exhausted (5/5 used) ──
async function sendTrialEndedEmail(serverName, serverId, userName) {
  const embed = new EmbedBuilder()
    .setColor(0xf59e0b)
    .setTitle('⚠️ Server Hit Free Trial Limit!')
    .setDescription('They have used all 5 free reports. Extend their trial or let them upgrade.')
    .addFields(
      { name: 'Server', value: serverName, inline: true },
      { name: 'Triggered By', value: userName, inline: true },
      { name: 'Server ID', value: `\`${serverId}\``, inline: false },
      { name: 'Reports Used', value: `5 / 5 ⛔`, inline: true },
      { name: 'Action Needed', value: '👇 Extend, activate Pro, or let paywall handle it', inline: false }
    )
    .setFooter({ text: new Date().toLocaleString() });

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`admin_bonus_${serverId}`).setLabel('➕ Extend Trial (+5)').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`admin_pro_${serverId}`).setLabel('⚡ Activate Pro').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`admin_tester_${serverId}`).setLabel('🧪 Give Tester Access').setStyle(ButtonStyle.Secondary)
  );

  await notifyAdminChannel(embed, buttons);

  try {
    await adminEmail(
      `⚠️ Trial Exhausted — ${serverName} needs extension`,
      'linear-gradient(135deg,#f59e0b,#d97706)',
      '⚠️ Server Hit Their Free Trial Limit!',
      `<table style="width:100%;border-collapse:collapse">
        ${infoRow('Server Name', serverName)}
        ${infoRow('Server ID', serverId)}
        ${infoRow('Triggered By', userName)}
        ${infoRow('Reports Used', '5 / 5 — Trial Exhausted')}
        ${infoRow('Action Needed', 'Extend trial or wait for them to upgrade')}
      </table>
      <div style="margin-top:20px;padding:16px;background:#fffbeb;border-radius:10px;font-size:14px;color:#92400e">
        To extend: <strong>/vibe-admin action:test server_id:${serverId} reports:5</strong><br>
        To activate Pro: <strong>/vibe-admin action:pro server_id:${serverId}</strong>
      </div>`
    );
  } catch (e) { console.error('Trial ended email error:', e.message); }
}

// ── Pro Upgrade Interest (clicked upgrade button) ──
async function notifyUpgradeInterest(serverId, serverName, userName, memberCount) {
  const embed = new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle('💜 Server Clicked Upgrade to Pro!')
    .setDescription('They hit the paywall and tapped the upgrade button — high purchase intent.')
    .addFields(
      { name: 'Server', value: serverName, inline: true },
      { name: 'Members', value: `${memberCount}`, inline: true },
      { name: 'Clicked By', value: userName, inline: true },
      { name: 'Server ID', value: `\`${serverId}\``, inline: false }
    )
    .setFooter({ text: new Date().toLocaleString() });

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`admin_pro_${serverId}`).setLabel('⚡ Activate Pro Manually').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`admin_bonus_${serverId}`).setLabel('➕ Give Bonus Reports').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`admin_tester_${serverId}`).setLabel('🧪 Give Tester Access').setStyle(ButtonStyle.Secondary)
  );

  await notifyAdminChannel(embed, buttons);

  try {
    await adminEmail(
      `💜 Upgrade Interest — ${serverName} (${memberCount} members)`,
      'linear-gradient(135deg,#8b5cf6,#7c3aed)',
      '💜 Server Clicked Upgrade to Pro!',
      `<table style="width:100%;border-collapse:collapse">
        ${infoRow('Server Name', serverName)}
        ${infoRow('Server ID', serverId)}
        ${infoRow('Member Count', memberCount)}
        ${infoRow('Clicked By', userName)}
        ${infoRow('Intent', '🔥 High — clicked upgrade button')}
      </table>
      <div style="margin-top:20px;padding:16px;background:#f5f3ff;border-radius:10px;font-size:14px;color:#5b21b6">
        Consider reaching out to offer a deal or activate Pro manually to close them.
      </div>`
    );
  } catch (e) { console.error('Upgrade interest email error:', e.message); }
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
    .addStringOption(o=>o.setName('sensitivity').setDescription('Analysis strictness used in these reports').setRequired(false).addChoices(
      {name:'🎮 Low — Gaming/Adult',value:'low'},{name:'⚖️ Medium — General',value:'medium'},{name:'👶 High — Kids/Family',value:'high'}))
    .addStringOption(o=>o.setName('visibility').setDescription('Who sees the report (default: private)').setRequired(false).addChoices(
      {name:'🔒 Private — only you',value:'private'},{name:'📢 Public — everyone',value:'public'}))
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
  console.log(`🚀 Vibe Check Bot 2.5 is online: ${c.user.tag}`);
  console.log(`   Servers: ${c.guilds.cache.size}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  registerCommands();
});

client.on('guildCreate', async guild => {
  console.log(`Joined: ${guild.name} (${guild.id})`);
  // Welcome message in server
  try {
    const ch = guild.systemChannel || guild.channels.cache.find(c => c.type===ChannelType.GuildText && c.permissionsFor(guild.members.me)?.has('SendMessages'));
    if (ch) await ch.send({ embeds: [new EmbedBuilder().setColor(0xF97316).setTitle('👋 Vibe Check Bot has arrived!')
      .setDescription('Use `/vibe` to check how friendly your community is.\n\nAnalyze multiple channels:\n`/vibe channel:#general channel2:#gaming`')
      .addFields({name:'🎮 Low',value:'Gaming/Adult',inline:true},{name:'⚖️ Medium',value:'General',inline:true},{name:'👶 High',value:'Kids/Family',inline:true})
      .setFooter({text:'How friendly is your community?'})] });
  } catch (e) { console.error('Welcome message error:', e.message); }
  // Notify admin
  await notifyNewInstall(guild);
});

client.on('guildDelete', async guild => {
  console.log(`Removed from: ${guild.name} (${guild.id})`);
  await notifyUninstall(guild);
});

// ============================================================
// INTERACTIONS
// ============================================================

client.on('interactionCreate', async interaction => {
  try {
    // ── Admin action buttons ──
    if (interaction.isButton() && interaction.user.id === CONFIG.OWNER_ID) {
      const id = interaction.customId;
      if (id.startsWith('admin_tester_') || id.startsWith('admin_pro_') || id.startsWith('admin_bonus_') || id.startsWith('admin_prooff_') || id.startsWith('admin_endtrial_')) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const parts = id.split('_');
        const action = parts.slice(0, parts.length - 1).join('_').replace('admin_', '');
        const sid = parts[parts.length - 1];
        try {
          if (action === 'tester') {
            const exp = new Date(Date.now()+14*86400000);
            await supabase.from('testers').upsert({ server_id: sid, approved_at: new Date().toISOString(), expires_at: exp.toISOString() });
            await interaction.editReply(`✅ Tester access granted to \`${sid}\` — expires **${exp.toDateString()}**`);
          } else if (action === 'pro') {
            const exp = new Date(); exp.setDate(exp.getDate()+30);
            await supabase.from('paid_servers').upsert({ server_id: sid, activated_at: new Date().toISOString(), expires_at: exp.toISOString() });
            await interaction.editReply(`✅ Pro activated for \`${sid}\` — expires **${exp.toDateString()}**`);
          } else if (action === 'bonus') {
            const { data } = await supabase.from('usage').select('free_bonus').eq('server_id', sid).single().catch(()=>({data:null}));
            if (data) await supabase.from('usage').update({ free_bonus: (data.free_bonus||0)+5 }).eq('server_id', sid);
            else await supabase.from('usage').insert({ server_id: sid, reports_used: 0, free_bonus: 5, month_start: new Date().toISOString() });
            await interaction.editReply(`✅ Added 5 bonus reports to \`${sid}\``);
          } else if (action === 'prooff') {
            await supabase.from('paid_servers').delete().eq('server_id', sid);
            await interaction.editReply(`✅ Pro deactivated for \`${sid}\``);
          } else if (action === 'endtrial') {
            // Set reports_used to FREE_REPORTS so they hit the paywall immediately
            const { data } = await supabase.from('usage').select('*').eq('server_id', sid).single().catch(()=>({data:null}));
            if (data) await supabase.from('usage').update({ reports_used: CONFIG.FREE_REPORTS, free_bonus: 0 }).eq('server_id', sid);
            else await supabase.from('usage').insert({ server_id: sid, reports_used: CONFIG.FREE_REPORTS, free_bonus: 0, month_start: new Date().toISOString() });
            // Also remove tester/pro just in case
            await supabase.from('testers').delete().eq('server_id', sid).catch(()=>{});
            await supabase.from('paid_servers').delete().eq('server_id', sid).catch(()=>{});
            await interaction.editReply(`⛔ Trial ended for \`${sid}\` — they will hit the paywall on next /vibe.`);
          }
          // Update the original alert message to show action taken
          try {
            await interaction.message.edit({ components: [] });
          } catch {}
        } catch (e) {
          await interaction.editReply(`❌ Error: ${e.message}`);
        }
        return;
      }
    }

    if (interaction.isButton() && interaction.customId === 'view_progress') {
      await handleProgressCommand(interaction, '10', []);
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'vibe')          { await handleVibeCommand(interaction);    return; }
    if (interaction.commandName === 'vibe-progress') {
      const range = interaction.options.getString('range') || '10';
      const sensitivity = interaction.options.getString('sensitivity') || 'medium';
      const visibility = interaction.options.getString('visibility') || 'private';
      const filterChannels = [
        interaction.options.getChannel('channel'),
        interaction.options.getChannel('channel2'),
        interaction.options.getChannel('channel3')
      ].filter(Boolean);
      await handleProgressCommand(interaction, range, filterChannels, sensitivity, visibility);
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
      notifyUpgradeInterest(serverId, serverName, interaction.user.tag, interaction.guild.memberCount).catch(()=>{});
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
    for (const [ch, r] of valid) {
      cSent.friendly   += r.result.sentiment.friendly   || 0;
      cSent.neutral    += r.result.sentiment.neutral    || 0;
      cSent.unfriendly += r.result.sentiment.unfriendly || 0;
      if (r.result.toxicityTypes) Object.entries(r.result.toxicityTypes).forEach(([k,v]) => { cTox[k] = (cTox[k]||0)+(v||0); });
      if (r.result.flaggedMessages) cFlagged.push(...r.result.flaggedMessages.map(f => ({ ...f, channel: ch })));
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

    // Fetch reactions per channel for per-channel display
    const reactionsPerChannel = {};
    for (const ch of channels) {
      reactionsPerChannel[ch.name] = await getChannelStats(interaction.guild, ch);
    }
    const reactions = reactionsPerChannel[channels[0].name]; // fallback for single channel
    await incrementUsage(serverId);
    const remaining = await getReportsRemaining(serverId);

    const embeds  = await buildVibeEmbeds(result, totAnalyzed, channelNames, timeLabel, sensitivity, remaining, serverIsPaid, reactions, !isPrivate, chMsgCounts, channelResults, interaction.guild.memberCount, reactionsPerChannel);
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('📧 Request Tools').setStyle(ButtonStyle.Link).setURL('https://www.felixagaming.com/vibe'),
      new ButtonBuilder().setLabel('🎮 Play Vibe Quest').setStyle(ButtonStyle.Link).setURL('https://felixagaming.github.io/vibe-quest/'),
      new ButtonBuilder().setLabel('📈 View Progress').setStyle(ButtonStyle.Primary).setCustomId('view_progress')
    );
    if (!serverIsPaid && !tester) buttons.addComponents(new ButtonBuilder().setLabel('⚡ Upgrade to Pro').setStyle(ButtonStyle.Link).setURL(CONFIG.STRIPE_MONTHLY_LINK));

    await interaction.editReply({ embeds, components: [buttons] });

    await saveReport(serverId, serverName, channelNames, result.friendlinessScore, result.sentiment, result.flaggedMessages?.length||0, sensitivity, timeframe, totAnalyzed, result.toxicityTypes, reactionsPerChannel[channelNames[0]]);
    await logResearchData({ serverName, serverId, memberCount: interaction.guild.memberCount, channelNames, channelResults, analyzedCount: totAnalyzed, score: result.friendlinessScore, sentiment: result.sentiment, flaggedCount: result.flaggedMessages?.length||0, toxicityTypes: result.toxicityTypes, sensitivity, timeframe, isPro: serverIsPaid, inputTokens: totIn, outputTokens: totOut, cost: totCost, processingTime: totTime });
    await sendEmailReport(serverName, serverId, channelNames, result, totAnalyzed, timeLabel, sensitivity, remaining);

    const usedNow = await getReportsUsed(serverId);

    // Notify admin channel on every report
    try {
      const safeUsedNow = (typeof usedNow === 'number' && usedNow > 0) ? usedNow : 1;
      const colorPalette = [0x22c55e, 0x3b82f6, 0xf59e0b, 0x8b5cf6, 0xef4444];
      const notifColor = colorPalette[(safeUsedNow - 1) % colorPalette.length];
      const s = typeof result.friendlinessScore === 'number' ? result.friendlinessScore : 5;
      const sEmoji = s >= 8 ? '🟢' : s >= 6 ? '🟡' : s >= 4 ? '🟠' : '🔴';
      const runBy = String(interaction.user.username || interaction.user.id || 'Unknown');
      const notifEmbed = new EmbedBuilder()
        .setColor(notifColor)
        .setTitle(`📊 Report #${usedNow} — ${serverName}`)
        .addFields(
          { name: 'Server',    value: String(serverName || 'Unknown'),          inline: true },
          { name: 'Score',     value: `**${s}/10** ${sEmoji}`,                  inline: true },
          { name: 'Reports',   value: `${usedNow} used`,                        inline: true },
          { name: 'Channels',  value: String(channelNames.join(', ') || '—'),   inline: true },
          { name: 'Messages',  value: String(totAnalyzed || '0'),               inline: true },
          { name: 'Run by',    value: String(runBy || 'Unknown'),               inline: true },
          { name: 'Server ID', value: String(serverId),                         inline: false }
        )
        .setFooter({ text: `${serverIsPaid ? '⚡ Pro' : '🎁 Free Trial'} • ${remaining} reports remaining` })
        .setTimestamp();

      const notifButtons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`admin_pro_${serverId}`).setLabel('⚡ Activate Pro').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`admin_bonus_${serverId}`).setLabel('➕ Extend (+5)').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`admin_tester_${serverId}`).setLabel('🧪 Tester').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`admin_endtrial_${serverId}`).setLabel('⛔ End Trial').setStyle(ButtonStyle.Danger)
      );
      await notifyAdminChannel(notifEmbed, notifButtons);
    } catch (e) { console.error('Report notify error:', e.message, e.stack); }

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
// /vibe-progress HANDLER — 5-Section Report
// ============================================================

async function handleProgressCommand(interaction, range, filterChannels, sensitivity='medium', visibility='private') {

  const serverId = interaction.guildId;
  const isPrivate = visibility === 'private';
  await interaction.deferReply({ flags: isPrivate ? MessageFlags.Ephemeral : 0 });

  try {
    let q = supabase.from('reports').select('*').eq('server_id', serverId).order('created_at', { ascending: false });
    if (range === '30d') q = q.gte('created_at', new Date(Date.now()-30*86400000).toISOString());
    else q = q.limit(parseInt(range)||10);

    const { data: reports, error } = await q;
    if (error || !reports?.length) return interaction.editReply('No reports found. Run `/vibe` first.');

    const sorted = [...reports].reverse(); // oldest → newest
    let filtered = sorted, filterLabel = '';
    if (filterChannels?.length === 1) {
      const n = `#${filterChannels[0].name}`;
      filtered = sorted.filter(r => r.channel_name?.includes(n));
      filterLabel = ` • ${n}`;
      if (!filtered.length) return interaction.editReply(`No reports for ${n}. Run /vibe there first.`);
    }

    const latest  = filtered[filtered.length-1];
    const oldest  = filtered[0];
    const avg     = (filtered.reduce((s,r) => s+r.score, 0) / filtered.length).toFixed(1);
    const diff    = parseFloat((latest.score - oldest.score).toFixed(1));

    const sd = (n,d) => d===0?0:Math.round(n/d*100);
    const ot = (oldest.friendly||0)+(oldest.neutral||0)+(oldest.unfriendly||0)||1;
    const nt = (latest.friendly||0)+(latest.neutral||0)+(latest.unfriendly||0)||1;
    const fFirst=sd(oldest.friendly||0,ot), fLast=sd(latest.friendly||0,nt);
    const uFirst=sd(oldest.unfriendly||0,ot), uLast=sd(latest.unfriendly||0,nt);
    const fDelta=fLast-fFirst, uDelta=uLast-uFirst;

    // All unique channels across all reports
    const allChs = [...new Set(sorted.map(r => r.channel_name).filter(Boolean))];

    // Cumulative toxicity
    const toxMap = {};
    filtered.forEach(r => {
      try { const t=typeof r.toxicity_types==='string'?JSON.parse(r.toxicity_types):r.toxicity_types; if(t)Object.entries(t).forEach(([k,v])=>{toxMap[k]=(toxMap[k]||0)+(v||0);}); } catch {}
    });
    const toxEntries = Object.entries(toxMap).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]);

    const fFlag = oldest.flagged_count||0, lFlag = latest.flagged_count||0;
    const prob  = calcBehaviorProbability(filtered);

    // Total messages across all reports
    const totalMessages = filtered.reduce((s,r) => s+(r.messages_analyzed||0), 0);

    // Per-channel message counts and latest scores from reports
    const chMsgTotals = {}, chLatestScore = {};
    allChs.forEach(ch => {
      const chReports = sorted.filter(r => r.channel_name===ch);
      chMsgTotals[ch]    = chReports.reduce((s,r) => s+(r.messages_analyzed||0), 0);
      chLatestScore[ch]  = chReports.length ? chReports[chReports.length-1].score : null;
    });

    // Date range label
    const dateFrom = new Date(oldest.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
    const dateTo   = new Date(latest.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
    const timeframeLabel = range === '30d' ? 'Last 30 Days' : `Last ${filtered.length} Reports`;

    // ── SECTION 1: Community Overview ──
    const chListValue = allChs.length
      ? allChs.map(ch => {
          const s = chLatestScore[ch];
          const msgs = chMsgTotals[ch];
          return `${s>=7?'🟢':s>=4?'🟡':'🔴'} **${ch}** — Score: **${s!==null?s+'/10':'N/A'}** | Messages: **${msgs}**`;
        }).join('\n')
      : 'No channel data';

    const vibeGlobal = `**${avg}/10** \`${scoreBar(parseFloat(avg))}\``;

    const e1 = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('📊 Vibe Check Progress Report — Section 1: Community Overview')
      .setDescription(`_A snapshot of your entire community's health across the selected timeframe. Use this section to understand the scale of your data and your community's current standing._\n\n**Date:** ${new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})} | **Timeframe:** ${timeframeLabel}\n**Range:** ${dateFrom} → ${dateTo}`)
      .addFields(
        { name: '📺 Channels Analyzed', value: chListValue, inline: false },
        { name: '👥 Server Member Count', value: `**${interaction.guild.memberCount}** members`, inline: true },
        { name: '💬 Total Messages Evaluated', value: `**${totalMessages}** messages across ${filtered.length} report${filtered.length===1?'':'s'}`, inline: true },
        { name: '✨ Vibe Strength — Global Weighted Average', value: vibeGlobal, inline: false },
        { name: '🎛️ Sensitivity', value: sensitivity === 'low' ? '🎮 Low — Gaming/Adult' : sensitivity === 'high' ? '👶 High — Kids/Family' : '⚖️ Medium — General', inline: true },
        { name: '👁️ Visibility', value: isPrivate ? '🔒 Private' : '📢 Public', inline: true }
      )
      .setFooter({ text: `Vibe Check Bot  •  Run /vibe regularly to increase prediction accuracy` });

    // ── SECTION 2: General Trend Analysis ──
    const toxText = toxEntries.length > 0
      ? toxEntries.slice(0,7).map(([k,v]) => { const f=Math.round(v/(toxEntries[0][1]||1)*10); return `\`${'█'.repeat(f)}${'░'.repeat(10-f)}\` **${k}**: ${v}`; }).join('\n')
      : '✅ No toxicity detected across all reports';

    const sentimentSummary =
      `🟢 Friendly:   **${fFirst}%** → **${fLast}%** (${fDelta>=0?'+':''}${fDelta}%)\n` +
      `🔴 Unfriendly: **${uFirst}%** → **${uLast}%** (${uDelta>=0?'+':''}${uDelta}%)`;

    const flagSummary = `First report: **${fFlag}** flagged | Latest: **${lFlag}** flagged\n` +
      (lFlag < fFlag ? `✅ Down ${fFlag-lFlag} — great progress` : lFlag > fFlag ? `⚠️ Up ${lFlag-fFlag} — opportunity to reinforce positive norms` : '➡️ Stable');

    // Top 3 most reacted — sorted by date, pick 3 most recent that have data
    const reportsWithReactions = filtered.filter(r => r.most_reacted_message);
    const topReacted = reportsWithReactions.length > 0
      ? reportsWithReactions.slice(-3).map((r,i) => {
          const date = new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          return `${i+1}. **[${date}]** "${r.most_reacted_message.substring(0,80)}${r.most_reacted_message.length>80?'...':''}"`;
        }).join('\n')
      : '_Reaction data will appear here after your next `/vibe` run — this feature tracks the most engaged message from each report going forward._';

    const e2_tox = new EmbedBuilder()
      .setColor(0xf97316)
      .setTitle('📈 Section 2 — General Trend Analysis')
      .setDescription('_A high-level view of how your community has evolved across all reports. This section combines score trends, toxicity patterns, sentiment shifts, and flagged message history into one comprehensive overview._')
      .addFields(
        { name: '📉 Vibe Strength Over Time', value: `Oldest: **${oldest.score}/10** → Latest: **${latest.score}/10** | Avg: **${avg}/10**\n${diff>0?`📈 Up +${diff} pts`:diff<0?`📉 Down ${diff} pts`:'➡️ Stable'}`, inline: false },
        { name: '🧪 Cumulative Toxicity Breakdown', value: toxText, inline: false },
        { name: '⭐ Top 3 Most Reacted Messages', value: topReacted, inline: false },
        { name: '💬 Sentiment Evolution', value: sentimentSummary, inline: false },
        { name: '🚩 Flagged Messages Trend', value: flagSummary, inline: false }
      );

    // ── SECTION 2 chart embeds — each with title + explanation ──

    // Chart 1: Multi-channel trajectory
    const multiChUrl = await multiChannelLineChart(filtered, allChs);
    const eChart1 = new EmbedBuilder()
      .setColor(0xf97316)
      .setTitle('📊 Chart: Vibe Level Trajectory — All Channels')
      .setDescription('_Each line represents one channel. Shows how every channel\'s friendliness score has moved over time, making it easy to spot which channels are improving and which are declining._')
      .setImage(multiChUrl);

    // Chart 2: Global score over time
    const eChart2 = new EmbedBuilder()
      .setColor(0xf97316)
      .setTitle('📊 Chart: Global Vibe Strength Over Time')
      .setDescription('_The weighted average friendliness score across your entire community. Higher is healthier. Use this to track whether your overall community health is trending up or down._')
      .setImage(await scoreLineChart(filtered));

    // Chart 3: Cumulative toxicity
    const toxChartUrl = await cumulativeToxChart(filtered);
    const eChart3 = toxChartUrl
      ? new EmbedBuilder()
          .setColor(0xf97316)
          .setTitle('📊 Chart: Cumulative Toxicity Breakdown')
          .setDescription('_Total count of each type of harmful content found across all analyzed reports. The longest bar is your community\'s most common issue — a good place to focus your energy._')
          .setImage(toxChartUrl)
      : null;

    // Chart 4: Sentiment stacked
    const eChart4 = new EmbedBuilder()
      .setColor(0xf97316)
      .setTitle('📊 Chart: Sentiment Evolution')
      .setDescription('_Stacked bars showing the percentage of Friendly (green), Neutral (grey), and Unfriendly (red) messages per report. Watch the green grow and the red shrink over time as your community improves._')
      .setImage(await sentimentStackedChart(filtered));

    // Chart 5: Flagged messages trend
    const eChart5 = new EmbedBuilder()
      .setColor(0xf97316)
      .setTitle('📊 Chart: Flagged Messages Over Time')
      .setDescription('_Number of harmful messages flagged per report. A downward trend means your community standards are strengthening. Spikes are early warning signals to act on._')
      .setImage(await flaggedLineChart(filtered));

    // ── SECTION 3: Per-Channel ──
    const perChLines = allChs.map(ch => {
      const chReports = sorted.filter(r => r.channel_name===ch);
      if (!chReports.length) return null;
      const cl  = chReports[chReports.length-1].score;
      const co  = chReports[0].score;
      const cd  = parseFloat((cl-co).toFixed(1));
      const msgs = chMsgTotals[ch];
      return `${cl>=7?'🟢':cl>=4?'🟡':'🔴'} **${ch}**\n\`${scoreBar(cl)}\` **${cl}/10** | Messages: ${msgs} | ${cd>0?`📈 +${cd} pts`:cd<0?`📉 ${cd} pts`:'➡️ Stable'}`;
    }).filter(Boolean);

    const e3 = new EmbedBuilder()
      .setColor(0x8b5cf6)
      .setTitle('🧪 Section 3 — Trend Analysis Per Channel')
      .setDescription('_A detailed breakdown of each individual channel\'s health. Channels shown in 🟢 green are flourishing. 🟡 Yellow channels need encouragement. 🔴 Red channels need focused community-building attention._')
      .addFields({ name: 'Per-Channel Breakdown', value: perChLines.length ? perChLines.join('\n\n') : 'Only one channel tracked so far.', inline: false })
      .setImage(await impactLineChart(filtered));

    // ── SECTION 4: Predictive Analytics ──
    const predLines = [];
    if (filtered.length >= 3) {
      const ra = filtered.slice(-3).reduce((s,r)=>s+r.score,0)/3;
      const oa = filtered.slice(0,-3).reduce((s,r)=>s+r.score,0)/Math.max(filtered.length-3,1);
      const m  = ra-oa;
      if (m >= 1)       predLines.push(`📈 **Accelerating upward** — community energy is building. Expect continued improvement.`);
      else if (m >= 0)  predLines.push(`🟢 **Positive momentum** — health is stable and likely to improve.`);
      else if (m >= -1) predLines.push(`🟡 **Slight downward drift** — a good moment to reinvigorate engagement.`);
      else              predLines.push(`🔴 **Declining momentum** — invest in member recognition and shared goals now.`);
    }
    if (uDelta > 5)       predLines.push(`⚠️ **Unfriendly behavior rising** (${uFirst}% → ${uLast}%) — highlight your most positive members to reset the tone.`);
    else if (uDelta < -5) predLines.push(`✅ **Positive behavior increasing** (${uFirst}% → ${uLast}%) — community norms are strengthening.`);
    if (lFlag > fFlag*1.5 && lFlag > 2) predLines.push(`🚨 **Flagged messages spiking** — double down on celebrating what makes your community great.`);
    else if (lFlag === 0) predLines.push(`✨ **Zero harmful content** in latest report — your community standards are working beautifully.`);

    let probText = 'Run at least 2 reports to unlock probability forecasts.';
    if (prob) {
      probText =
        `${prob.improveTrend} **${prob.improveChance}%** probability community improves\n` +
        `${prob.worsenTrend} **${prob.worsenChance}%** probability toxicity increases\n\n` +
        `${prob.confidenceEmoji} **Confidence: ${prob.confidence}** (based on ${filtered.length} reports)\n\n` +
        `**Key signals:**\n${prob.factors.map(f=>`• ${f}`).join('\n')}`;
    }

    const e4 = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle('🔮 Section 4 — Predictive Analytics')
      .setDescription('_Using momentum, sentiment trends, flagged message patterns, and toxicity severity, the bot calculates the probability your community will improve or worsen in the next reporting period. The more reports you run, the more accurate this becomes._')
      .addFields(
        { name: '📊 Behavior Forecast', value: probText, inline: false }
      );
    if (predLines.length) e4.addFields({ name: '🔭 Trend Predictions', value: predLines.join('\n'), inline: false });

    // ── SECTION 5: Next Steps ──
    const recLines = [];
    if (diff < -0.5)      recLines.push(`💡 **Score dipped** — create a "community highlight" post celebrating your most positive recent conversations.`);
    else if (diff > 0.5)  recLines.push(`🌟 **Score is rising** — keep the momentum by publicly recognizing the members who contribute most positively.`);
    else                   recLines.push(`🎯 **Stable community** — try a "spotlight of the week" feature to proactively reinforce the positive tone.`);

    if (fLast >= 70)       recLines.push(`🏆 **${fLast}% friendly** — your community has a strong foundation. Channel this energy into a shared goal or community challenge.`);
    else if (fLast >= 50)  recLines.push(`🌱 **Build on ${fLast}% friendly** — create more opportunities for members to connect over shared interests.`);
    else                   recLines.push(`❤️ **Focus on belonging** — welcoming new members publicly can shift community culture over time.`);

    const chAdvice = allChs.map(ch => {
      const s = chLatestScore[ch];
      if (s === null) return null;
      if (s >= 8) return `✨ **${ch}** is thriving at ${s}/10 — spotlight this channel as a model for the rest of the community.`;
      if (s >= 6) return `👍 **${ch}** is healthy at ${s}/10 — maintain momentum with regular recognition of positive contributions.`;
      if (s >= 4) return `⚠️ **${ch}** needs attention at ${s}/10 — try a community event or appreciation post to shift the energy.`;
      return `🚨 **${ch}** is struggling at ${s}/10 — focus on celebrating positive members here to rebuild belonging.`;
    }).filter(Boolean);

    if (toxEntries.length > 0) {
      const typeRec = {
        harassment: 'Spotlight respectful conversations — what gets celebrated gets repeated.',
        insults:    'Create a "kindness challenge" — invite members to share what they appreciate about the community.',
        hate_speech:'Build a stronger shared identity — pride in the community naturally reduces exclusionary behavior.',
        spam:       'Low engagement drives spam — try a community Q&A or AMA to spark genuine conversation.',
        threats:    'Build psychological safety by celebrating openness and vulnerability in conversations.',
        bullying:   'Empower bystanders — recognize members who support others to create a culture of mutual care.',
        profanity:  'Model the tone you want to see rather than focusing on what you want to stop.'
      };
      recLines.push(`🔮 **Top issue — ${toxEntries[0][0]}:** ${typeRec[toxEntries[0][0]] || 'Amplify positive interactions to naturally crowd out negative ones.'}`);
    recLines.push(`🎮 **[Play Vibe Quest](https://felixagaming.github.io/vibe-quest/)** — share with your members to show them the real impact of their words on community vibe.`);
    }

    const e5 = new EmbedBuilder()
      .setColor(0x22c55e)
      .setTitle('💡 Section 5 — Next Steps')
      .setDescription('_Strengths-based, actionable advice tailored to your community\'s current data. Every suggestion is rooted in positive psychology — focused on amplifying what\'s working, not punishing what isn\'t._')
      .addFields(
        { name: '🎯 Community-Wide Actions', value: recLines.join('\n'), inline: false }
      );
    if (chAdvice.length) e5.addFields({ name: '📺 Per-Channel Advice', value: chAdvice.join('\n'), inline: false });
    e5.addFields({ name: '📅 Mandatory Reminder', value: '> Run `/vibe` regularly across all your channels. The more data points collected, the more accurate the predictions and the clearer your community\'s growth story becomes.', inline: false });
    e5.setFooter({ text: `Vibe Check Bot  •  ${filtered.length} reports analyzed  •  Keep going!` });

    // ── Final embed list ──
    const embeds = [e1, e2_tox, eChart1, eChart2];
    if (eChart3) embeds.push(eChart3);
    embeds.push(eChart4, eChart5, e3, e4, e5);

    await interaction.editReply({ embeds });

    // Notify admin channel about progress report run
    try {
      const serverName = interaction.guild.name;
      const serverId = interaction.guildId;
      const progressEmbed = new EmbedBuilder()
        .setColor(0x6366f1)
        .setTitle(`📈 Progress Report Viewed — ${serverName}`)
        .addFields(
          { name: 'Server',   value: serverName,                    inline: true },
          { name: 'Run by',   value: String(interaction.user.username || interaction.user.id), inline: true },
          { name: 'Reports',  value: `${filtered.length} analyzed`, inline: true },
          { name: 'Range',    value: range === '30d' ? 'Last 30 days' : `Last ${range} reports`, inline: true },
          { name: 'Server ID', value: String(serverId),               inline: false }
        )
        .setTimestamp()
        .setFooter({ text: 'Active user — checking community trends' });
      const progressButtons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`admin_pro_${serverId}`).setLabel('⚡ Activate Pro').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`admin_bonus_${serverId}`).setLabel('➕ Extend (+5)').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`admin_tester_${serverId}`).setLabel('🧪 Tester').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`admin_endtrial_${serverId}`).setLabel('⛔ End Trial').setStyle(ButtonStyle.Danger)
      );
      await notifyAdminChannel(progressEmbed, progressButtons);
    } catch (e) { console.error('Progress notify error:', e.message); }

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
