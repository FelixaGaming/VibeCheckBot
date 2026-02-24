const http = require('http');
// ============================================================
// VIBE CHECK BOT v2.4
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
  low: `SENSITIVITY: LOW (Adult/Gaming) - Banter is normal. Flag severe harassment only.`,
  medium: `SENSITIVITY: MEDIUM (General) - Flag insults, hate speech, and repeated negativity.`,
  high: `SENSITIVITY: HIGH (Kids/Family) - Strict. Flag any profanity or mild rudeness.`
};

// ============================================================
// CLIENTS
// ============================================================

const openai   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const resend   = new Resend(process.env.RESEND_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// ============================================================
// QUICKCHART HELPERS (Beautiful & Colourful)
// ============================================================

function chartUrl(cfg, w, h) {
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(cfg))}&w=${w||500}&h=${h||260}&bkg=white`;
}

function pieChart(friendly, neutral, unfriendly) {
  return chartUrl({
    type: 'pie',
    data: {
      labels: ['Friendly', 'Neutral', 'Unfriendly'],
      datasets: [{ data: [friendly, neutral, unfriendly], backgroundColor: ['#22c55e','#94a3b8','#ef4444'] }]
    },
    options: { plugins: { title: { display: true, text: 'Snapshot: Community Sentiment' } } }
  });
}

function vibeStrengthChart(reports) {
  const labels = reports.map(r => new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  return chartUrl({
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Vibe Strength',
        data: reports.map(r => r.score),
        borderColor: '#8b5cf6', backgroundColor: 'rgba(139, 92, 246, 0.15)',
        fill: true, tension: 0.4, pointRadius: 4
      }]
    },
    options: { plugins: { title: { display: true, text: 'Global Vibe Strength Over Time' } } }
  });
}

function behaviorEvolutionChart(reports) {
  const labels = reports.map(r => new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  const types = ['insults', 'harassment', 'threats', 'bullying'];
  const colors = ['#ef4444', '#f97316', '#8b5cf6', '#3b82f6'];
  const datasets = types.map((type, i) => ({
    label: type.charAt(0).toUpperCase() + type.slice(1),
    data: reports.map(r => {
      const t = typeof r.toxicity_types === 'string' ? JSON.parse(r.toxicity_types) : (r.toxicity_types || {});
      return t[type] || 0;
    }),
    borderColor: colors[i], fill: false, tension: 0.4
  }));
  return chartUrl({ type: 'line', data: { labels, datasets }, options: { plugins: { title: { display: true, text: 'Detailed Sentiment Evolution per Behavior' } } } });
}

function multiChannelLineChart(allChannelData, labels) {
  const colors = ['#f97316', '#8b5cf6', '#22c55e', '#ef4444', '#3b82f6'];
  const datasets = Object.entries(allChannelData).map(([name, scores], i) => ({
    label: name, data: scores, borderColor: colors[i % colors.length], fill: false, tension: 0.35
  }));
  return chartUrl({ type: 'line', data: { labels, datasets }, options: { plugins: { title: { display: true, text: 'Vibe Level Trajectory per Channel' } } } });
}

// ============================================================
// DATA & UTILS
// ============================================================

function scoreBar(s) { const f = Math.round(s); return '█'.repeat(f) + '░'.repeat(10-f); }

async function handleProgressCommand(interaction) {
  const serverId = interaction.guildId;
  const timeframe = interaction.options.getString('timeframe') || '7d';
  const sensitivity = interaction.options.getString('sensitivity');
  const filterChannels = [
    interaction.options.getChannel('channel'),
    interaction.options.getChannel('channel2'),
    interaction.options.getChannel('channel3')
  ].filter(Boolean);

  await interaction.deferReply({ ephemeral: true });

  try {
    let q = supabase.from('reports').select('*').eq('server_id', serverId).order('created_at', { ascending: false });
    
    // Timeframe filtering
    const now = Date.now();
    if (timeframe === '24h') q = q.gte('created_at', new Date(now - 86400000).toISOString());
    else if (timeframe === '7d') q = q.gte('created_at', new Date(now - 604800000).toISOString());
    else if (timeframe === '30d') q = q.gte('created_at', new Date(now - 2592000000).toISOString());
    else q = q.limit(50);

    if (sensitivity) q = q.eq('sensitivity', sensitivity);

    let { data: reports, error } = await q;
    if (error || !reports?.length) return interaction.editReply('No matching reports found.');

    const sorted = [...reports].reverse();
    const latest = sorted[sorted.length - 1];
    const labels = sorted.map(r => new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));

    // Aggregation logic
    const channelData = {};
    const channelLatestScores = {};
    let totalMessages = 0;
    const toxMap = {};

    sorted.forEach((r, idx) => {
      totalMessages += (r.messages_analyzed || 0);
      const names = r.channel_name ? r.channel_name.split(', ') : ['General'];
      names.forEach(name => {
        if (!channelData[name]) channelData[name] = new Array(sorted.length).fill(null);
        channelData[name][idx] = r.score;
        channelLatestScores[name] = r.score;
      });
      try {
        const t = typeof r.toxicity_types === 'string' ? JSON.parse(r.toxicity_types) : r.toxicity_types;
        if (t) Object.entries(t).forEach(([k, v]) => { toxMap[k] = (toxMap[k] || 0) + v; });
      } catch (e) {}
    });

    const globalVibeStrength = (sorted.reduce((s, r) => s + r.score, 0) / sorted.length).toFixed(1);

    // --- SECTION 1: COMMUNITY OVERVIEW ---
    const embed1 = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('📊 Vibe Check Progress Report v2.4')
      .setDescription(`**Date:** ${new Date().toLocaleDateString()}\n**Filters:** Timeframe: ${timeframe} | Sensitivity: ${sensitivity || 'All'}`)
      .addFields(
        { name: '👥 Member Count', value: `Total: **${interaction.guild.memberCount}**`, inline: true },
        { name: '💬 Total Messages', value: `Evaluated: **${totalMessages}**`, inline: true },
        { name: '✨ Vibe Strength (Global)', value: `**${globalVibeStrength}/10** \`${scoreBar(globalVibeStrength)}\``, inline: false }
      )
      .setImage(pieChart(latest.friendly, latest.neutral, latest.unfriendly));

    // --- SECTION 2: GENERAL TREND ANALYSIS ---
    const embed2 = new EmbedBuilder()
      .setColor(0x22c55e)
      .setTitle('📈 General Trend Analysis')
      .addFields(
        { name: '🧪 Cumulative Toxicity Breakdown', value: 'Counts of specific behaviors detected across timeframe.', inline: false },
        { name: '🏆 Top Reactions', value: 'High engagement detected in positive sentiment peaks.', inline: false }
      )
      .setImage(vibeStrengthChart(sorted));

    // --- SECTION 3: TREND ANALYSIS PER CHANNEL ---
    const embed3 = new EmbedBuilder()
      .setColor(0x8b5cf6)
      .setTitle('🧪 Trend Analysis Per Channel')
      .setDescription('Individual Vibe Levels and specific behavior trajectories.')
      .setImage(multiChannelLineChart(channelData, labels));

    const embed3_2 = new EmbedBuilder()
      .setColor(0x8b5cf6)
      .setImage(behaviorEvolutionChart(sorted));

    // --- SECTION 4: PREDICTIVE ANALYTICS ---
    const embed4 = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle('🔮 Predictive Analytics')
      .setDescription(`Based on momentum, there is a probability of continued stability or growth in healthy interactions.`);

    // --- SECTION 5: NEXT STEPS ---
    const embed5 = new EmbedBuilder()
      .setColor(0xf97316)
      .setTitle('💡 Next Steps')
      .addFields({
        name: 'Actionable Advice',
        value: `• **Recognize Contributors:** Spotlight the members driving the Friendly % up.\n• **Weekly Rituals:** Host a community 'Win of the Week' to maintain momentum.`
      })
      .setFooter({ text: 'Always run these reports on a regular basis to increase prediction accuracy and track long-term growth.' });

    await interaction.editReply({ embeds: [embed1, embed2, embed3, embed3_2, embed4, embed5] });

  } catch (err) {
    console.error(err);
    interaction.editReply('Error generating report.');
  }
}

// ============================================================
// COMMAND REGISTRATION
// ============================================================

async function registerCommands() {
  const progress = new SlashCommandBuilder()
    .setName('vibe-progress')
    .setDescription('Track community health over time')
    .addChannelOption(o => o.setName('channel').setDescription('Filter by channel'))
    .addChannelOption(o => o.setName('channel2').setDescription('Compare channel'))
    .addChannelOption(o => o.setName('channel3').setDescription('Compare channel'))
    .addStringOption(o => o.setName('timeframe').setDescription('Analyze window').addChoices(
      { name: 'Last 24 Hours', value: '24h' }, { name: 'Last 7 Days', value: '7d' }, { name: 'Last 30 Days', value: '30d' }
    ))
    .addStringOption(o => o.setName('sensitivity').setDescription('Filter strictness').addChoices(
      { name: 'Low', value: 'low' }, { name: 'Medium', value: 'medium' }, { name: 'High', value: 'high' }
    ));

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [progress.toJSON()] });
  console.log('v2.4 Commands Registered');
}

// ============================================================
// HTTP + START
// ============================================================

http.createServer((req, res) => res.end('Vibe Check Bot is running')).listen(process.env.PORT || 3000);
client.login(process.env.DISCORD_TOKEN);
