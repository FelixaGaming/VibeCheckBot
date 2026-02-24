const http = require('http');
// ============================================
// VIBECHECK DISCORD BOT - WITH RESEARCH LOGGING
// ============================================

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

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
  // Plan limits
  FREE_REPORTS: 5,
  PRO_REPORTS_PER_MONTH: 30,
  FREE_MAX_MESSAGES: 500,
  PRO_MAX_MESSAGES: 1000,
  FREE_PROGRESS_REPORTS: 1,
  PRO_PROGRESS_REPORTS: 4,
  
  // OpenAI safety limits
  MAX_OPENAI_CHARS: 30000,
  MAX_OPENAI_MESSAGES: 200,
  
  // Payment links
  STRIPE_MONTHLY_LINK: 'https://buy.stripe.com/fZu28k00n5s92Oqf4z4ow01',
  STRIPE_YEARLY_LINK: 'https://buy.stripe.com/bJebIUbJ56wd4Wye0v4ow03',
  YEARLY_ENABLED: true,
  
  // Contact
  CONTACT_EMAIL: 'play@felixagaming.com',
  REPORT_EMAIL: 'play@felixagaming.com',
  OWNER_ID: '1185219817913991220',
  
  // Rate limiting
  COOLDOWN_SECONDS: 15,
  SERVER_THROTTLE_PER_MINUTE: 10,
  
  // Timeouts
  PENDING_COMMAND_TIMEOUT: 300000,
  
  // OpenAI cost tracking (GPT-4o-mini pricing)
  COST_PER_1M_INPUT_TOKENS: 0.15,
  COST_PER_1M_OUTPUT_TOKENS: 0.60
};

// ============================================
// SENSITIVITY PROMPTS
// ============================================

const SENSITIVITY_PROMPTS = {
  low: `SENSITIVITY: LOW (Adult/Gaming communities - CoD, GTA, etc.)

WHAT TO FLAG:
- Direct personal attacks and targeted insults at specific people
- Threats of violence or harm
- Harassment and stalking behavior
- Racism, xenophobia, homophobia, slurs
- Doxxing or sharing personal information
- Sexual harassment

WHAT IS ACCEPTABLE (do NOT flag):
- General swearing/profanity not directed at anyone ("fuck this game", "damn it")
- Trash talk that's clearly playful or gaming-related ("you suck", "get rekt")
- Competitive banter without personal attacks
- Mild frustration or venting
- Dark humor (unless targeting protected groups)

SCORING:
- Only score below 5 if there are real threats, harassment, or discrimination
- General profanity should NOT lower the score significantly`,

  medium: `SENSITIVITY: MEDIUM (General communities - default)

WHAT TO FLAG:
- All personal insults and attacks
- Threats of any kind
- Harassment and bullying
- Racism, xenophobia, homophobia
- Profanity directed at people ("you bitch", "fuck you")
- Passive-aggressive attacks and put-downs
- Dismissive/demeaning comments

WHAT IS ACCEPTABLE (do NOT flag):
- Mild profanity not directed at anyone
- Constructive criticism
- Polite disagreements
- Simple requests even if direct

SCORING:
- Score below 5 if threats, discrimination, or significant harassment exists
- Score 5-7 if there's notable negativity or directed profanity`,

  high: `SENSITIVITY: HIGH (Family/Kids communities - Minecraft, Roblox, etc.)

WHAT TO FLAG - BE VERY STRICT:
- ANY profanity or swear words (even mild: "damn", "hell", "crap")
- ANY insults (even mild: "you're bad", "that's stupid")
- ANY negativity or rudeness
- ANY bullying or exclusion ("nobody likes you", "go away")
- ANY inappropriate topics for children
- Sarcasm meant to hurt
- Peer pressure or manipulation
- Anything that could make a child feel bad

WHAT IS ACCEPTABLE:
- Positive, encouraging messages only
- Helpful advice given kindly
- Friendly conversation

SCORING:
- Score below 7 if ANY profanity exists
- Score below 5 if ANY bullying, insults, or meanness exists
- Only score 8+ if conversation is genuinely positive and supportive`
};

// ============================================
// RATE LIMITING & PENDING COMMANDS
// ============================================

const cooldowns = new Map();
const serverThrottles = new Map();
const pendingProgressCommands = new Map();

function setPendingCommand(map, key, value) {
  const existing = map.get(key);
  if (existing?.timeout) clearTimeout(existing.timeout);
  
  const timeout = setTimeout(() => {
    map.delete(key);
    console.log(`🧹 Pending command expired for user ${key}`);
  }, CONFIG.PENDING_COMMAND_TIMEOUT);
  
  const data = { ...value, timeout, createdAt: Date.now() };
  map.set(key, data);
  console.log(`📝 Stored pending command for user ${key}`);
}

function peekPendingCommand(map, key) {
  const pending = map.get(key);
  if (!pending) return null;
  const { timeout, createdAt, ...data } = pending;
  return data;
}

function consumePendingCommand(map, key) {
  console.log(`🔍 Consuming pending command for user ${key}`);
  const pending = map.get(key);
  if (!pending) {
    console.log(`❌ No pending command found for user ${key}`);
    return null;
  }
  
  if (pending.timeout) {
    clearTimeout(pending.timeout);
  }
  
  const { timeout, createdAt, ...data } = pending;
  map.delete(key);
  console.log(`✅ Consumed pending command for user ${key}`);
  return data;
}

function isOnCooldown(serverId, userId) {
  const key = `${serverId}_${userId}`;
  if (!cooldowns.has(key)) return false;
  return (Date.now() - cooldowns.get(key)) < (CONFIG.COOLDOWN_SECONDS * 1000);
}

function getCooldownRemaining(serverId, userId) {
  const key = `${serverId}_${userId}`;
  if (!cooldowns.has(key)) return 0;
  return Math.ceil((CONFIG.COOLDOWN_SECONDS * 1000 - (Date.now() - cooldowns.get(key))) / 1000);
}

function setCooldown(serverId, userId) {
  const key = `${serverId}_${userId}`;
  cooldowns.set(key, Date.now());
}

function isServerThrottled(serverId) {
  const now = Date.now();
  const minuteAgo = now - 60000;
  
  if (!serverThrottles.has(serverId)) {
    serverThrottles.set(serverId, []);
  }
  
  const requests = serverThrottles.get(serverId).filter(t => t > minuteAgo);
  serverThrottles.set(serverId, requests);
  
  return requests.length >= CONFIG.SERVER_THROTTLE_PER_MINUTE;
}

