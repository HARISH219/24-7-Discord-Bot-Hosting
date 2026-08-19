require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionFlagsBits,
  ApplicationCommandOptionType,
} = require('discord.js');
const express = require('express');
const cors = require('cors');
const store = require('./xp-store');
const { levelForXp } = require('./leveling');

// ---------------------------------------------------------------------------
// Config (all overridable via .env)
// ---------------------------------------------------------------------------
const toInt = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const XP_MSG_MIN = toInt(process.env.XP_PER_MESSAGE_MIN, 15);
const XP_MSG_MAX = toInt(process.env.XP_PER_MESSAGE_MAX, 25);
const MESSAGE_COOLDOWN_MS = toInt(process.env.XP_MESSAGE_COOLDOWN_SEC, 60) * 1000;
const XP_PER_VOICE_MINUTE = toInt(process.env.XP_PER_VOICE_MINUTE, 10);
const VOICE_INTERVAL_MS = 60 * 1000;
const LEVEL_UP_ANNOUNCE = (process.env.LEVEL_UP_ANNOUNCE ?? 'true') !== 'false';
// Users who may reset XP even without Administrator (e.g. harish696's user ID).
const RESET_USER_IDS = (process.env.XP_RESET_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// If set, ONLY members with this role earn XP (e.g. the Spitzvilla event role).
// Leave empty so everyone earns XP.
const XP_ROLE_ID = (process.env.XP_ROLE_ID || '').trim();

// True if this member is allowed to earn XP (role gate).
function canEarnXp(member) {
  if (!XP_ROLE_ID) return true;
  return Boolean(member?.roles?.cache?.has(XP_ROLE_ID));
}

const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// Store recent messages (last 50 messages) for the optional website relay.
const messageHistory = [];
const MAX_MESSAGES = 50;

// ---------------------------------------------------------------------------
// Discord client
// ---------------------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates, // needed to award XP for time in voice
  ],
});

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------
const commands = [
  {
    name: 'rank',
    description: "Show your level and XP (or another member's).",
    options: [
      {
        type: ApplicationCommandOptionType.User,
        name: 'user',
        description: 'Member to check (defaults to you)',
        required: false,
      },
    ],
  },
  {
    name: 'leaderboard',
    description: 'Top members by XP in this server.',
  },
  {
    name: 'resetxp',
    description: 'Reset XP (Administrators and authorized users only).',
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'user',
        description: "Reset a single member's XP to zero.",
        options: [
          {
            type: ApplicationCommandOptionType.User,
            name: 'target',
            description: 'Member whose XP to reset',
            required: true,
          },
        ],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'all',
        description: 'Reset XP for EVERYONE in this server (start a fresh event).',
      },
    ],
  },
];

