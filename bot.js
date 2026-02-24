// ============================================================
// VIBE CHECK BOT v2.4 (Railway Optimized)
// ============================================================

const http = require('http');

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

const SENSITIVITY_PROMPTS = {
  low: `SENSITIVITY: LOW (Adult/Gaming communities)\n- Casual trash talk normal\n- Profanity neutral`,
  medium: `SENSITIVITY: MEDIUM (General)\n- Flag personal attacks and hate speech`,
  high: `SENSITIVITY: HIGH (Family/Kids)\n- Flag all profanity and rudeness`
};

// ============================================================
// CLIENTS & VALIDATION
// ============================================================

function validateEnvironment() {
  const required = ['DISCORD_TOKEN', 'CLIENT_ID', 'OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_KEY'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) { console.error('FATAL: Missing env vars:', missing.join(', ')); process.exit(1); }
  console.log('Environment validated');
}
validateEnvironment();

const openai   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const resend   = new Resend(process.env.RESEND_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// ============================================================
// DATABASE & USAGE HELPERS
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

// [Omitted: Sanitization, Fetching, Charting, and Analysis functions for brevity, 
// but you should keep them exactly as they were in your v2.3 script]

// ============================================================
// REGISTER COMMANDS
// ============================================================

async function registerCommands() {
  const vibe = new SlashCommandBuilder().setName('vibe').setDescription('Analyze community friendliness')
    .addChannelOption(o=>o.setName('channel').setDescription('Channel to analyze').addChannelTypes(ChannelType.GuildText))
    .addStringOption(o=>o.setName('timeframe').setDescription('Range').addChoices({name:'7d',value:'7d'},{name:'24h',value:'24h'}))
    .addStringOption(o=>o.setName('visibility').setDescription('Public/Private').addChoices({name:'Private',value:'private'},{name:'Public',value:'public'}));

  const progress = new SlashCommandBuilder().setName('vibe-progress').setDescription('Track your community vibe over time')
    .addStringOption(o => o.setName('range').setDescription('Number of reports').addChoices({name:'Last 10',value:'10'},{name:'Last 30',value:'30'}));

  const admin = new SlashCommandBuilder().setName('vibe-admin').setDescription('Admin controls (owner only)')
    .addStringOption(o=>o.setName('action').setDescription('Action').setRequired(true))
    .addStringOption(o=>o.setName('server_id').setDescription('Server ID').setRequired(true));

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [vibe.toJSON(), progress.toJSON(), admin.toJSON()] });
    console.log('✅ Commands registered');
  } catch (e) { console.error('Failed to register commands:', e); }
}

// ============================================================
// MAIN INTERACTION HANDLER (Merged & Corrected)
// ============================================================

client.on('interactionCreate', async interaction => {
  // Handle Buttons
  if (interaction.isButton() && interaction.customId === 'view_progress') { 
    return handleProgressCommand(interaction, '10', []); 
  }

  if (!interaction.isChatInputCommand()) return;

  // Handle Commands
  if (interaction.commandName === 'vibe') {
    return handleVibeCommand(interaction);
  }
  
  if (interaction.commandName === 'vibe-progress') {
    const range = interaction.options.getString('range') || '10';
    const channels = [interaction.options.getChannel('channel')].filter(Boolean);
    return handleProgressCommand(interaction, range, channels);
  }

  if (interaction.commandName === 'vibe-admin') {
    return handleAdminCommand(interaction);
  }
});

// ============================================================
// BOT STARTUP
// ============================================================

// Using clientReady fixes the DeprecationWarning
client.once('clientReady', (c) => {
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🚀 Vibe Check Bot 2.4 is online: ${c.user.tag}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  registerCommands();
});

client.login(process.env.DISCORD_TOKEN);

// Note: Ensure your handleVibeCommand, handleProgressCommand, and chart functions 
// are pasted above this line to complete the script.