function recordServerRequest(serverId) {
  if (!serverThrottles.has(serverId)) {
    serverThrottles.set(serverId, []);
  }
  serverThrottles.get(serverId).push(Date.now());
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function clamp(num, min, max) {
  return Math.min(Math.max(num, min), max);
}

function sanitizeMessage(msg) {
  if (!msg || typeof msg !== 'string') return '';
  return msg
    .replace(/```/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, 500);
}

function safePercentage(value, total) {
  if (!total || total === 0) return 0;
  return Math.round((value / total) * 100);
}

function createSubscriptionButtons(options = {}) {
  const { 
    monthlyLabel = '⚡ Monthly · $9.99', 
    yearlyLabel = '💎 Yearly · $99 (Save 17%)',
    upgradeOnly = false
  } = options;
  
  const buttons = [];
  
  if (!upgradeOnly) {
    buttons.push(
      new ButtonBuilder()
        .setLabel(monthlyLabel)
        .setStyle(ButtonStyle.Link)
        .setURL(CONFIG.STRIPE_MONTHLY_LINK)
    );
  }
  
  if (CONFIG.YEARLY_ENABLED) {
    buttons.push(
      new ButtonBuilder()
        .setLabel(yearlyLabel)
        .setStyle(ButtonStyle.Link)
        .setURL(CONFIG.STRIPE_YEARLY_LINK)
    );
  }
  
  return new ActionRowBuilder().addComponents(buttons);
}

// ============================================
// RESEARCH LOGGING (Privacy-Safe)
// ============================================

function hashForResearch(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function calculateCost(inputTokens, outputTokens) {
  const inputCost = (inputTokens / 1_000_000) * CONFIG.COST_PER_1M_INPUT_TOKENS;
  const outputCost = (outputTokens / 1_000_000) * CONFIG.COST_PER_1M_OUTPUT_TOKENS;
  return inputCost + outputCost;
}

async function logResearchData(data) {
  try {
    const { error } = await supabase.from('research_logs').insert({
      server_id_hash: hashForResearch(data.serverId),
      user_id_hash: hashForResearch(data.userId),
      channel_id_hash: hashForResearch(data.channelId),
      messages_analyzed: data.messagesAnalyzed,
      timeframe: data.timeframe,
      sensitivity: data.sensitivity,
      visibility: data.visibility,
      is_pro: data.isPro,
      score: data.score,
      friendly: data.friendly,
      neutral: data.neutral,
      unfriendly: data.unfriendly,
      flagged_count: data.flaggedCount,
      toxicity_types: data.toxicityTypes,
      processing_time_ms: data.processingTimeMs,
      input_tokens: data.inputTokens,
      output_tokens: data.outputTokens,
      cost_usd: data.costUsd,
      success: data.success,
      error_message: data.errorMessage || null
    });
    
    if (error) {
      console.error('Research log error:', error);
    } else {
      console.log(`📊 Research logged: ${data.messagesAnalyzed} msgs, $${data.costUsd.toFixed(6)}`);
    }
  } catch (err) {
    console.error('Research logging failed:', err);
  }
}

// ============================================
// API SETUP
// ============================================

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false
  }
});

// ============================================
// SUPABASE FUNCTIONS
// ============================================

async function getUsage(serverId) {
  try {
    const { data, error } = await supabase.from('usage').select('*').eq('server_id', serverId).single();
    if (error || !data) {
      const { data: newData } = await supabase.from('usage').insert({ server_id: serverId, reports_used: 0, progress_used: 0 }).select().single();
      return newData || { reports_used: 0, progress_used: 0, month_start: new Date().toISOString() };
    }
    return data;
  } catch (error) {
    console.error('getUsage error:', error);
    return { reports_used: 0, progress_used: 0, month_start: new Date().toISOString() };
  }
}

async function getProgressUsage(serverId) {
  try {
    const usage = await getUsage(serverId);
    return usage.progress_used || 0;
  } catch (error) {
    return 0;
  }
}

async function useProgressReport(serverId) {
  try {
    const usage = await getUsage(serverId);
    const newCount = (usage.progress_used || 0) + 1;
    await supabase.from('usage').update({ progress_used: newCount }).eq('server_id', serverId);
    return newCount;
  } catch (error) {
    console.error('useProgressReport error:', error);
    return 0;
  }
}

async function hasProgressAccess(serverId) {
  try {
    const { data } = await supabase.from('progress_access').select('*').eq('server_id', serverId).single();
    return !!data;
  } catch (error) {
    return false;
  }
}

async function canUseProgressReport(serverId, userId = null) {
  if (userId === CONFIG.OWNER_ID) return true;
  const hasPaid = await hasProgressAccess(serverId);
  if (hasPaid) return true;
  const approved = await isApproved(serverId);
  if (approved) {
    const used = await getProgressUsage(serverId);
    return used < CONFIG.PRO_PROGRESS_REPORTS;
  }
  const used = await getProgressUsage(serverId);
  return used < CONFIG.FREE_PROGRESS_REPORTS;
}

async function getProgressReportsRemaining(serverId, userId = null) {
  if (userId === CONFIG.OWNER_ID) return 999;
  const hasPaid = await hasProgressAccess(serverId);
  if (hasPaid) return 999;
  const approved = await isApproved(serverId);
  const used = await getProgressUsage(serverId);
  if (approved) return Math.max(0, CONFIG.PRO_PROGRESS_REPORTS - used);
  return Math.max(0, CONFIG.FREE_PROGRESS_REPORTS - used);
}

async function isApproved(serverId) {
  try {
    const { data, error } = await supabase.from('approved_servers').select('*').eq('server_id', serverId).single();
    if (error || !data) return false;
    if (data.expires_at) {
      const expiresAt = new Date(data.expires_at);
      if (expiresAt <= new Date()) return false;
    }
    return true;
  } catch (error) {
    return false;
  }
}

async function getApprovedServer(serverId) {
  try {
    const { data } = await supabase.from('approved_servers').select('*').eq('server_id', serverId).single();
    return data;
  } catch (error) {
    return null;
  }
}

async function getApprovalRequest(serverId) {
  try {
    const { data } = await supabase.from('approval_requests').select('*').eq('server_id', serverId).order('requested_at', { ascending: false }).limit(1).single();
    return data;
  } catch (error) {
    return null;
  }
}

async function createApprovalRequest(serverId, serverName, requestedBy) {
  try {
    const { data, error } = await supabase.from('approval_requests').insert({ server_id: serverId, server_name: serverName, requested_by: requestedBy, status: 'pending' }).select().single();
    if (error) console.error('Approval request error:', error);
    return data;
  } catch (error) {
    console.error('createApprovalRequest error:', error);
    return null;
  }
}

async function updateApprovalStatus(serverId, status) {
  try {
    await supabase.from('approval_requests').update({ status }).eq('server_id', serverId).eq('status', 'pending');
  } catch (error) {
    console.error('updateApprovalStatus error:', error);
  }
}

async function approveServer(serverId, serverName, days = 30) {
  try {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);
    await supabase.from('approved_servers').upsert({ 
      server_id: serverId, 
      server_name: serverName, 
      reports_allowed: CONFIG.PRO_REPORTS_PER_MONTH,
      expires_at: expiresAt.toISOString()
    });
    await updateApprovalStatus(serverId, 'approved');
    await supabase.from('usage').upsert({ 
      server_id: serverId, 
      reports_used: 0, 
      progress_used: 0, 
      month_start: new Date().toISOString() 
    });
    return expiresAt;
  } catch (error) {
    console.error('approveServer error:', error);
    return null;
  }
}

async function renewSubscription(serverId, days = 30) {
  try {
    const current = await getApprovedServer(serverId);
    if (!current) return null;
    const startDate = current.expires_at && new Date(current.expires_at) > new Date() 
      ? new Date(current.expires_at) : new Date();
    const expiresAt = new Date(startDate);
    expiresAt.setDate(expiresAt.getDate() + days);
    await supabase.from('approved_servers').update({ expires_at: expiresAt.toISOString() }).eq('server_id', serverId);
    await supabase.from('usage').upsert({ 
      server_id: serverId, 
      reports_used: 0, 
      progress_used: 0, 
      month_start: new Date().toISOString() 
    });
    return expiresAt;
  } catch (error) {
    console.error('renewSubscription error:', error);
    return null;
  }
}

async function getSubscriptionStatus(serverId) {
  try {
    const approved = await getApprovedServer(serverId);
    if (!approved) return { active: false, expired: false, daysLeft: 0 };
    if (!approved.expires_at) return { active: true, expired: false, daysLeft: 999, expiresAt: null };
    const expiresAt = new Date(approved.expires_at);
    const now = new Date();
    const daysLeft = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));
    return { active: daysLeft > 0, expired: daysLeft <= 0, daysLeft: Math.max(0, daysLeft), expiresAt: expiresAt };
  } catch (error) {
    return { active: false, expired: true, daysLeft: 0 };
  }
}

async function canUseBot(serverId, userId = null) {
  try {
    if (userId === CONFIG.OWNER_ID) return true;
    const approved = await isApproved(serverId);
    const usage = await getUsage(serverId);
    if (approved) {
      const approvedData = await getApprovedServer(serverId);
      const monthStart = new Date(usage.month_start);
      const daysSinceStart = (new Date() - monthStart) / (1000 * 60 * 60 * 24);
      if (daysSinceStart >= 30) {
        await supabase.from('usage').update({ reports_used: 0, progress_used: 0, month_start: new Date().toISOString() }).eq('server_id', serverId);
        return true;
      }
      return usage.reports_used < (approvedData?.reports_allowed || CONFIG.PRO_REPORTS_PER_MONTH);
    }
    return usage.reports_used < CONFIG.FREE_REPORTS;
  } catch (error) {
    console.error('canUseBot error:', error);
    return true;
  }
}

async function getReportsRemaining(serverId, userId = null) {
  try {
    if (userId === CONFIG.OWNER_ID) return 999;
    const approved = await isApproved(serverId);
    const usage = await getUsage(serverId);
    if (approved) {
      const approvedData = await getApprovedServer(serverId);
      return Math.max(0, (approvedData?.reports_allowed || CONFIG.PRO_REPORTS_PER_MONTH) - usage.reports_used);
    }
    return Math.max(0, CONFIG.FREE_REPORTS - usage.reports_used);
  } catch (error) {
    return 0;
  }
}

async function useReport(serverId) {
  try {
    const usage = await getUsage(serverId);
    const newCount = usage.reports_used + 1;
    await supabase.from('usage').update({ reports_used: newCount }).eq('server_id', serverId);
    return newCount;
  } catch (error) {
    console.error('useReport error:', error);
    return 0;
  }
}

async function getTotalReports(serverId, channelName = null) {
  try {
    let query = supabase.from('reports').select('*', { count: 'exact', head: true }).eq('server_id', serverId);
    if (channelName) query = query.eq('channel_name', channelName);
    const { count } = await query;
    return count || 0;
  } catch (error) {
    return 0;
  }
}

async function saveReport(reportData) {
  try {
    const { error } = await supabase.from('reports').insert({
      server_id: reportData.serverId,
      channel_name: reportData.channelName,
      score: reportData.score,
      friendly: reportData.sentiment.friendly,
      neutral: reportData.sentiment.neutral,
      unfriendly: reportData.sentiment.unfriendly,
      flagged_count: reportData.flaggedMessages ? reportData.flaggedMessages.length : 0,
      sensitivity: reportData.sensitivity,
      timeframe: reportData.timeframe,
      toxicity_types: reportData.toxicityTypes ? JSON.stringify(reportData.toxicityTypes) : null
    });
    if (error) console.error('Supabase save error:', error);
  } catch (error) {
    console.error('saveReport error:', error);
  }
}

async function getReportHistory(serverId, channelName = null, limit = 10, daysBack = null) {
  try {
    let query = supabase.from('reports').select('*').eq('server_id', serverId);
    if (channelName) query = query.eq('channel_name', channelName);
    if (daysBack) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - daysBack);
      query = query.gte('created_at', cutoff.toISOString());
    }
    const { data, error } = await query.order('created_at', { ascending: false }).limit(limit);
    if (error) { console.error('Supabase fetch error:', error); return []; }
    return data || [];
  } catch (error) {
    console.error('getReportHistory error:', error);
    return [];
  }
}

// ============================================
// CHART & EMAIL
// ============================================

function generateChartUrl(reports) {
  if (!reports || reports.length === 0) return null;
  const chronological = [...reports].reverse();
  const labels = chronological.map(r => {
    try { return new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
    catch { return 'N/A'; }
  });
  const scores = chronological.map(r => clamp(parseFloat(r.score) || 0, 0, 10));
  const flagged = chronological.map(r => Math.max(0, r.flagged_count || 0));
  const chartConfig = {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Score', data: scores, borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.1)', fill: true, tension: 0.3, yAxisID: 'y' },
        { label: 'Flagged', data: flagged, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.1)', fill: false, tension: 0.3, yAxisID: 'y1' }
      ]
    },
    options: {
      scales: {
        y: { type: 'linear', position: 'left', min: 0, max: 10, title: { display: true, text: 'Score' } },
        y1: { type: 'linear', position: 'right', min: 0, title: { display: true, text: 'Flagged' }, grid: { drawOnChartArea: false } }
      },
      plugins: { title: { display: true, text: 'Community Health Trend' } }
    }
  };
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=500&h=300&bkg=white`;
}

async function sendFreeTrialStartEmail(serverName, serverId, userName, userId) {
  try {
    const { error } = await resend.emails.send({
      from: 'VibeCheck <noreply@felixagaming.com>',
      to: CONFIG.REPORT_EMAIL,
      subject: `🆕 New Free Trial Started: ${serverName}`,
      html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;"><div style="background: linear-gradient(135deg, #3b82f6, #1d4ed8); padding: 20px; text-align: center;"><h1 style="color: white; margin: 0;">🆕 New Free Trial</h1></div><div style="padding: 20px; background: #f9fafb;"><h2 style="margin-top: 0;">A new server started their free trial!</h2><p><strong>Server:</strong> ${serverName}</p><p><strong>Server ID:</strong> ${serverId}</p><p><strong>Free reports:</strong> 5</p></div><div style="padding: 20px; background: #eff6ff;"><p style="margin: 0;">💡 This is report #1 of 5 free reports.</p></div></div>`
    });
    if (error) console.error('Free trial email error:', error);
  } catch (error) {
    console.error('sendFreeTrialStartEmail error:', error);
  }
}

async function sendTrialEndedEmail(serverName, serverId, userName) {
  try {
    const { error } = await resend.emails.send({
      from: 'VibeCheck <noreply@felixagaming.com>',
      to: CONFIG.REPORT_EMAIL,
      subject: `🔔 Trial Ended: ${serverName}`,
      html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;"><div style="background: linear-gradient(135deg, #f59e0b, #d97706); padding: 20px; text-align: center;"><h1 style="color: white; margin: 0;">🔔 Trial Ended</h1></div><div style="padding: 20px; background: #f9fafb;"><h2 style="margin-top: 0;">A server just finished their free trial!</h2><p><strong>Server:</strong> ${serverName}</p><p><strong>Server ID:</strong> ${serverId}</p><p><strong>Last used by:</strong> ${userName}</p><p><strong>Reports used:</strong> 5/5</p></div><div style="padding: 20px; background: #fef3c7;"><p style="margin: 0;">💰 They've been shown the Stripe link.</p><p style="margin-top: 10px;"><strong>To approve:</strong> <code>/vibe-admin approve ${serverId}</code></p></div></div>`
    });
    if (error) console.error('Trial ended email error:', error);
  } catch (error) {
    console.error('sendTrialEndedEmail error:', error);
  }
}

async function sendProgressReportEmail(serverName, serverId, channelName, reports, requestedBy) {
  try {
    if (!reports || reports.length < 2) return;
    const chronological = [...reports].reverse();
    const firstScore = clamp(parseFloat(chronological[0].score) || 0, 0, 10);
    const lastScore = clamp(parseFloat(chronological[chronological.length - 1].score) || 0, 0, 10);
    const scoreDiff = (lastScore - firstScore).toFixed(1);
    const trendEmoji = scoreDiff > 0 ? '📈' : scoreDiff < 0 ? '📉' : '➡️';
    const firstDate = new Date(chronological[0].created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const lastDate = new Date(chronological[chronological.length - 1].created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const totalFlagged = chronological.reduce((sum, r) => sum + (r.flagged_count || 0), 0);
    let scoreColor = '#22c55e';
    if (scoreDiff < 0) scoreColor = '#ef4444';
    else if (scoreDiff == 0) scoreColor = '#6b7280';
    const title = channelName ? `Progress: #${channelName}` : 'Progress Report';
    const { error } = await resend.emails.send({
      from: 'VibeCheck <noreply@felixagaming.com>',
      to: CONFIG.REPORT_EMAIL,
      subject: `📈 VibeCheck Progress: ${serverName} (${firstScore} → ${lastScore})`,
      html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;"><div style="background: linear-gradient(135deg, #22c55e, #16a34a); padding: 20px; text-align: center;"><h1 style="color: white; margin: 0;">📈 ${title}</h1></div><div style="background: ${scoreColor}; padding: 15px; text-align: center;"><h2 style="color: white; margin: 0; font-size: 28px;">${trendEmoji} ${firstScore} → ${lastScore} (${scoreDiff > 0 ? '+' : ''}${scoreDiff})</h2></div><div style="padding: 20px; background: #f9fafb;"><p><strong>Server:</strong> ${serverName}</p><p><strong>Server ID:</strong> ${serverId}</p><p><strong>Requested by:</strong> ${requestedBy}</p><p><strong>Reports:</strong> ${reports.length} (${firstDate} - ${lastDate})</p><p><strong>Total Flagged:</strong> ${totalFlagged}</p></div></div>`
    });
    if (error) console.error('Progress email error:', error);
  } catch (error) {
    console.error('sendProgressReportEmail error:', error);
  }
}

async function sendReportEmail(reportData) {
  try {
    const { serverName, serverId, channelName, messageCount, score, sentiment, flaggedMessages, toxicityTypes, recommendation, remaining, isPro, sensitivity, timeframe, visibility } = reportData;
    const flaggedSummary = flaggedMessages?.length > 0
      ? flaggedMessages.slice(0, 10).map((m, i) => `${i + 1}. ${m.type || 'Unknown'} (severity: ${m.severity || 'N/A'})`).join('<br>')
      : 'None';
    const toxicityList = toxicityTypes && Object.keys(toxicityTypes).length > 0
      ? Object.entries(toxicityTypes).sort((a, b) => b[1] - a[1]).map(([type, count]) => `${type}: ${count}`).join('<br>')
      : 'None';
    const sensitivityLabel = { low: '🎮 Low', medium: '⚖️ Medium', high: '👶 High' }[sensitivity] || '⚖️ Medium';
    const timeframeLabel = { '1h': '1 hour', '24h': '24 hours', '7d': '7 days', '30d': '30 days' }[timeframe] || timeframe;
    const visibilityLabel = visibility === 'private' ? '🔒 Private' : '📢 Public';
    const total = (sentiment.friendly || 0) + (sentiment.neutral || 0) + (sentiment.unfriendly || 0);
    const friendlyPct = safePercentage(sentiment.friendly, total);
    const neutralPct = safePercentage(sentiment.neutral, total);
    const unfriendlyPct = safePercentage(sentiment.unfriendly, total);
    let scoreColor = '#22c55e';
    if (score < 4) scoreColor = '#ef4444';
    else if (score < 6) scoreColor = '#f59e0b';
    const { error } = await resend.emails.send({
      from: 'VibeCheck <noreply@felixagaming.com>',
      to: CONFIG.REPORT_EMAIL,
      subject: `📊 VibeCheck: ${serverName} (${score}/10) - #${channelName}`,
      html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;"><div style="background: linear-gradient(135deg, #22c55e, #16a34a); padding: 20px; text-align: center;"><h1 style="color: white; margin: 0;">📊 VibeCheck Report</h1></div><div style="background: ${scoreColor}; padding: 15px; text-align: center;"><h2 style="color: white; margin: 0; font-size: 36px;">${score}/10</h2></div><div style="padding: 20px; background: #f9fafb;"><p><strong>Server ID:</strong> ${serverId}</p><p><strong>Channel:</strong> #${channelName}</p><p><strong>Messages:</strong> ${messageCount}</p><p><strong>Timeframe:</strong> ${timeframeLabel}</p><p><strong>Sensitivity:</strong> ${sensitivityLabel}</p><p><strong>Visibility:</strong> ${visibilityLabel}</p><p><strong>Plan:</strong> ${isPro ? '⚡ Pro' : '🎁 Free'} (${remaining} left)</p></div><div style="padding: 20px;"><h3>Sentiment</h3><p>🟢 ${sentiment.friendly || 0} (${friendlyPct}%) · ⚪ ${sentiment.neutral || 0} (${neutralPct}%) · 🔴 ${sentiment.unfriendly || 0} (${unfriendlyPct}%)</p></div><div style="padding: 20px; background: #fef2f2;"><h3>🚩 Flagged Types (${flaggedMessages?.length || 0})</h3><p>${flaggedSummary}</p></div><div style="padding: 20px;"><h3>Toxicity Types</h3><p>${toxicityList}</p></div><div style="padding: 20px; background: #eff6ff;"><h3>💡 Recommendation</h3><p>${recommendation || 'None'}</p></div></div>`
    });
    if (error) console.error('Report email error:', error);
  } catch (error) {
    console.error('sendReportEmail error:', error);
  }
}

// ============================================
// OPENAI ANALYSIS
// ============================================

async function analyzeMessages(messages, channelName, timeframe, sensitivity) {
  let sanitizedMessages = messages.map(m => sanitizeMessage(m)).filter(m => m.length > 0);
  
  if (sanitizedMessages.length > CONFIG.MAX_OPENAI_MESSAGES) {
    console.log(`⚠️ Sampling: ${sanitizedMessages.length} messages exceeds limit of ${CONFIG.MAX_OPENAI_MESSAGES}`);
    const step = Math.ceil(sanitizedMessages.length / CONFIG.MAX_OPENAI_MESSAGES);
    sanitizedMessages = sanitizedMessages.filter((_, i) => i % step === 0).slice(0, CONFIG.MAX_OPENAI_MESSAGES);
    console.log(`   Sampled down to ${sanitizedMessages.length} messages`);
  }
  
  let totalChars = sanitizedMessages.reduce((sum, m) => sum + m.length, 0);
  if (totalChars > CONFIG.MAX_OPENAI_CHARS) {
    console.log(`⚠️ Truncating: ${totalChars} chars exceeds limit of ${CONFIG.MAX_OPENAI_CHARS}`);
    const ratio = CONFIG.MAX_OPENAI_CHARS / totalChars;
    const maxPerMessage = Math.floor(500 * ratio);
    sanitizedMessages = sanitizedMessages.map(m => m.slice(0, maxPerMessage));
    totalChars = sanitizedMessages.reduce((sum, m) => sum + m.length, 0);
    console.log(`   Truncated to ${totalChars} chars`);
  }
  
  const messageCount = sanitizedMessages.length;
  const sensitivityPrompt = SENSITIVITY_PROMPTS[sensitivity] || SENSITIVITY_PROMPTS.medium;
  
  const prompt = `You are VibeCheck, a community behavior analyzer for Discord.

Analyze these ${messageCount} messages from #${channelName} (${timeframe} timeframe).

${sensitivityPrompt}

MESSAGES TO ANALYZE:
${sanitizedMessages.map((m, i) => `[${i + 1}] ${m}`).join('\n')}

Return ONLY valid JSON (no markdown, no explanation) in this exact format:
{
  "friendlinessScore": 7.2,
  "sentiment": { "friendly": 5, "neutral": 3, "unfriendly": 2 },
  "flaggedMessages": [{ "text": "exact quote", "type": "Harassment", "severity": 9.5 }],
  "toxicityTypes": { "Insults": 2, "Harassment": 1 },
  "recommendation": "One sentence of advice."
}

RULES:
1. friendly + neutral + unfriendly MUST equal ${messageCount}
2. Flag ALL messages violating guidelines, sort by severity
3. Severity: 10=death threats, 9=racism/threats, 8=insults, 7=bullying, 6=mild negativity
4. Types: Insults, Harassment, Xenophobia, Racism, Homophobia, Bullying, Threats, Spam, Profanity, Negativity`;

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1500,
        temperature: 0.1
      });

      const text = response.choices[0].message.content;
      const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const result = JSON.parse(cleaned);
      
      result.friendlinessScore = clamp(result.friendlinessScore ?? 5, 0, 10);
      result.sentiment = result.sentiment || { friendly: 0, neutral: messageCount, unfriendly: 0 };
      result.flaggedMessages = result.flaggedMessages || [];
      result.toxicityTypes = result.toxicityTypes || {};
      result.recommendation = result.recommendation || 'Continue monitoring your community.';
      
      const sentimentTotal = (result.sentiment.friendly || 0) + (result.sentiment.neutral || 0) + (result.sentiment.unfriendly || 0);
      if (sentimentTotal !== messageCount && sentimentTotal > 0) {
        const ratio = messageCount / sentimentTotal;
        result.sentiment.friendly = Math.round((result.sentiment.friendly || 0) * ratio);
        result.sentiment.neutral = Math.round((result.sentiment.neutral || 0) * ratio);
        result.sentiment.unfriendly = messageCount - result.sentiment.friendly - result.sentiment.neutral;
      } else if (sentimentTotal === 0) {
        result.sentiment = { friendly: 0, neutral: messageCount, unfriendly: 0 };
      }
      
      // Attach token usage for cost tracking
      result._usage = {
        input_tokens: response.usage?.prompt_tokens || 0,
        output_tokens: response.usage?.completion_tokens || 0
      };
      
      return result;
    } catch (error) {
      lastError = error;
      console.error(`OpenAI API error (attempt ${attempt}/3):`, error.message);
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }
  
  console.error('OpenAI API failed after 3 attempts:', lastError);
  throw new Error('Analysis failed after multiple attempts. Please try again later.');
}

// ============================================
// DISCORD BOT SETUP
// ============================================

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages]
});

// ============================================
// REGISTER COMMANDS
// ============================================

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('vibe')
      .setDescription('Check how friendly your community is')
      .addChannelOption(opt => opt.setName('channel').setDescription('Channel to analyze').setRequired(false).addChannelTypes(ChannelType.GuildText))
      .addStringOption(opt => opt.setName('timeframe').setDescription('How far back?').setRequired(false)
        .addChoices(
          { name: '⏱️ 1 hour', value: '1h' }, 
          { name: '⏱️ 12 hours', value: '12h' }, 
          { name: '⏱️ 24 hours (default)', value: '24h' }, 
          { name: '📅 3 days', value: '3d' }, 
          { name: '📅 7 days', value: '7d' }, 
          { name: '📅 30 days', value: '30d' }
        ))
      .addStringOption(opt => opt.setName('messages').setDescription('Messages to analyze').setRequired(false)
        .addChoices(
          { name: '💬 20 messages', value: '20' },
          { name: '💬 50 messages', value: '50' }, 
          { name: '💬 100 messages (default)', value: '100' }, 
          { name: '💬 150 messages', value: '150' }, 
          { name: '💬 200 messages', value: '200' }, 
          { name: '📊 500 messages', value: '500' }, 
          { name: '📊 1000 messages', value: '1000' }
        ))
      .addStringOption(opt => opt.setName('sensitivity').setDescription('How strict?').setRequired(false)
        .addChoices({ name: '🎮 Low - Gaming/Adult', value: 'low' }, { name: '⚖️ Medium - General (default)', value: 'medium' }, { name: '👶 High - Kids/Family', value: 'high' }))
      .addStringOption(opt => opt.setName('visibility').setDescription('Who sees the report?').setRequired(false)
        .addChoices({ name: '📢 Public (stays in channel)', value: 'public' }, { name: '🔒 Private (only you)', value: 'private' })),
    
    new SlashCommandBuilder()
      .setName('vibe-progress')
      .setDescription('See your community progress')
      .addChannelOption(opt => opt.setName('channel').setDescription('Channel to analyze').setRequired(false).addChannelTypes(ChannelType.GuildText))
      .addStringOption(opt => opt.setName('range').setDescription('Time range').setRequired(false)
        .addChoices({ name: '📅 Last 24 hours', value: '1d' }, { name: '📅 Last 14 days', value: '14d' }, { name: '📅 Last 30 days', value: '30d' }, { name: '✏️ Custom # of reports', value: 'custom' })),
    
    new SlashCommandBuilder()
      .setName('vibe-admin')
      .setDescription('Admin controls (owner only)')
      .addStringOption(opt => opt.setName('action').setDescription('Action to perform').setRequired(true)
        .addChoices(
          { name: '✅ Approve server (Pro)', value: 'approve' },
          { name: '❌ Deny server', value: 'deny' },
          { name: '🔄 Reset to pending', value: 'reset' },
          { name: '🎁 Reset free trial', value: 'freetrial' },
          { name: '📈 Grant progress access', value: 'grant_progress' },
          { name: '🚫 Revoke progress access', value: 'revoke_progress' },
          { name: '🔄 Renew subscription', value: 'renew' },
          { name: '📊 Check status', value: 'status' },
          { name: '🗑️ Delete all server data (GDPR)', value: 'delete_data' }
        ))
      .addStringOption(opt => opt.setName('server_id').setDescription('Server ID').setRequired(true))
      .addIntegerOption(opt => opt.setName('days').setDescription('Subscription length in days (default: 30)').setRequired(false))
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('📝 Registering commands...');
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands.map(c => c.toJSON()) });
    console.log('✅ Commands registered!');
  } catch (error) {
    console.error('❌ Failed to register commands:', error);
  }
}

