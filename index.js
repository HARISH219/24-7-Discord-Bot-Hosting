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
const pairStore = require('./pair-store');
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
// Bot superadmins — may use every admin command (pair, unpair, resetxp) regardless
// of their Discord role permissions.
const SUPERADMIN_IDS = [
  '359747431036092417', // harish696 — bot owner
  ...(process.env.SUPERADMIN_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
];
const isSuperadmin = (userId) => SUPERADMIN_IDS.includes(userId);
// If set, ONLY members with this role earn XP (e.g. the Spitzvilla event role).
// Leave empty so everyone earns XP.
const XP_ROLE_ID = (process.env.XP_ROLE_ID || '').trim();
// If true (default), ONLY members who are currently paired via /pair earn XP.
const XP_REQUIRE_PAIR = (process.env.XP_REQUIRE_PAIR ?? 'true') !== 'false';

// True if this member is allowed to earn XP (must be paired, plus optional role gate).
function canEarnXp(member) {
  if (!member) return false;
  const guildId = member.guild?.id;
  const userId = member.id ?? member.user?.id;
  // Pair gate: only members currently paired via /pair earn XP.
  if (XP_REQUIRE_PAIR) {
    if (!guildId || !userId || !pairStore.getPartner(guildId, userId)) return false;
  }
  // Role gate: if a role is configured, require that too.
  if (XP_ROLE_ID && !member.roles?.cache?.has(XP_ROLE_ID)) return false;
  return true;
}

// True if this member may manage pairs (/pair, /unpair): Manage Roles, Admin, or superadmin.
function canManagePairs(interaction) {
  if (isSuperadmin(interaction.user.id)) return true;
  const perms = interaction.memberPermissions;
  return Boolean(
    perms?.has(PermissionFlagsBits.Administrator) || perms?.has(PermissionFlagsBits.ManageRoles),
  );
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
  {
    name: 'pair',
    description: 'Pair two members together as a couple.',
    options: [
      {
        type: ApplicationCommandOptionType.User,
        name: 'user1',
        description: 'First member',
        required: true,
      },
      {
        type: ApplicationCommandOptionType.User,
        name: 'user2',
        description: 'Second member',
        required: true,
      },
    ],
  },
  {
    name: 'unpair',
    description: 'Remove the pairing for a member (either partner works).',
    options: [
      {
        type: ApplicationCommandOptionType.User,
        name: 'user',
        description: 'A member in the pair to remove',
        required: true,
      },
    ],
  },
  {
    name: 'pairlist',
    description: 'Show all current couples in this server.',
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

function handleXpGain(guild, member, amount, kind) {
  const user = member.user || member;
  const displayName = member.displayName || user.username;
  const { before, after } = store.addXp(
    guild.id,
    user.id,
    amount,
    { username: displayName, avatar: user.displayAvatarURL ? user.displayAvatarURL() : null },
    kind,
  );

  const levelBefore = levelForXp(before).level;
  const levelAfter = levelForXp(after).level;
  if (levelAfter > levelBefore && LEVEL_UP_ANNOUNCE) {
    // DM the member privately instead of announcing in the server channel.
    user
      .send(`🎉 You reached **Level ${levelAfter}** in **${guild.name}**! Keep chatting and hopping into voice to climb higher. ☕`)
      .catch(() => {}); // user may have DMs disabled — fail silently
  }
}

function awardMessageXp(message) {
  if (!canEarnXp(message.member)) return; // role gate
  const key = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  const last = msgCooldown.get(key) || 0;
  if (now - last < MESSAGE_COOLDOWN_MS) return;
  msgCooldown.set(key, now);
  handleXpGain(message.guild, message.member || message.author, randomInt(XP_MSG_MIN, XP_MSG_MAX), 'chat');
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
      handleXpGain(guild, member, XP_PER_VOICE_MINUTE, 'voice');
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
// Couple leaderboard — individual XP stays in the store; couples are RANKED by
// the combined XP of both partners. Totals are derived, never duplicated.
// ---------------------------------------------------------------------------
function memberInfo(guildId, userId) {
  const stats = store.getUser(guildId, userId);
  const cached = client.users.cache.get(userId);
  const username = stats.username || cached?.username || 'Member';
  const avatar =
    stats.avatar || (cached && cached.displayAvatarURL ? cached.displayAvatarURL() : null);
  return {
    id: userId,
    username,
    avatar,
    xp: stats.xp,
    chatXp: stats.chatXp,
    voiceXp: stats.voiceXp,
    level: levelForXp(stats.xp).level,
  };
}

function buildCoupleLeaderboard(guildId) {
  const couples = pairStore.listPairs(guildId).map(([a, b]) => {
    const m1 = memberInfo(guildId, a);
    const m2 = memberInfo(guildId, b);
    const totalXp = m1.xp + m2.xp;
    const members = [m1, m2].map((m) => ({
      ...m,
      contribution: totalXp > 0 ? Math.round((m.xp / totalXp) * 1000) / 10 : 0,
    }));
    return {
      pairId: [a, b].sort().join('-'),
      totalXp,
      chatXp: m1.chatXp + m2.chatXp,
      voiceXp: m1.voiceXp + m2.voiceXp,
      members,
    };
  });
  couples.sort((x, y) => y.totalXp - x.totalXp);
  couples.forEach((c, i) => {
    c.rank = i + 1;
  });
  return couples;
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
  console.log(
    XP_REQUIRE_PAIR
      ? '💞 XP counted ONLY for paired members (/pair)'
      : '💞 XP counted for everyone, paired or not',
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
      const { xp, chatXp, voiceXp } = store.getUser(guildId, target.id);
      const { level, xpIntoLevel, xpForNext } = levelForXp(xp);
      const { rank, total } = store.rankOf(guildId, target.id);
      const partnerId = pairStore.getPartner(guildId, target.id);

      const embed = new EmbedBuilder()
        .setColor(0xf472b6)
        .setAuthor({ name: `${target.username}'s rank`, iconURL: target.displayAvatarURL() })
        .setThumbnail(target.displayAvatarURL())
        .addFields(
          { name: 'Level', value: `**${level}**`, inline: true },
          { name: 'Progress', value: `${xpIntoLevel} / ${xpForNext}`, inline: true },
          { name: 'Rank', value: rank ? `#${rank} of ${total}` : 'Unranked', inline: true },
          { name: '💬 Chat XP', value: `${chatXp.toLocaleString()}`, inline: true },
          { name: '🎙️ Voice XP', value: `${voiceXp.toLocaleString()}`, inline: true },
          { name: '⭐ Total XP', value: `${xp.toLocaleString()}`, inline: true },
          {
            name: '❤️ Partner',
            value: partnerId ? `<@${partnerId}>` : '_Not paired — not earning XP_',
            inline: false,
          },
        );
      return interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }

    if (interaction.commandName === 'leaderboard') {
      const couples = buildCoupleLeaderboard(guildId);
      if (couples.length === 0) {
        return interaction.reply('No couples on the board yet — use `/pair` to add some! 💞');
      }
      const medals = ['🥇', '🥈', '🥉'];
      const lines = couples.slice(0, 10).map((c, i) => {
        const place = medals[i] || `**#${i + 1}**`;
        const [m1, m2] = c.members;
        return `${place}  <@${m1.id}> ❤️ <@${m2.id}>\n **${c.totalXp.toLocaleString()} XP**`;
      });
      const embed = new EmbedBuilder()
        .setColor(0xf472b6)
        .setTitle(`🏆 ${interaction.guild.name} — Couple XP Leaderboard`)
        .setDescription(lines.join('\n'))
        .setFooter({ text: 'Ranked by combined XP • see the full breakdown on the website' });
      return interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }

    if (interaction.commandName === 'resetxp') {
      const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
      const isAuthorized =
        isAdmin || isSuperadmin(interaction.user.id) || RESET_USER_IDS.includes(interaction.user.id);
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

    if (interaction.commandName === 'pair') {
      if (!canManagePairs(interaction)) {
        return interaction.reply({
          content: '⛔ You need the **Manage Roles** permission to pair members.',
          ephemeral: true,
        });
      }
      const u1 = interaction.options.getUser('user1');
      const u2 = interaction.options.getUser('user2');
      if (u1.id === u2.id) {
        return interaction.reply({
          content: "❌ You can't pair someone with themselves.",
          ephemeral: true,
        });
      }
      if (u1.bot || u2.bot) {
        return interaction.reply({ content: '❌ Bots cannot be paired.', ephemeral: true });
      }
      const cur1 = pairStore.getPartner(guildId, u1.id);
      if (cur1) {
        return interaction.reply({
          content: `❌ <@${u1.id}> is already paired with <@${cur1}>. Unpair them first.`,
          ephemeral: true,
        });
      }
      const cur2 = pairStore.getPartner(guildId, u2.id);
      if (cur2) {
        return interaction.reply({
          content: `❌ <@${u2.id}> is already paired with <@${cur2}>. Unpair them first.`,
          ephemeral: true,
        });
      }
      pairStore.pair(guildId, u1.id, u2.id);
      return interaction.reply({
        content: `💞 <@${u1.id}> and <@${u2.id}> are now paired! Welcome to the couples of **${interaction.guild.name}**. ☕`,
        allowedMentions: { users: [u1.id, u2.id] },
      });
    }

    if (interaction.commandName === 'unpair') {
      if (!canManagePairs(interaction)) {
        return interaction.reply({
          content: '⛔ You need the **Manage Roles** permission to unpair members.',
          ephemeral: true,
        });
      }
      const target = interaction.options.getUser('user');
      const partner = pairStore.getPartner(guildId, target.id);
      if (!partner) {
        return interaction.reply({
          content: `❌ <@${target.id}> isn't paired with anyone.`,
          ephemeral: true,
        });
      }
      pairStore.unpair(guildId, target.id);
      return interaction.reply({
        content: `💔 <@${target.id}> and <@${partner}> are no longer paired.`,
        allowedMentions: { users: [] },
      });
    }

    if (interaction.commandName === 'pairlist') {
      const pairs = pairStore.listPairs(guildId);
      if (pairs.length === 0) {
        return interaction.reply('No couples yet — use `/pair` to create the first one! 💞');
      }
      const lines = pairs.map(([a, b], i) => `**${i + 1}.** <@${a}> 💕 <@${b}>`);
      const embed = new EmbedBuilder()
        .setColor(0xf472b6)
        .setTitle(`💞 ${interaction.guild.name} — Couples`)
        .setDescription(lines.join('\n').slice(0, 4000));
      return interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
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

// Couple leaderboard data for the web UI — one board per server the bot is in.
app.get('/api/leaderboard', (req, res) => {
  const guilds = [];
  for (const [id, guild] of client.guilds.cache) {
    guilds.push({
      id,
      name: guild.name,
      memberCount: guild.memberCount,
      couples: buildCoupleLeaderboard(id),
    });
  }
  res.json({
    success: true,
    guilds,
    botUsername: client.user?.tag || null,
    criteria: {
      chatMin: XP_MSG_MIN,
      chatMax: XP_MSG_MAX,
      chatCooldownSec: MESSAGE_COOLDOWN_MS / 1000,
      voicePerMinute: XP_PER_VOICE_MINUTE,
      requirePair: XP_REQUIRE_PAIR,
    },
  });
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