async function registerCommands(guild) {
  try {
    await guild.commands.set(commands);
    console.log(`⚙️  Registered slash commands in ${guild.name}`);
  } catch (err) {
    console.error(`⚠️  Could not register commands in ${guild.id}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// XP awarding
// ---------------------------------------------------------------------------
const msgCooldown = new Map(); // `${guildId}:${userId}` -> last award timestamp

function handleXpGain(guild, member, announceChannel, amount) {
  const user = member.user || member;
  const displayName = member.displayName || user.username;
  const { before, after } = store.addXp(guild.id, user.id, amount, {
    username: displayName,
    avatar: user.displayAvatarURL ? user.displayAvatarURL() : null,
  });

  const levelBefore = levelForXp(before).level;
  const levelAfter = levelForXp(after).level;
  if (levelAfter > levelBefore && LEVEL_UP_ANNOUNCE && announceChannel) {
    announceChannel
      .send(`🎉 <@${user.id}> leveled up to **Level ${levelAfter}**!`)
      .catch(() => {});
  }
}

function awardMessageXp(message) {
  if (!canEarnXp(message.member)) return; // role gate
  const key = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  const last = msgCooldown.get(key) || 0;
  if (now - last < MESSAGE_COOLDOWN_MS) return;
  msgCooldown.set(key, now);
  handleXpGain(message.guild, message.member || message.author, message.channel, randomInt(XP_MSG_MIN, XP_MSG_MAX));
}

// Award voice XP once per minute to everyone actively sitting in a voice channel.
function tickVoiceXp() {
  for (const [, guild] of client.guilds.cache) {
    for (const [, voiceState] of guild.voiceStates.cache) {
      if (!voiceState.channelId) continue; // not in voice
      if (voiceState.channelId === guild.afkChannelId) continue; // AFK room
      const member = voiceState.member;
      if (!member || member.user.bot) continue;
      if (voiceState.selfDeaf || voiceState.deaf) continue; // deafened = not participating
      if (!canEarnXp(member)) continue; // role gate
      handleXpGain(guild, member, voiceState.channel, XP_PER_VOICE_MINUTE);
    }
  }
}

// ---------------------------------------------------------------------------
// Website relay (optional; the site now reads via its own API route)
// ---------------------------------------------------------------------------
function relayMessage(message) {
  const messageData = {
    id: message.id,
    content: message.content,
    author: {
      username: message.author.username,
      displayName: message.author.displayName || message.author.username,
      avatar: message.author.displayAvatarURL(),
    },
    timestamp: message.createdAt.toISOString(),
    attachments: message.attachments.map((att) => ({
      url: att.url,
      name: att.name,
      type: att.contentType,
    })),
  };
  messageHistory.unshift(messageData);
  if (messageHistory.length > MAX_MESSAGES) messageHistory.pop();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
client.once('clientReady', async () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  console.log(
    `🎮 XP: ${XP_MSG_MIN}-${XP_MSG_MAX}/msg (cooldown ${MESSAGE_COOLDOWN_MS / 1000}s), ${XP_PER_VOICE_MINUTE}/min in voice`,
  );
  console.log(
    `🔑 Reset allowed for: Administrators${RESET_USER_IDS.length ? ` + ${RESET_USER_IDS.length} user ID(s)` : ''}`,
  );
  console.log(
    XP_ROLE_ID ? `🎭 XP limited to members with role ${XP_ROLE_ID}` : '🎭 XP open to everyone',
  );
  for (const [, guild] of client.guilds.cache) {
    await registerCommands(guild);
  }
  setInterval(tickVoiceXp, VOICE_INTERVAL_MS);
});

// Register commands when the bot is invited to a new server (e.g. Spitzvilla).
client.on('guildCreate', (guild) => registerCommands(guild));

client.on('messageCreate', (message) => {
  if (message.author.bot || !message.guild) return;
  awardMessageXp(message); // XP for chatting, any channel
  if (message.channel.id === process.env.CHANNEL_ID) relayMessage(message);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild()) {
    return interaction.reply({ content: 'Use this command inside a server.', ephemeral: true });
  }

  const guildId = interaction.guildId;

  try {
    if (interaction.commandName === 'rank') {
      const target = interaction.options.getUser('user') || interaction.user;
      const { xp } = store.getUser(guildId, target.id);
      const { level, xpIntoLevel, xpForNext } = levelForXp(xp);
      const { rank, total } = store.rankOf(guildId, target.id);

      const embed = new EmbedBuilder()
        .setColor(0xf472b6)
        .setAuthor({ name: `${target.username}'s rank`, iconURL: target.displayAvatarURL() })
        .setThumbnail(target.displayAvatarURL())
        .addFields(
          { name: 'Level', value: `**${level}**`, inline: true },
          { name: 'XP', value: `${xpIntoLevel} / ${xpForNext}`, inline: true },
          { name: 'Rank', value: rank ? `#${rank} of ${total}` : 'Unranked', inline: true },
          { name: 'Total XP', value: `${xp}`, inline: true },
        );
      return interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === 'leaderboard') {
      const top = store.leaderboard(guildId, 10);
      if (top.length === 0) {
        return interaction.reply('No XP earned yet — start chatting or hop into voice!');
      }
      const medals = ['🥇', '🥈', '🥉'];
      const lines = top.map((entry, i) => {
        const place = medals[i] || `**${i + 1}.**`;
        const { level } = levelForXp(entry.xp);
        return `${place} <@${entry.userId}> — Level ${level} • ${entry.xp} XP`;
      });
      const embed = new EmbedBuilder()
        .setColor(0xa78bfa)
        .setTitle(`🏆 ${interaction.guild.name} — XP Leaderboard`)
        .setDescription(lines.join('\n'));
      return interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === 'resetxp') {
      const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
      const isAuthorized = isAdmin || RESET_USER_IDS.includes(interaction.user.id);
      if (!isAuthorized) {
        return interaction.reply({
          content: "⛔ You don't have permission to reset XP.",
          ephemeral: true,
        });
      }

      const sub = interaction.options.getSubcommand();
      if (sub === 'user') {
        const target = interaction.options.getUser('target');
        store.resetUser(guildId, target.id);
        return interaction.reply(`✅ Reset <@${target.id}>'s XP to zero.`);
      }
      if (sub === 'all') {
        store.resetGuild(guildId);
        return interaction.reply('✅ Reset XP for **everyone** in this server.');
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (!interaction.replied && !interaction.deferred) {
      interaction.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => {});
    }
  }
});

// ---------------------------------------------------------------------------
// Express (health + optional message relay)
// ---------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.get('/api/messages', (req, res) => {
  res.json({ success: true, messages: messageHistory });
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'online',
    botUsername: client.user?.tag || 'Not connected',
    messageCount: messageHistory.length,
  });
});

// Leaderboard data for the web UI — one board per server the bot is in.
app.get('/api/leaderboard', (req, res) => {
  const guilds = [];
  for (const [id, guild] of client.guilds.cache) {
    const entries = store.leaderboard(id, 50).map((e, i) => {
      const { level, xpIntoLevel, xpForNext } = levelForXp(e.xp);
      return {
        rank: i + 1,
        userId: e.userId,
        username: e.username || 'Member',
        avatar: e.avatar || null,
        level,
        xp: e.xp,
        xpIntoLevel,
        xpForNext,
      };
    });
    guilds.push({ id, name: guild.name, memberCount: guild.memberCount, entries });
  }
  res.json({ success: true, guilds, botUsername: client.user?.tag || null });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Web server running on http://localhost:${PORT}`);
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('❌ Failed to login to Discord:', err.message);
  process.exit(1);
});

client.on('error', console.error);
process.on('unhandledRejection', console.error);