// ============================================
// STARTUP VALIDATION
// ============================================

function validateEnvironment() {
  const required = ['DISCORD_TOKEN', 'CLIENT_ID', 'OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_KEY'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error('❌ FATAL: Missing required environment variables:');
    missing.forEach(key => console.error(`   - ${key}`));
    process.exit(1);
  }
  
  if (CONFIG.STRIPE_YEARLY_LINK.includes('YOUR_YEARLY_LINK_HERE')) {
    console.warn('⚠️  Yearly plan DISABLED - placeholder link detected');
    CONFIG.YEARLY_ENABLED = false;
  } else {
    CONFIG.YEARLY_ENABLED = true;
    console.log('✅ Yearly plan enabled');
  }
  
  const supabaseKey = process.env.SUPABASE_KEY || '';
  if (supabaseKey.includes('service_role') || supabaseKey.length > 200) {
    console.error('');
    console.error('⚠️  SECURITY WARNING: You may be using a service_role key!');
    console.error('');
  }
  
  console.log('✅ Environment validated');
}

validateEnvironment();

async function checkMessageContentIntent(client) {
  try {
    const guild = client.guilds.cache.first();
    if (!guild) return;
    const channel = guild.channels.cache.find(c => 
      c.type === ChannelType.GuildText && 
      c.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.ViewChannel)
    );
    if (!channel) return;
    const messages = await channel.messages.fetch({ limit: 1 });
    const msg = messages.first();
    if (msg && msg.content === '' && !msg.embeds.length && !msg.attachments.size) {
      console.error('⚠️  MESSAGE CONTENT INTENT MAY BE DISABLED');
    }
  } catch (error) {}
}

// ============================================
// BOT READY
// ============================================

client.once('ready', async () => {
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ✅ VIBECHECK IS ONLINE');
  console.log(`  Bot: ${client.user.tag}`);
  console.log(`  Servers: ${client.guilds.cache.size}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  await checkMessageContentIntent(client);
  registerCommands();
});

// ============================================
// WELCOME MESSAGE
// ============================================

client.on('guildCreate', async (guild) => {
  try {
    console.log(`📥 Joined: ${guild.name}`);
    const channel = guild.systemChannel || guild.channels.cache.find(c => 
      c.type === ChannelType.GuildText && 
      c.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages)
    );
    if (channel) {
      const embed = new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle('👋 VibeCheck is here!')
        .setDescription('Type `/vibe` to check your community.\n\n🎮 **Low** - Gaming\n⚖️ **Medium** - General\n👶 **High** - Kids')
        .setFooter({ text: 'How friendly is your community?' });
      await channel.send({ embeds: [embed] });
    }
  } catch (error) {
    console.error('guildCreate error:', error);
  }
});

// ============================================
// REPORT DESIGN SYSTEM
// ============================================

const REPORT_COLORS = {
  excellent: 0x059669,
  good: 0x0d9488,
  moderate: 0x6b7280,
  attention: 0xd97706,
  concern: 0xb45309,
  neutral: 0x4b5563,
  accent: 0x6366f1
};

function getScoreBand(score) {
  if (score >= 8) return { color: REPORT_COLORS.excellent, label: 'Healthy', description: 'Conversation patterns indicate a constructive environment.' };
  if (score >= 6) return { color: REPORT_COLORS.good, label: 'Stable', description: 'Generally positive dynamics with some areas for attention.' };
  if (score >= 4) return { color: REPORT_COLORS.moderate, label: 'Mixed', description: 'Varied interaction patterns observed across the sample.' };
  if (score >= 2) return { color: REPORT_COLORS.attention, label: 'Elevated', description: 'Notable patterns may benefit from community guidance.' };
  return { color: REPORT_COLORS.concern, label: 'Needs Review', description: 'Patterns suggest proactive moderation may be beneficial.' };
}

function getGrade(score) {
  if (score >= 9) return { grade: 'A+', emoji: '◆', color: REPORT_COLORS.excellent, label: 'Exceptional' };
  if (score >= 8) return { grade: 'A', emoji: '◆', color: REPORT_COLORS.excellent, label: 'Excellent' };
  if (score >= 7) return { grade: 'B+', emoji: '◇', color: REPORT_COLORS.good, label: 'Great' };
  if (score >= 6) return { grade: 'B', emoji: '◇', color: REPORT_COLORS.good, label: 'Good' };
  if (score >= 5) return { grade: 'C', emoji: '○', color: REPORT_COLORS.moderate, label: 'Average' };
  if (score >= 4) return { grade: 'D', emoji: '○', color: REPORT_COLORS.attention, label: 'Needs Work' };
  return { grade: 'F', emoji: '●', color: REPORT_COLORS.concern, label: 'Critical' };
}

function generateToneChart(friendly, neutral, unfriendly) {
  const total = friendly + neutral + unfriendly;
  if (total === 0) return null;
  const config = {
    type: 'bar',
    data: {
      labels: [''],
      datasets: [
        { label: 'Positive', data: [friendly], backgroundColor: '#059669' },
        { label: 'Neutral', data: [neutral], backgroundColor: '#9ca3af' },
        { label: 'Negative', data: [unfriendly], backgroundColor: '#dc7b68' }
      ]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, datalabels: { display: true, color: '#fff', font: { weight: 'bold', size: 14 }, formatter: (value) => value > 0 ? `${Math.round(value / total * 100)}%` : '' } },
      scales: { x: { stacked: true, display: false, max: total }, y: { stacked: true, display: false } }
    }
  };
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}&w=500&h=60&bkg=transparent`;
}

function generateBehaviorChart(toxicityTypes) {
  if (!toxicityTypes || Object.keys(toxicityTypes).length === 0) return null;
  const sorted = Object.entries(toxicityTypes).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const labels = sorted.map(([type]) => type);
  const data = sorted.map(([, count]) => count);
  const config = {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: '#6b7280', borderRadius: 4 }] },
    options: {
      indexAxis: 'y',
      responsive: true,
      plugins: { legend: { display: false }, datalabels: { display: true, anchor: 'end', align: 'end', color: '#374151', font: { size: 12 } } },
      scales: { x: { display: false, beginAtZero: true }, y: { grid: { display: false }, ticks: { color: '#374151', font: { size: 12 } } } }
    }
  };
  const height = 40 + (sorted.length * 28);
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}&w=450&h=${height}&bkg=transparent`;
}

function generateTrendChart(reports, type = 'score') {
  if (!reports || reports.length < 2) return null;
  const chronological = [...reports].reverse();
  const labels = chronological.map(r => { try { return new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch { return ''; } });
  
  if (type === 'score') {
    const scores = chronological.map(r => clamp(parseFloat(r.score) || 0, 0, 10));
    const flagged = chronological.map(r => Math.max(0, r.flagged_count || 0));
    return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify({
      type: 'line',
      data: { labels, datasets: [
        { label: 'Health Score', data: scores, borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.1)', fill: true, tension: 0.4, yAxisID: 'y' },
        { label: 'Flagged Messages', data: flagged, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.1)', fill: false, tension: 0.4, yAxisID: 'y1' }
      ]},
      options: { plugins: { title: { display: true, text: '📊 Community Health Trend', font: { size: 16 } } }, scales: { y: { type: 'linear', position: 'left', min: 0, max: 10, title: { display: true, text: 'Score' } }, y1: { type: 'linear', position: 'right', min: 0, title: { display: true, text: 'Flagged' }, grid: { drawOnChartArea: false } } } }
    }))}&w=600&h=300&bkg=white`;
  }
  
  if (type === 'sentiment') {
    const friendly = chronological.map(r => { const total = (r.friendly || 0) + (r.neutral || 0) + (r.unfriendly || 0); return total > 0 ? Math.round((r.friendly / total) * 100) : 0; });
    const unfriendly = chronological.map(r => { const total = (r.friendly || 0) + (r.neutral || 0) + (r.unfriendly || 0); return total > 0 ? Math.round((r.unfriendly / total) * 100) : 0; });
    return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify({
      type: 'line',
      data: { labels, datasets: [
        { label: 'Friendly %', data: friendly, borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.2)', fill: true, tension: 0.4 },
        { label: 'Unfriendly %', data: unfriendly, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.2)', fill: true, tension: 0.4 }
      ]},
      options: { plugins: { title: { display: true, text: '💬 Sentiment Trend', font: { size: 16 } } }, scales: { y: { min: 0, max: 100, title: { display: true, text: 'Percentage' } } } }
    }))}&w=600&h=250&bkg=white`;
  }
  return null;
}

function generateToxicityChart(toxicityData) {
  if (!toxicityData || Object.keys(toxicityData).length === 0) return null;
  const sorted = Object.entries(toxicityData).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const labels = sorted.map(([type]) => type);
  const data = sorted.map(([, count]) => count);
  const colors = ['#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#14b8a6', '#3b82f6'];
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify({
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors.slice(0, data.length) }] },
    options: { plugins: { title: { display: true, text: '⚠️ Toxicity Breakdown', font: { size: 16 } }, legend: { position: 'right' } } }
  }))}&w=400&h=250&bkg=white`;
}

function generateChannelChart(channelStats) {
  if (!channelStats || Object.keys(channelStats).length === 0) return null;
  const sorted = Object.entries(channelStats).sort((a, b) => (b[1].totalScore / b[1].count) - (a[1].totalScore / a[1].count)).slice(0, 8);
  const labels = sorted.map(([ch]) => `#${ch}`);
  const scores = sorted.map(([, s]) => (s.totalScore / s.count).toFixed(1));
  const colors = scores.map(s => { if (s >= 7) return '#22c55e'; if (s >= 5) return '#f59e0b'; return '#ef4444'; });
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify({
    type: 'bar',
    data: { labels, datasets: [{ label: 'Avg Score', data: scores, backgroundColor: colors }] },
    options: { indexAxis: 'y', plugins: { title: { display: true, text: '📍 Channel Health Ranking', font: { size: 16 } } }, scales: { x: { min: 0, max: 10, title: { display: true, text: 'Score' } } } }
  }))}&w=500&h=300&bkg=white`;
}

async function generateAIInsights(data) {
  try {
    const prompt = `You are a community health analyst. Based on this Discord server data, provide 3 specific, actionable insights to reduce toxicity.

DATA:
- Average Score: ${data.avgScore}/10
- Score Trend: ${data.scoreTrend > 0 ? 'Improving' : data.scoreTrend < 0 ? 'Declining' : 'Stable'} (${data.scoreTrend > 0 ? '+' : ''}${data.scoreTrend})
- Total Flagged Messages: ${data.totalFlagged}
- Top Toxicity Types: ${data.topToxicity.join(', ') || 'None'}
- Worst Channel: #${data.worstChannel?.name || 'N/A'} (${data.worstChannel?.score || 'N/A'}/10)
- Best Channel: #${data.bestChannel?.name || 'N/A'} (${data.bestChannel?.score || 'N/A'}/10)
- Total Reports: ${data.totalReports}
- Friendly %: ${data.friendlyPct}%
- Unfriendly %: ${data.unfriendlyPct}%

Return ONLY a JSON array with 3 objects, each with "icon" (emoji), "title" (5 words max), and "tip" (15 words max):
[{"icon":"💡","title":"Example Title","tip":"Specific actionable advice here."}]`;

    const response = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 300, temperature: 0.7 });
    const text = response.choices[0].message.content;
    const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (error) {
    console.error('AI insights error:', error);
    return [
      { icon: '💡', title: 'Monitor Problem Channels', tip: 'Focus moderation on channels with lowest scores.' },
      { icon: '🎯', title: 'Address Top Issues', tip: 'Create rules targeting your most common toxicity types.' },
      { icon: '📈', title: 'Track Progress Weekly', tip: 'Run reports regularly to measure improvement.' }
    ];
  }
}

function canReadChannel(channel, guild) {
  try {
    const permissions = channel.permissionsFor(guild.members.me);
    return permissions && permissions.has(PermissionFlagsBits.ViewChannel) && permissions.has(PermissionFlagsBits.ReadMessageHistory);
  } catch (error) {
    return false;
  }
}

// ============================================
// BUILD PROGRESS EMBEDS
// ============================================

async function buildProgressEmbeds(serverId, serverName, channelName, reports) {
  if (!reports || reports.length === 0) return null;
  
  const embeds = [];
  const chronological = [...reports].reverse();
  
  let firstDate = 'N/A', lastDate = 'N/A';
  try {
    firstDate = new Date(chronological[0].created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    lastDate = new Date(chronological[chronological.length - 1].created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch (e) {}
  
  const scores = chronological.map(r => clamp(parseFloat(r.score) || 0, 0, 10));
  const firstScore = scores[0];
  const lastScore = scores[scores.length - 1];
  const avgScore = (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1);
  const minScore = Math.min(...scores).toFixed(1);
  const maxScore = Math.max(...scores).toFixed(1);
  const scoreTrend = (lastScore - firstScore).toFixed(1);
  
  const gradeInfo = getGrade(parseFloat(avgScore));
  
  let totalFriendly = 0, totalNeutral = 0, totalUnfriendly = 0;
  chronological.forEach(r => { totalFriendly += r.friendly || 0; totalNeutral += r.neutral || 0; totalUnfriendly += r.unfriendly || 0; });
  const totalMessages = totalFriendly + totalNeutral + totalUnfriendly;
  const friendlyPct = safePercentage(totalFriendly, totalMessages);
  const neutralPct = safePercentage(totalNeutral, totalMessages);
  const unfriendlyPct = safePercentage(totalUnfriendly, totalMessages);
  
  const flaggedCounts = chronological.map(r => Math.max(0, r.flagged_count || 0));
  const totalFlagged = flaggedCounts.reduce((a, b) => a + b, 0);
  const avgFlagged = (totalFlagged / chronological.length).toFixed(1);
  
  const channelStats = {};
  chronological.forEach(r => {
    if (!channelStats[r.channel_name]) channelStats[r.channel_name] = { count: 0, totalScore: 0, totalFlagged: 0, scores: [] };
    channelStats[r.channel_name].count++;
    channelStats[r.channel_name].totalScore += parseFloat(r.score) || 0;
    channelStats[r.channel_name].totalFlagged += r.flagged_count || 0;
    channelStats[r.channel_name].scores.push(parseFloat(r.score) || 0);
  });
  
  const channelRanking = Object.entries(channelStats).map(([name, s]) => ({ name, avgScore: (s.totalScore / s.count).toFixed(1), count: s.count, flagged: s.totalFlagged })).sort((a, b) => b.avgScore - a.avgScore);
  const bestChannel = channelRanking[0];
  const worstChannel = channelRanking[channelRanking.length - 1];
  
  const allToxicity = {};
  chronological.forEach(r => {
    if (r.toxicity_types) {
      try {
        const types = typeof r.toxicity_types === 'string' ? JSON.parse(r.toxicity_types) : r.toxicity_types;
        Object.entries(types).forEach(([type, count]) => { allToxicity[type] = (allToxicity[type] || 0) + count; });
      } catch (e) {}
    }
  });
  const sortedToxicity = Object.entries(allToxicity).sort((a, b) => b[1] - a[1]);
  const totalToxicityCount = sortedToxicity.reduce((sum, [, count]) => sum + count, 0);
  
  const dayStats = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  chronological.forEach(r => { try { const day = new Date(r.created_at).getDay(); dayStats[day].push(parseFloat(r.score) || 0); } catch (e) {} });
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayAverages = Object.entries(dayStats).filter(([, scores]) => scores.length > 0).map(([day, scores]) => ({ day: dayNames[day], avg: (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1), count: scores.length })).sort((a, b) => b.avg - a.avg);
  
  // EMBED 1: OVERVIEW
  const overviewEmbed = new EmbedBuilder()
    .setColor(gradeInfo.color)
    .setTitle(`${gradeInfo.emoji} Community Health Report`)
    .setDescription(`**${serverName}**${channelName ? ` · #${channelName}` : ''}\n📅 ${firstDate} → ${lastDate} · ${reports.length} reports`)
    .addFields(
      { name: '🎯 Overall Grade', value: `\`\`\`\n   ${gradeInfo.grade}   \n${gradeInfo.label}\n\`\`\``, inline: true },
      { name: '📊 Average Score', value: `\`\`\`\n ${avgScore}/10 \n\`\`\``, inline: true },
      { name: `${scoreTrend >= 0 ? '📈' : '📉'} Trend`, value: `\`\`\`\n${scoreTrend >= 0 ? '+' : ''}${scoreTrend} \n\`\`\``, inline: true }
    )
    .addFields(
      { name: '📉 Score Range', value: `Low: **${minScore}** · High: **${maxScore}**`, inline: true },
      { name: '💬 Messages Analyzed', value: `**${totalMessages.toLocaleString()}** total`, inline: true },
      { name: '🚩 Flagged Messages', value: `**${totalFlagged}** (${avgFlagged}/report avg)`, inline: true }
    );
  const trendChart = generateTrendChart(reports, 'score');
  if (trendChart) overviewEmbed.setImage(trendChart);
  embeds.push(overviewEmbed);
  
  // EMBED 2: SENTIMENT
  const sentimentEmbed = new EmbedBuilder()
    .setColor(0x3b82f6)
    .setTitle('💬 Sentiment Analysis')
    .setDescription(`**What this shows:** The emotional tone across all ${totalMessages.toLocaleString()} messages analyzed.`)
    .addFields(
      { name: '✅ Positive', value: `**${friendlyPct}%**\n${totalFriendly.toLocaleString()} msgs`, inline: true },
      { name: '➖ Neutral', value: `**${neutralPct}%**\n${totalNeutral.toLocaleString()} msgs`, inline: true },
      { name: '❌ Negative', value: `**${unfriendlyPct}%**\n${totalUnfriendly.toLocaleString()} msgs`, inline: true }
    );
  const friendlyBar = Math.round(friendlyPct / 5);
  const neutralBar = Math.round(neutralPct / 5);
  const unfriendlyBar = Math.round(unfriendlyPct / 5);
  const visualBar = `\`${'▓'.repeat(friendlyBar)}${'░'.repeat(neutralBar)}${'█'.repeat(unfriendlyBar)}\``;
  sentimentEmbed.addFields({ name: 'Distribution Chart', value: `${visualBar}\n\`▓\` = Positive  \`░\` = Neutral  \`█\` = Negative`, inline: false });
  const sentimentChart = generateTrendChart(reports, 'sentiment');
  if (sentimentChart) sentimentEmbed.setImage(sentimentChart);
  embeds.push(sentimentEmbed);
  
  // EMBED 3: BEHAVIOR PATTERNS
  const toxicityEmbed = new EmbedBuilder()
    .setColor(0xf59e0b)
    .setTitle('📋 Behavior Patterns')
    .setDescription(totalToxicityCount > 0 ? `**What this shows:** ${totalToxicityCount} behaviors identified as coaching opportunities across all reports.` : '🌟 **Excellent!** No concerning behaviors detected.');
  if (sortedToxicity.length > 0) {
    const typeDescriptions = { 'Insults': 'Personal attacks', 'Harassment': 'Repeated targeting', 'Profanity': 'Strong language', 'Bullying': 'Intimidation', 'Threats': 'Harm implications', 'Negativity': 'Excessive pessimism', 'Spam': 'Repetitive content', 'Racism': 'Race discrimination', 'Xenophobia': 'Outsider hostility', 'Homophobia': 'LGBTQ+ hostility' };
    const topIssues = sortedToxicity.slice(0, 6).map(([type, count]) => { const pct = safePercentage(count, totalToxicityCount); const barLength = Math.max(1, Math.round(pct / 10)); const bar = '█'.repeat(barLength) + '░'.repeat(10 - barLength); const desc = typeDescriptions[type] || ''; return `\`${bar}\` **${type}** (${count}) ${pct}%${desc ? ` - _${desc}_` : ''}`; }).join('\n');
    toxicityEmbed.addFields({ name: '🎯 Focus Areas', value: topIssues, inline: false });
    const severeTypes = ['Threats', 'Harassment', 'Racism', 'Xenophobia', 'Homophobia'];
    const severeCount = sortedToxicity.filter(([type]) => severeTypes.some(s => type.toLowerCase().includes(s.toLowerCase()))).reduce((sum, [, count]) => sum + count, 0);
    if (severeCount > 0) toxicityEmbed.addFields({ name: '🚨 Severe Issues', value: `**${severeCount}** high-severity incidents`, inline: false });
  }
  const toxicityChart = generateToxicityChart(allToxicity);
  if (toxicityChart) toxicityEmbed.setImage(toxicityChart);
  embeds.push(toxicityEmbed);
  
  // EMBED 4: CHANNEL ANALYSIS
  if (Object.keys(channelStats).length > 1) {
    const channelEmbed = new EmbedBuilder().setColor(0x8b5cf6).setTitle('📍 Channel Analysis').setDescription(`Health comparison across ${Object.keys(channelStats).length} channels`);
    if (bestChannel) channelEmbed.addFields({ name: '🏆 Healthiest Channel', value: `**#${bestChannel.name}**\nScore: ${bestChannel.avgScore}/10 · ${bestChannel.count} reports · ${bestChannel.flagged} flagged`, inline: false });
    if (worstChannel && worstChannel.name !== bestChannel?.name) channelEmbed.addFields({ name: '⚠️ Needs Attention', value: `**#${worstChannel.name}**\nScore: ${worstChannel.avgScore}/10 · ${worstChannel.count} reports · ${worstChannel.flagged} flagged`, inline: false });
    const rankingText = channelRanking.slice(0, 8).map((ch, i) => { const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`; const scoreLabel = ch.avgScore >= 7 ? '✓' : ch.avgScore >= 5 ? '~' : '!'; return `${medal} \`${scoreLabel}\` **#${ch.name}** · ${ch.avgScore}/10`; }).join('\n');
    channelEmbed.addFields({ name: '📊 Full Ranking', value: `${rankingText}\n\n\`✓\` = Healthy (7+)  \`~\` = Average (5-6)  \`!\` = Needs Work (<5)`, inline: false });
    const channelChart = generateChannelChart(channelStats);
    if (channelChart) channelEmbed.setImage(channelChart);
    embeds.push(channelEmbed);
  }
  
  // EMBED 5: PATTERNS & TIMING
  if (dayAverages.length > 1) {
    const patternEmbed = new EmbedBuilder().setColor(0x14b8a6).setTitle('🕐 Behavioral Patterns').setDescription('When does toxicity peak?');
    const bestDay = dayAverages[0];
    const worstDay = dayAverages[dayAverages.length - 1];
    patternEmbed.addFields(
      { name: '✨ Best Day', value: `**${bestDay.day}**\n${bestDay.avg}/10 avg`, inline: true },
      { name: '⚠️ Watch Out', value: `**${worstDay.day}**\n${worstDay.avg}/10 avg`, inline: true },
      { name: '📈 Difference', value: `**${(bestDay.avg - worstDay.avg).toFixed(1)}** points`, inline: true }
    );
    const dayBreakdown = dayAverages.map(d => { const symbol = d.avg >= 7 ? '✓' : d.avg >= 5 ? '~' : '!'; return `\`${symbol}\` ${d.day.slice(0, 3)}: ${d.avg}`; }).join(' · ');
    patternEmbed.addFields({ name: 'Weekly Overview', value: `${dayBreakdown}\n\n\`✓\` = Healthy  \`~\` = Average  \`!\` = Needs Work`, inline: false });
    embeds.push(patternEmbed);
  }
  
  // EMBED 6: AI INSIGHTS
  const aiData = { avgScore, scoreTrend: parseFloat(scoreTrend), totalFlagged, topToxicity: sortedToxicity.slice(0, 3).map(([type]) => type), worstChannel: worstChannel ? { name: worstChannel.name, score: worstChannel.avgScore } : null, bestChannel: bestChannel ? { name: bestChannel.name, score: bestChannel.avgScore } : null, totalReports: reports.length, friendlyPct, unfriendlyPct };
  const insights = await generateAIInsights(aiData);
  const insightsEmbed = new EmbedBuilder().setColor(0xf59e0b).setTitle('💡 AI Recommendations').setDescription('Personalized action items to improve your community');
  insights.forEach((insight) => { insightsEmbed.addFields({ name: `${insight.icon} ${insight.title}`, value: insight.tip, inline: false }); });
  let quickWins = [];
  if (worstChannel && parseFloat(worstChannel.avgScore) < 5) quickWins.push(`Focus moderation on #${worstChannel.name}`);
  if (sortedToxicity.length > 0) quickWins.push(`Create rules addressing ${sortedToxicity[0][0].toLowerCase()}`);
  if (unfriendlyPct > 20) quickWins.push('Consider adding positive reinforcement bot');
  if (quickWins.length > 0) insightsEmbed.addFields({ name: '🎯 Quick Wins', value: quickWins.map(w => `• ${w}`).join('\n'), inline: false });
  insightsEmbed.setFooter({ text: '🔄 Run /vibe regularly to track improvement!' });
  embeds.push(insightsEmbed);
  
  return embeds;
}

async function buildProgressEmbed(serverId, serverName, channelName, reports) {
  const embeds = await buildProgressEmbeds(serverId, serverName, channelName, reports);
  return embeds ? embeds[0] : null;
}

// ============================================
// RUN VIBE ANALYSIS
// ============================================

async function runVibeAnalysis(interaction, options) {
  const { channel, visibility, sensitivity, timeframe, messageCount, startDate, endDate } = options;
  const serverId = interaction.guildId;
  const serverName = interaction.guild.name;
  const userId = interaction.user.id;
  const approved = await isApproved(serverId);
  const isPrivate = visibility === 'private';
  
  let actualMessageCount = messageCount;
  let actualTimeframe = timeframe;
  
  if (!approved) {
    if (actualMessageCount > CONFIG.FREE_MAX_MESSAGES) actualMessageCount = CONFIG.FREE_MAX_MESSAGES;
    if (actualTimeframe === '30d') actualTimeframe = '7d';
  }

  setCooldown(serverId, userId);
  recordServerRequest(serverId);
  
  const processingStartTime = Date.now();

  try {
    if (!canReadChannel(channel, interaction.guild)) {
      return interaction.editReply('❌ I don\'t have permission to read that channel.');
    }

    await interaction.editReply('📡 **Step 1/3:** Fetching messages from channel...');

    let cutoffTime = 0, afterTime = null, beforeTime = null;

    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) return interaction.editReply('❌ Invalid date. Use YYYY-MM-DD');
      if (start > end) return interaction.editReply('❌ Start must be before end.');
      afterTime = start.getTime();
      beforeTime = end.getTime() + 86400000 - 1;
      actualTimeframe = `${startDate} to ${endDate}`;
    } else {
      const timeMs = { '1h': 3600000, '12h': 43200000, '24h': 86400000, '3d': 259200000, '7d': 604800000, '30d': 2592000000 }[actualTimeframe] || 86400000;
      cutoffTime = Date.now() - timeMs;
    }

    let allMessages = [];
    let lastId;
    let fetchAttempts = 0;
    let totalFetched = 0;
    let botMessages = 0;
    let emptyMessages = 0;
    let outsideTimeframe = 0;

    while (allMessages.length < actualMessageCount && fetchAttempts < 20) {
      fetchAttempts++;
      if (fetchAttempts % 5 === 0 || fetchAttempts === 1) {
        await interaction.editReply(`📡 **Step 1/3:** Fetching messages... (${allMessages.length} found)`);
      }
      try {
        const fetchOptions = { limit: 100 };
        if (lastId) fetchOptions.before = lastId;
        const fetched = await channel.messages.fetch(fetchOptions);
        if (fetched.size === 0) break;
        totalFetched += fetched.size;
        for (const m of fetched.values()) {
          if (m.author.bot) { botMessages++; continue; }
          if (!m.content || m.content.trim().length === 0) { emptyMessages++; continue; }
          let inTimeframe = true;
          if (afterTime && beforeTime) inTimeframe = m.createdTimestamp >= afterTime && m.createdTimestamp <= beforeTime;
          else if (cutoffTime) inTimeframe = m.createdTimestamp > cutoffTime;
          if (!inTimeframe) { outsideTimeframe++; continue; }
          allMessages.push(m.content);
        }
        lastId = fetched.last().id;
        const lastTimestamp = fetched.last().createdTimestamp;
        if ((afterTime && lastTimestamp < afterTime) || (!afterTime && cutoffTime && lastTimestamp < cutoffTime)) break;
      } catch (fetchError) {
        console.error('Message fetch error:', fetchError);
        break;
      }
    }

    allMessages = allMessages.slice(0, actualMessageCount);

    if (allMessages.length < 1) {
      let reason = '';
      if (totalFetched === 0) reason = 'No messages exist in this channel.';
      else if (botMessages > 0 && botMessages === totalFetched) reason = `Found ${botMessages} messages, but all are from bots.`;
      else if (outsideTimeframe > 0) reason = `Found ${totalFetched} messages, but none within the ${actualTimeframe} timeframe.`;
      else if (emptyMessages > 0) reason = `Found ${totalFetched} messages, but all are empty or attachments-only.`;
      else reason = 'Try a longer timeframe or different channel.';
      return interaction.editReply(`❌ No analyzable messages found.\n\n${reason}`);
    }

    const usageBefore = await getUsage(serverId);
    const isFirstReport = usageBefore.reports_used === 0;

    await interaction.editReply(`🔍 **Step 2/3:** Analyzing ${allMessages.length} messages with AI...`);

    const analysis = await analyzeMessages(allMessages, channel.name, actualTimeframe, sensitivity);
    await useReport(serverId);
    const remaining = await getReportsRemaining(serverId, interaction.user.id);
    
    if (isFirstReport && !approved && interaction.user.id !== CONFIG.OWNER_ID) {
      await sendFreeTrialStartEmail(serverName, serverId, interaction.user.username, interaction.user.id);
    }
    if (!approved && remaining === 0 && interaction.user.id !== CONFIG.OWNER_ID) {
      await sendTrialEndedEmail(serverName, serverId, interaction.user.username);
    }

    await interaction.editReply('📊 **Step 3/3:** Building your report...');

    await saveReport({ serverId, channelName: channel.name, score: analysis.friendlinessScore.toFixed(1), sentiment: analysis.sentiment, flaggedMessages: analysis.flaggedMessages, toxicityTypes: analysis.toxicityTypes, sensitivity, timeframe: actualTimeframe });

    // Research logging (privacy-safe)
    const processingEndTime = Date.now();
    const inputTokens = analysis._usage?.input_tokens || 0;
    const outputTokens = analysis._usage?.output_tokens || 0;
    const costUsd = calculateCost(inputTokens, outputTokens);
    
    await logResearchData({
      serverId,
      userId: interaction.user.id,
      channelId: channel.id,
      messagesAnalyzed: allMessages.length,
      timeframe: actualTimeframe,
      sensitivity,
      visibility,
      isPro: approved,
      score: parseFloat(analysis.friendlinessScore.toFixed(1)),
      friendly: analysis.sentiment.friendly || 0,
      neutral: analysis.sentiment.neutral || 0,
      unfriendly: analysis.sentiment.unfriendly || 0,
      flaggedCount: analysis.flaggedMessages?.length || 0,
      toxicityTypes: analysis.toxicityTypes || {},
      processingTimeMs: processingEndTime - processingStartTime,
      inputTokens,
      outputTokens,
      costUsd,
      success: true
    });

    await sendReportEmail({ serverName, serverId, channelName: channel.name, messageCount: allMessages.length, score: analysis.friendlinessScore.toFixed(1), sentiment: analysis.sentiment, flaggedMessages: analysis.flaggedMessages, toxicityTypes: analysis.toxicityTypes, recommendation: analysis.recommendation, remaining, isPro: approved, sensitivity, timeframe: actualTimeframe, visibility });

    const score = clamp(analysis.friendlinessScore, 0, 10);
    const gradeInfo = getGrade(score);
    const total = (analysis.sentiment.friendly || 0) + (analysis.sentiment.neutral || 0) + (analysis.sentiment.unfriendly || 0);
    const friendlyPct = safePercentage(analysis.sentiment.friendly, total);
    const neutralPct = safePercentage(analysis.sentiment.neutral, total);
    const unfriendlyPct = safePercentage(analysis.sentiment.unfriendly, total);
    const timeframeLabel = { '1h': '1 hour', '12h': '12 hours', '24h': '24 hours', '3d': '3 days', '7d': '7 days', '30d': '30 days' }[actualTimeframe] || actualTimeframe;

    const embeds = [];
    const scoreBand = getScoreBand(score);

    // EMBED 1: HEALTH SUMMARY
    const healthEmbed = new EmbedBuilder()
      .setColor(scoreBand.color)
      .setTitle('Community Health Summary')
      .setDescription(`\n**${score.toFixed(1)}** / 10\n\u200b\n*${scoreBand.label}*\n\u200b`)
      .addFields({ name: '\u200b', value: scoreBand.description, inline: false })
      .setFooter({ text: `Analysis reflects the selected ${timeframeLabel} timeframe only` });
    embeds.push(healthEmbed);

    // EMBED 2: TONE
    const toneChartUrl = generateToneChart(analysis.sentiment.friendly || 0, analysis.sentiment.neutral || 0, analysis.sentiment.unfriendly || 0);
    const toneEmbed = new EmbedBuilder()
      .setColor(REPORT_COLORS.neutral)
      .setTitle('Conversation Tone')
      .addFields(
        { name: 'Positive', value: `${friendlyPct}%`, inline: true },
        { name: 'Neutral', value: `${neutralPct}%`, inline: true },
        { name: 'Negative', value: `${unfriendlyPct}%`, inline: true }
      )
      .setFooter({ text: 'Mixed tone is normal in active communities' });
    if (toneChartUrl) toneEmbed.setImage(toneChartUrl);
    embeds.push(toneEmbed);

    // EMBED 3: BEHAVIOR PATTERNS
    if (analysis.toxicityTypes && Object.keys(analysis.toxicityTypes).length > 0) {
      const sortedTypes = Object.entries(analysis.toxicityTypes).sort((a, b) => b[1] - a[1]);
      const totalPatterns = sortedTypes.reduce((sum, [, count]) => sum + count, 0);
      const behaviorChartUrl = generateBehaviorChart(analysis.toxicityTypes);
      let patternList = '';
      for (const [type, count] of sortedTypes.slice(0, 5)) patternList += `**${type}**  ·  ${count}\n`;
      const behaviorEmbed = new EmbedBuilder()
        .setColor(REPORT_COLORS.neutral)
        .setTitle('Behavior Patterns Observed')
        .setDescription(`${totalPatterns} pattern${totalPatterns !== 1 ? 's' : ''} identified`)
        .addFields({ name: 'By Frequency', value: patternList.trim() || 'None observed', inline: false })
        .setFooter({ text: 'Counts reflect frequency, not severity' });
      if (behaviorChartUrl) behaviorEmbed.setImage(behaviorChartUrl);
      embeds.push(behaviorEmbed);
    }

    // EMBED 4: FLAGGED MESSAGES
    if (analysis.flaggedMessages?.length > 0) {
      const sortedFlagged = [...analysis.flaggedMessages].sort((a, b) => (b.severity || 0) - (a.severity || 0)).slice(0, 5);
      const canViewDetails = interaction.member.permissions.has(PermissionFlagsBits.ManageMessages) || interaction.user.id === CONFIG.OWNER_ID;
      const flaggedEmbed = new EmbedBuilder().setColor(REPORT_COLORS.neutral).setTitle('Flagged Message Highlights').setDescription(`${analysis.flaggedMessages.length} message${analysis.flaggedMessages.length !== 1 ? 's' : ''} flagged for review`);
      
      if (isPrivate && canViewDetails) {
        let messageList = '';
        for (const m of sortedFlagged) {
          const sev = (m.severity || 0);
          const sevMarker = sev >= 7 ? '●' : sev >= 5 ? '◐' : '○';
          const type = m.type || 'Unclassified';
          const text = (m.text || '').slice(0, 50);
          const ellipsis = (m.text || '').length > 50 ? '…' : '';
          const line = `${sevMarker}  **${type}**\n\`${text}${ellipsis}\`\n\n`;
          if ((messageList + line).length > 900) break;
          messageList += line;
        }
        flaggedEmbed.addFields({ name: 'Top by Severity', value: messageList.trim() || 'None', inline: false });
        flaggedEmbed.setFooter({ text: analysis.flaggedMessages.length > 5 ? `Showing 5 of ${analysis.flaggedMessages.length} · ● High  ◐ Medium  ○ Low` : '● High  ◐ Medium  ○ Low severity' });
      } else if (!canViewDetails) {
        flaggedEmbed.addFields({ name: 'Access Restricted', value: 'Flagged content details are visible to moderators with **Manage Messages** permission only.', inline: false });
        flaggedEmbed.setFooter({ text: 'Contact a server moderator for details' });
      } else {
        const typeCounts = {};
        for (const m of analysis.flaggedMessages) { const type = m.type || 'Other'; typeCounts[type] = (typeCounts[type] || 0) + 1; }
        const severityCounts = { high: 0, medium: 0, low: 0 };
        for (const m of analysis.flaggedMessages) { const sev = m.severity || 0; if (sev >= 7) severityCounts.high++; else if (sev >= 5) severityCounts.medium++; else severityCounts.low++; }
        const typeList = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).map(([type, count]) => `**${type}**  ·  ${count}`).join('\n');
        flaggedEmbed.addFields({ name: 'By Type', value: typeList || 'None', inline: true }, { name: 'By Severity', value: `● High: ${severityCounts.high}\n◐ Medium: ${severityCounts.medium}\n○ Low: ${severityCounts.low}`, inline: true });
        flaggedEmbed.setFooter({ text: 'Message text hidden in public mode · Use /vibe visibility:private for details' });
      }
      embeds.push(flaggedEmbed);
    }

    // EMBED 5: CONTEXT
    const sensitivityLabels = { low: 'Relaxed (gaming/adult communities)', medium: 'Standard (general communities)', high: 'Strict (family/kids communities)' };
    const contextEmbed = new EmbedBuilder()
      .setColor(REPORT_COLORS.accent)
      .setTitle('Analysis Context')
      .addFields(
        { name: 'Sample Size', value: `${allMessages.length.toLocaleString()} messages`, inline: true },
        { name: 'Timeframe', value: timeframeLabel, inline: true },
        { name: 'Channel', value: `#${channel.name}`, inline: true },
        { name: 'Sensitivity', value: sensitivityLabels[sensitivity] || 'Standard', inline: false },
        { name: 'Data Handling', value: 'Message text is processed by AI to compute aggregates. Only summary metrics are stored.', inline: false }
      )
      .setFooter({ text: 'Results depend on selected scope and sensitivity settings' });
    embeds.push(contextEmbed);

    // EMBED 6: NEXT STEPS
    const progressUsed = await getProgressUsage(serverId);
    const progressLimit = approved ? CONFIG.PRO_PROGRESS_REPORTS : CONFIG.FREE_PROGRESS_REPORTS;
    const progressRemaining = Math.max(0, progressLimit - progressUsed);
    const actions = [];
    if (score >= 8) { actions.push('Continue current moderation practices'); actions.push('Consider recognizing positive contributors'); }
    else if (score >= 6) { actions.push('Review flagged messages when convenient'); actions.push('Monitor patterns over the coming week'); }
    else if (score >= 4) { actions.push('Review community guidelines with members'); actions.push('Address top behavior pattern first'); actions.push('Schedule a follow-up check in 3-5 days'); }
    else { actions.push('Prioritize review of high-severity flags'); actions.push('Consider temporary channel-specific rules'); actions.push('Schedule daily monitoring this week'); }
    if (actions.length < 4) actions.push('Use /vibe-progress to track trends');
    const actionList = actions.slice(0, 4).map(a => `→  ${a}`).join('\n');
    const nextStepsEmbed = new EmbedBuilder()
      .setColor(REPORT_COLORS.good)
      .setTitle('Recommended Next Steps')
      .setDescription(analysis.recommendation ? `*${analysis.recommendation}*` : null)
      .addFields({ name: 'Suggested Actions', value: actionList, inline: false });
    const isOwner = interaction.user.id === CONFIG.OWNER_ID;
    const planLabel = isOwner ? 'Owner' : (approved ? 'Pro' : 'Free');
    const reportsRemText = isOwner ? '∞' : remaining;
    const progressRemText = isOwner ? '∞' : progressRemaining;
    nextStepsEmbed.setFooter({ text: `${planLabel} · ${reportsRemText} reports remaining · ${progressRemText} progress remaining\nAI analysis is not a substitute for human moderation` });
    embeds.push(nextStepsEmbed);

    // BUTTONS
    let buttons;
    if (interaction.user.id === CONFIG.OWNER_ID || approved) {
      buttons = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`progress_${serverId}`.slice(0, 100)).setLabel('📈 View Progress').setStyle(ButtonStyle.Primary));
    } else {
      buttons = createSubscriptionButtons({ monthlyLabel: '⚡ Monthly · $9.99', yearlyLabel: '💎 Yearly · $99 (Save 17%)' });
    }

    await interaction.editReply({ embeds: embeds.slice(0, 10), components: [buttons] });

    // MILESTONE NOTIFICATIONS
    const totalReports = await getTotalReports(serverId);
    const milestones = [5, 10, 20, 30];
    if (milestones.includes(totalReports) && !approved && interaction.user.id !== CONFIG.OWNER_ID) {
      const checkEmbed = new EmbedBuilder().setColor(0x22c55e).setTitle(`🎉 Milestone: ${totalReports} reports!`).setDescription(`You've run **${totalReports}** reports!\n\nSubscribe to track your progress over time.`);
      const progressBtn = createSubscriptionButtons({ monthlyLabel: '⚡ Monthly · $9.99', yearlyLabel: '💎 Yearly · $99' });
      await interaction.followUp({ embeds: [checkEmbed], components: [progressBtn], ephemeral: true });
    }

    if (!approved && remaining <= 2 && remaining > 0 && interaction.user.id !== CONFIG.OWNER_ID) {
      const warningEmbed = new EmbedBuilder().setColor(0xf59e0b).setDescription(`⚠️ Only **${remaining}** free report${remaining === 1 ? '' : 's'} left!\n\nSubscribe to continue using VibeCheck.`);
      const upgradeBtn = createSubscriptionButtons({ monthlyLabel: '⚡ Monthly · $9.99', yearlyLabel: '💎 Yearly · $99' });
      await interaction.followUp({ embeds: [warningEmbed], components: [upgradeBtn], ephemeral: true });
    }
    
    if (approved && interaction.user.id !== CONFIG.OWNER_ID) {
      const subStatus = await getSubscriptionStatus(serverId);
      if (subStatus.daysLeft <= 7 && subStatus.daysLeft > 0) {
        const expiryEmbed = new EmbedBuilder().setColor(0xf59e0b).setTitle('⏰ Subscription Expiring Soon').setDescription(`Your Pro subscription expires in **${subStatus.daysLeft} day${subStatus.daysLeft === 1 ? '' : 's'}**!`);
        const renewBtn = createSubscriptionButtons({ monthlyLabel: '🔄 Monthly · $9.99', yearlyLabel: '💎 Yearly · $99' });
        await interaction.followUp({ embeds: [expiryEmbed], components: [renewBtn], ephemeral: true });
      }
    }

  } catch (error) {
    console.error('Analysis error:', error);
    
    // Log failed research attempt
    const processingEndTime = Date.now();
    await logResearchData({
      serverId,
      userId: interaction.user.id,
      channelId: channel.id,
      messagesAnalyzed: 0,
      timeframe: actualTimeframe,
      sensitivity,
      visibility,
      isPro: approved,
      score: null,
      friendly: 0,
      neutral: 0,
      unfriendly: 0,
      flaggedCount: 0,
      toxicityTypes: {},
      processingTimeMs: processingEndTime - processingStartTime,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      success: false,
      errorMessage: error.message?.slice(0, 500)
    });
    
    await interaction.editReply('❌ Something went wrong. Try again.');
  }
}

// ============================================
// INTERACTION HANDLER
// ============================================

client.on('interactionCreate', async (interaction) => {
  
  // MODAL SUBMISSIONS
  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'custom_reports_modal') {
      const countStr = interaction.fields.getTextInputValue('report_count');
      const count = parseInt(countStr);
      if (isNaN(count) || count < 1 || count > 100) {
        return interaction.reply({ content: '❌ Please enter a number between 1 and 100.\n\n**Run `/vibe-progress` again to retry.**', ephemeral: true });
      }
      const pending = consumePendingCommand(pendingProgressCommands, interaction.user.id);
      if (!pending) return interaction.reply({ content: '❌ Session expired. Please run `/vibe-progress` again.', ephemeral: true });
      
      const canUseProgress = await canUseProgressReport(pending.serverId, interaction.user.id);
      if (!canUseProgress) {
        const approved = await isApproved(pending.serverId);
        if (approved) {
          const usage = await getUsage(pending.serverId);
          const monthStart = new Date(usage.month_start);
          const daysUntilReset = Math.ceil(30 - ((new Date() - monthStart) / (1000 * 60 * 60 * 24)));
          const embed = new EmbedBuilder().setColor(0xf59e0b).setTitle('⚠️ Progress Limit Reached').setDescription(`You've used all **${CONFIG.PRO_PROGRESS_REPORTS} progress reports** this month!\n\nYour progress reports reset in **${daysUntilReset} days**.`);
          return interaction.reply({ embeds: [embed], ephemeral: true });
        } else {
          const embed = new EmbedBuilder().setColor(0x8b5cf6).setTitle('📈 Progress Reports').setDescription(`You've used your **${CONFIG.FREE_PROGRESS_REPORTS}** free demo!\n\n**Subscribe to unlock:**\n\n✓ 30 reports per month\n✓ ${CONFIG.PRO_PROGRESS_REPORTS} progress reports per month`);
          const buttons = createSubscriptionButtons({ monthlyLabel: '⚡ Monthly · $9.99', yearlyLabel: '💎 Yearly · $99' });
          return interaction.reply({ embeds: [embed], components: [buttons], ephemeral: true });
        }
      }
      
      await interaction.deferReply({ ephemeral: true });
      const reports = await getReportHistory(pending.serverId, pending.channelName, count, null);
      if (!reports || reports.length === 0) return interaction.editReply('❌ No reports found. Run `/vibe` first!');
      const embeds = await buildProgressEmbeds(pending.serverId, pending.serverName, pending.channelName, reports);
      if (!embeds || embeds.length === 0) return interaction.editReply('❌ No reports found.');
      const hasPaid = await hasProgressAccess(pending.serverId);
      if (interaction.user.id !== CONFIG.OWNER_ID && !hasPaid) await useProgressReport(pending.serverId);
      await sendProgressReportEmail(pending.serverName, pending.serverId, pending.channelName, reports, interaction.user.username);
      return interaction.editReply({ embeds: embeds.slice(0, 10) });
    }
  }
  
  // BUTTON HANDLERS
  if (interaction.isButton()) {
    const customId = interaction.customId;
    try {
      if (customId.startsWith('approve_')) {
        const serverId = customId.replace('approve_', '');
        const request = await getApprovalRequest(serverId);
        if (request) {
          await approveServer(serverId, request.server_name);
          await interaction.update({ embeds: [new EmbedBuilder().setColor(0x22c55e).setTitle('✅ Approved').setDescription(`**${request.server_name}** - 30 reports/month`)], components: [] });
        }
        return;
      }
      if (customId.startsWith('deny_')) {
        const serverId = customId.replace('deny_', '');
        await updateApprovalStatus(serverId, 'denied');
        await interaction.update({ embeds: [new EmbedBuilder().setColor(0xef4444).setTitle('❌ Denied').setDescription('User will see Stripe link.')], components: [] });
        return;
      }
      if (customId.startsWith('progress_')) {
        const serverId = customId.replace('progress_', '');
        const serverName = interaction.guild?.name || 'Unknown';
        const canUseProgress = await canUseProgressReport(serverId, interaction.user.id);
        if (!canUseProgress) {
          const approved = await isApproved(serverId);
          if (approved) {
            const usage = await getUsage(serverId);
            const monthStart = new Date(usage.month_start);
            const daysUntilReset = Math.ceil(30 - ((new Date() - monthStart) / (1000 * 60 * 60 * 24)));
            const embed = new EmbedBuilder().setColor(0xf59e0b).setTitle('⚠️ Progress Limit Reached').setDescription(`You've used all **${CONFIG.PRO_PROGRESS_REPORTS} progress reports** this month!\n\nYour progress reports reset in **${daysUntilReset} days**.`);
            return interaction.reply({ embeds: [embed], ephemeral: true });
          } else {
            const embed = new EmbedBuilder().setColor(0x8b5cf6).setTitle('📈 Progress Reports').setDescription(`You've used your **${CONFIG.FREE_PROGRESS_REPORTS}** free demo!\n\n**Subscribe to unlock:**\n\n✓ 30 reports per month\n✓ ${CONFIG.PRO_PROGRESS_REPORTS} progress reports per month`);
            const buttons = createSubscriptionButtons({ monthlyLabel: '⚡ Monthly · $9.99', yearlyLabel: '💎 Yearly · $99' });
            return interaction.reply({ embeds: [embed], components: [buttons], ephemeral: true });
          }
        }
        await interaction.deferReply({ ephemeral: true });
        const reports = await getReportHistory(serverId, null, 10, null);
        const embeds = await buildProgressEmbeds(serverId, serverName, null, reports);
        if (!embeds || embeds.length === 0) return interaction.editReply('❌ No reports found.');
        const hasPaid = await hasProgressAccess(serverId);
        if (interaction.user.id !== CONFIG.OWNER_ID && !hasPaid) await useProgressReport(serverId);
        await sendProgressReportEmail(serverName, serverId, null, reports, interaction.user.username);
        return interaction.editReply({ embeds: embeds.slice(0, 10) });
      }
    } catch (buttonError) {
      console.error('Button handler error:', buttonError);
      try { if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true }); } catch (e) {}
    }
  }

  if (!interaction.isChatInputCommand()) return;

  // VIBE-ADMIN COMMAND
  if (interaction.commandName === 'vibe-admin') {
    if (interaction.user.id !== CONFIG.OWNER_ID) return interaction.reply({ content: '❌ Owner only command.', ephemeral: true });
    const action = interaction.options.getString('action');
    const serverId = interaction.options.getString('server_id');
    const days = interaction.options.getInteger('days') || 30;
    if (!/^\d{17,19}$/.test(serverId)) return interaction.reply({ content: '❌ Invalid server ID format.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    console.log(`🔧 ADMIN: ${action} on server ${serverId}`);
    try {
      if (action === 'status') {
        const approved = await getApprovedServer(serverId);
        const usage = await getUsage(serverId);
        const request = await getApprovalRequest(serverId);
        const totalReports = await getTotalReports(serverId);
        const progressAccess = await hasProgressAccess(serverId);
        const progressUsed = await getProgressUsage(serverId);
        const subStatus = await getSubscriptionStatus(serverId);
        const embed = new EmbedBuilder().setColor(subStatus.expired ? 0xef4444 : (subStatus.active ? 0x22c55e : 0x3b82f6)).setTitle(`📊 Server Status: ${serverId}`)
          .addFields(
            { name: 'Plan', value: approved ? (subStatus.expired ? '⚠️ Pro (EXPIRED)' : '⚡ Pro') : '🎁 Free', inline: true },
            { name: 'Reports Used', value: `${usage.reports_used}/${approved ? CONFIG.PRO_REPORTS_PER_MONTH : CONFIG.FREE_REPORTS}`, inline: true },
            { name: 'Total Reports', value: `${totalReports}`, inline: true },
            { name: 'Progress Used', value: `${progressUsed}/${approved ? CONFIG.PRO_PROGRESS_REPORTS : CONFIG.FREE_PROGRESS_REPORTS}`, inline: true },
            { name: 'Request Status', value: request?.status || 'None', inline: true },
            { name: 'Progress Access', value: progressAccess ? '✅ Unlimited' : '📊 Limited', inline: true }
          );
        if (approved) embed.addFields(
          { name: 'Expires', value: subStatus.expiresAt ? subStatus.expiresAt.toLocaleDateString() : 'Never', inline: true },
          { name: 'Days Left', value: subStatus.daysLeft === 999 ? '∞' : `${subStatus.daysLeft}`, inline: true },
          { name: 'Status', value: subStatus.expired ? '🔴 EXPIRED' : (subStatus.daysLeft <= 7 ? '🟡 EXPIRING SOON' : '🟢 ACTIVE'), inline: true }
        );
        return interaction.editReply({ embeds: [embed] });
      }
      if (action === 'approve') { const request = await getApprovalRequest(serverId); const expiresAt = await approveServer(serverId, request?.server_name || 'Unknown', days); return interaction.editReply(`✅ Server ${serverId} approved!\n\n📅 Expires: ${expiresAt.toLocaleDateString()} (${days} days)`); }
      if (action === 'renew') { const expiresAt = await renewSubscription(serverId, days); if (!expiresAt) return interaction.editReply(`❌ Server ${serverId} not found.`); return interaction.editReply(`🔄 Server ${serverId} renewed!\n\n📅 New expiration: ${expiresAt.toLocaleDateString()}`); }
      if (action === 'deny') { await updateApprovalStatus(serverId, 'denied'); return interaction.editReply(`❌ Server ${serverId} denied.`); }
      if (action === 'reset') { await supabase.from('approval_requests').delete().eq('server_id', serverId); await supabase.from('approved_servers').delete().eq('server_id', serverId); return interaction.editReply(`🔄 Server ${serverId} reset.`); }
      if (action === 'freetrial') { await supabase.from('usage').update({ reports_used: 0, progress_used: 0 }).eq('server_id', serverId); await supabase.from('approval_requests').delete().eq('server_id', serverId); await supabase.from('approved_servers').delete().eq('server_id', serverId); await supabase.from('progress_access').delete().eq('server_id', serverId); return interaction.editReply(`🎁 Server ${serverId} free trial reset!`); }
      if (action === 'grant_progress') { await supabase.from('progress_access').upsert({ server_id: serverId, granted_at: new Date().toISOString() }); return interaction.editReply(`📈 Server ${serverId} granted unlimited progress reports!`); }
      if (action === 'revoke_progress') { await supabase.from('progress_access').delete().eq('server_id', serverId); return interaction.editReply(`🚫 Server ${serverId} progress access revoked.`); }
      if (action === 'delete_data') { console.log(`🗑️ GDPR DELETE requested for server ${serverId}`); await supabase.from('reports').delete().eq('server_id', serverId); await supabase.from('usage').delete().eq('server_id', serverId); await supabase.from('approved_servers').delete().eq('server_id', serverId); await supabase.from('approval_requests').delete().eq('server_id', serverId); await supabase.from('progress_access').delete().eq('server_id', serverId); return interaction.editReply(`🗑️ **GDPR DELETE COMPLETE** for server ${serverId}`); }
    } catch (error) { console.error('Admin command error:', error); return interaction.editReply(`❌ Error: ${error.message}`); }
  }

  // VIBE-PROGRESS COMMAND
  if (interaction.commandName === 'vibe-progress') {
    const serverId = interaction.guildId;
    const serverName = interaction.guild.name;
    const channel = interaction.options.getChannel('channel');
    const channelName = channel?.name || null;
    const range = interaction.options.getString('range') || '14d';
    
    const canUseProgress = await canUseProgressReport(serverId, interaction.user.id);
    if (!canUseProgress) {
      const approved = await isApproved(serverId);
      if (approved) {
        const usage = await getUsage(serverId);
        const monthStart = new Date(usage.month_start);
        const daysUntilReset = Math.ceil(30 - ((new Date() - monthStart) / (1000 * 60 * 60 * 24)));
        const embed = new EmbedBuilder().setColor(0xf59e0b).setTitle('⚠️ Progress Limit Reached').setDescription(`You've used all **${CONFIG.PRO_PROGRESS_REPORTS} progress reports** this month!\n\nYour progress reports reset in **${daysUntilReset} days**.`);
        return interaction.reply({ embeds: [embed], ephemeral: true });
      } else {
        const embed = new EmbedBuilder().setColor(0x8b5cf6).setTitle('📈 Progress Reports').setDescription(`You've used your **${CONFIG.FREE_PROGRESS_REPORTS}** free demo!\n\n**Subscribe to unlock:**\n\n✓ 30 reports per month\n✓ ${CONFIG.PRO_PROGRESS_REPORTS} progress reports per month`);
        const buttons = createSubscriptionButtons({ monthlyLabel: '⚡ Monthly · $9.99', yearlyLabel: '💎 Yearly · $99' });
        return interaction.reply({ embeds: [embed], components: [buttons], ephemeral: true });
      }
    }
    
    if (range === 'custom') {
      setPendingCommand(pendingProgressCommands, interaction.user.id, { serverId, serverName, channelName });
      const modal = new ModalBuilder().setCustomId('custom_reports_modal').setTitle('Custom # of Reports');
      const reportCountInput = new TextInputBuilder().setCustomId('report_count').setLabel('Number of reports (1-100)').setStyle(TextInputStyle.Short).setPlaceholder('15').setRequired(true).setMinLength(1).setMaxLength(3);
      modal.addComponents(new ActionRowBuilder().addComponents(reportCountInput));
      return interaction.showModal(modal);
    }
    
    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply('📊 Loading your progress report...');
    const daysMap = { '1d': 1, '14d': 14, '30d': 30 };
    const days = daysMap[range] || 14;
    const reports = await getReportHistory(serverId, channelName, 100, days);
    if (!reports || reports.length === 0) return interaction.editReply('❌ No reports found. Run `/vibe` first!');
    const embeds = await buildProgressEmbeds(serverId, serverName, channelName, reports);
    if (!embeds || embeds.length === 0) return interaction.editReply('❌ No reports found.');
    const approved = await isApproved(serverId);
    const hasPaid = await hasProgressAccess(serverId);
    if (interaction.user.id !== CONFIG.OWNER_ID && !hasPaid) {
      const newCount = await useProgressReport(serverId);
      const limit = approved ? CONFIG.PRO_PROGRESS_REPORTS : CONFIG.FREE_PROGRESS_REPORTS;
      const remaining = limit - newCount;
      if (remaining <= 0) {
        const warningEmbed = new EmbedBuilder().setColor(0xf59e0b).setDescription(approved ? `⚠️ You've used all **${CONFIG.PRO_PROGRESS_REPORTS}** progress reports this month!` : `⚠️ This was your free progress demo!`);
        if (!approved) { const upgradeBtn = createSubscriptionButtons({ monthlyLabel: '⚡ Monthly · $9.99', yearlyLabel: '💎 Yearly · $99' }); await interaction.followUp({ embeds: [warningEmbed], components: [upgradeBtn], ephemeral: true }); }
        else await interaction.followUp({ embeds: [warningEmbed], ephemeral: true });
      }
    }
    await sendProgressReportEmail(serverName, serverId, channelName, reports, interaction.user.username);
    return interaction.editReply({ embeds: embeds.slice(0, 10) });
  }

  // VIBE COMMAND
  if (interaction.commandName !== 'vibe') return;

  const serverId = interaction.guildId;
  const userId = interaction.user.id;
  
  if (userId !== CONFIG.OWNER_ID) {
    if (isOnCooldown(serverId, userId)) return interaction.reply({ content: `⏳ Please wait ${getCooldownRemaining(serverId, userId)} seconds.`, ephemeral: true });
    if (isServerThrottled(serverId)) return interaction.reply({ content: `⏳ This server has reached the rate limit.`, ephemeral: true });
  }
  
  const subStatus = await getSubscriptionStatus(serverId);
  const approvedServer = await getApprovedServer(serverId);
  
  if (approvedServer && subStatus.expired) {
    const embed = new EmbedBuilder().setColor(0xef4444).setTitle('⚠️ Subscription Expired').setDescription(`Your Pro subscription has expired!\n\n**Renew to continue:**\n\n✓ 30 reports per month\n✓ ${CONFIG.PRO_PROGRESS_REPORTS} progress reports per month`);
    const buttons = createSubscriptionButtons({ monthlyLabel: '🔄 Monthly · $9.99/mo', yearlyLabel: '💎 Yearly · $99/yr (Save 17%)' });
    return interaction.reply({ embeds: [embed], components: [buttons], ephemeral: true });
  }
  
  const approved = await isApproved(serverId);
  const canUse = await canUseBot(serverId, interaction.user.id);
  
  if (!canUse) {
    if (approved) {
      const usage = await getUsage(serverId);
      const monthStart = new Date(usage.month_start);
      const daysUntilReset = Math.ceil(30 - ((new Date() - monthStart) / (1000 * 60 * 60 * 24)));
      const embed = new EmbedBuilder().setColor(0xf59e0b).setTitle('⚠️ Monthly Limit Reached').setDescription(`You've used all **30 reports** this month!\n\nYour reports reset in **${daysUntilReset} days**.`);
      return interaction.reply({ embeds: [embed], ephemeral: true });
    } else {
      const embed = new EmbedBuilder().setColor(0x8b5cf6).setTitle('🏆 VibeCheck Pro').setDescription(`Your free trial is complete!\n\n**Subscribe to continue:**\n\n✓ 30 reports per month\n✓ ${CONFIG.PRO_PROGRESS_REPORTS} progress reports per month`);
      const buttons = createSubscriptionButtons({ monthlyLabel: '⚡ Monthly · $9.99/mo', yearlyLabel: '💎 Yearly · $99/yr (Save 17%)' });
      return interaction.reply({ embeds: [embed], components: [buttons], ephemeral: true });
    }
  }

  const channel = interaction.options.getChannel('channel') || interaction.channel;
  const visibility = interaction.options.getString('visibility') || 'private';
  const sensitivity = interaction.options.getString('sensitivity') || 'medium';
  const timeframe = interaction.options.getString('timeframe') || '24h';
  const messagesOption = interaction.options.getString('messages') || '100';
  const messageCount = parseInt(messagesOption);

  const isPrivate = visibility === 'private';
  await interaction.deferReply({ ephemeral: isPrivate });

  await runVibeAnalysis(interaction, { channel, visibility, sensitivity, timeframe, messageCount, startDate: null, endDate: null });
});

// Error handling
process.on('unhandledRejection', (error, promise) => { console.error('❌ Unhandled Rejection:', error); });
process.on('uncaughtException', error => { console.error('❌ Uncaught Exception:', error); });
process.on('SIGTERM', () => { console.log('🛑 SIGTERM received'); client.destroy(); process.exit(0); });
process.on('SIGINT', () => { console.log('🛑 SIGINT received'); client.destroy(); process.exit(0); });

// Keep Railway alive
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('VibeCheck Bot Running');
}).listen(process.env.PORT || 3000, () => {
  console.log(`🌐 Health check server on port ${process.env.PORT || 3000}`);
});

client.login(process.env.DISCORD_TOKEN);
