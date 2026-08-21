require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionFlagsBits,
  ApplicationCommandOptionType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const store = require('./xp-store');
const pairStore = require('./pair-store');
const inviteStore = require('./invite-store');
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

// ---------------------------------------------------------------------------
// Pair requests — /pair proposes a couple; the pairing only happens once BOTH
// proposed members click Accept. Either one clicking Deny cancels it.
// ---------------------------------------------------------------------------
const PAIR_REQUEST_TTL_MS = 10 * 60 * 1000; // 10 minutes to respond
const pendingPairRequests = new Map(); // reqId -> { guildId, guildName, user1, user2, accepted: Set, timeout }

function pairRequestEmbed({ guildName, user1, user2, accepted }, status) {
  const check = (id) => (accepted.has(id) ? '✅' : '⬜');
  const statusLine = {
    pending: 'Waiting for both members to accept.',
    accepted: `💞 Paired! Welcome to the couples of **${guildName}**.`,
    denied: '❌ Request denied — no pairing was made.',
    expired: '⌛ Request expired — no pairing was made.',
    conflict: '❌ One of you got paired with someone else in the meantime. Cancelled.',
  }[status];
  return new EmbedBuilder()
    .setColor(status === 'accepted' ? 0x4ade80 : status === 'pending' ? 0xf472b6 : 0x6b7280)
    .setTitle('💌 Couple pairing request')
    .setDescription(
      `${check(user1.id)} <@${user1.id}>\n${check(user2.id)} <@${user2.id}>\n\n${statusLine}`,
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
    GatewayIntentBits.GuildMembers, // needed to detect new members for invite tracking
    GatewayIntentBits.GuildInvites, // needed to track invite usage
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
  const invites = inviteStore.getInvites(guildId, userId);
  return {
    id: userId,
    username,
    avatar,
    xp: stats.xp,
    chatXp: stats.chatXp,
    voiceXp: stats.voiceXp,
    level: levelForXp(stats.xp).level,
    invites,
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

  // Cache invites for tracking
  for (const [, guild] of client.guilds.cache) {
    try {
      const invites = await guild.invites.fetch();
      guild._cachedInvites = new Map(invites.map((inv) => [inv.code, inv.uses]));
    } catch (e) {
      console.log(`⚠️  Could not fetch invites for ${guild.name}: ${e.message}`);
      guild._cachedInvites = new Map();
    }
  }
  console.log('📨 Invite tracking ready');
});

// Register commands when the bot is invited to a new server (e.g. Spitzvilla).
client.on('guildCreate', (guild) => registerCommands(guild));

// ---------------------------------------------------------------------------
// Invite tracking — detect who invited a new member
// ---------------------------------------------------------------------------
const INVITE_BONUS_XP = 100;

client.on('inviteCreate', (invite) => {
  const guild = invite.guild;
  if (!guild._cachedInvites) guild._cachedInvites = new Map();
  guild._cachedInvites.set(invite.code, invite.uses);
});

client.on('inviteDelete', (invite) => {
  const guild = invite.guild;
  if (guild._cachedInvites) guild._cachedInvites.delete(invite.code);
});

client.on('guildMemberAdd', async (member) => {
  if (member.user.bot) return;
  const guild = member.guild;
  try {
    const newInvites = await guild.invites.fetch();
    const oldInvites = guild._cachedInvites || new Map();

    // Find the invite whose uses increased
    const usedInvite = newInvites.find((inv) => {
      const oldUses = oldInvites.get(inv.code) || 0;
      return inv.uses > oldUses;
    });

    if (usedInvite && usedInvite.inviter) {
      const inviterId = usedInvite.inviter.id;
      const count = inviteStore.addInvite(guild.id, inviterId, {
        username: usedInvite.inviter.username,
        avatar: usedInvite.inviter.displayAvatarURL?.() || null,
      });

      // Award invite bonus XP to the inviter (if they are paired)
      const inviterMember = guild.members.cache.get(inviterId);
      if (inviterMember && canEarnXp(inviterMember)) {
        handleXpGain(guild, inviterMember, INVITE_BONUS_XP, 'chat');
      }

      console.log(`📨 ${usedInvite.inviter.username} invited ${member.user.username} (total: ${count})`);
    }

    // Update cache
    guild._cachedInvites = new Map(newInvites.map((inv) => [inv.code, inv.uses]));
  } catch (e) {
    console.log(`⚠️  Could not track invite for ${member.user.username}: ${e.message}`);
  }
});

client.on('messageCreate', (message) => {
  if (message.author.bot || !message.guild) return;
  awardMessageXp(message); // XP for chatting, any channel
  if (message.channel.id === process.env.CHANNEL_ID) relayMessage(message);
});

client.on('interactionCreate', async (interaction) => {
  // Accept/Deny buttons on a /pair request.
  if (interaction.isButton() && interaction.customId.startsWith('pairreq:')) {
    const [, action, reqId] = interaction.customId.split(':');
    const request = pendingPairRequests.get(reqId);
    if (!request) {
      return interaction.reply({
        content: '⌛ This pairing request is no longer active.',
        ephemeral: true,
      });
    }
    const { user1, user2, guildId: reqGuildId } = request;
    if (interaction.user.id !== user1.id && interaction.user.id !== user2.id) {
      return interaction.reply({
        content: '⛔ This request is not for you.',
        ephemeral: true,
      });
    }

    if (action === 'deny') {
      clearTimeout(request.timeout);
      pendingPairRequests.delete(reqId);
      return interaction.update({ embeds: [pairRequestEmbed(request, 'denied')], components: [] });
    }

    if (action === 'accept') {
      request.accepted.add(interaction.user.id);
      if (request.accepted.size < 2) {
        return interaction.update({ embeds: [pairRequestEmbed(request, 'pending')] });
      }

      // Both accepted — finalize, but re-check neither got paired elsewhere meanwhile.
      clearTimeout(request.timeout);
      pendingPairRequests.delete(reqId);
      if (pairStore.getPartner(reqGuildId, user1.id) || pairStore.getPartner(reqGuildId, user2.id)) {
        return interaction.update({ embeds: [pairRequestEmbed(request, 'conflict')], components: [] });
      }
      pairStore.pair(reqGuildId, user1.id, user2.id);

      // DM both users about successful pairing
      const dmEmbed = (partnerId) => ({
        color: 0xf472b6,
        title: '❤️ YOU ARE NOW PAIRED!',
        description: `You are now paired with <@${partnerId}> for the **${request.guildName}** event.\n\nYou can now earn XP together through chatting and voice activity.\n\nGood luck! ❤️`,
      });
      user1.send({ embeds: [dmEmbed(user2.id)] }).catch(() => {});
      user2.send({ embeds: [dmEmbed(user1.id)] }).catch(() => {});

      // Audit log
      const auditStore2 = require('./audit-store');
      auditStore2.record({ actor: 'system', actorRole: 'SYSTEM', action: 'pair.accepted', target: `${user1.id} + ${user2.id}`, result: 'success' });

      return interaction.update({ embeds: [pairRequestEmbed(request, 'accepted')], components: [] });
    }
    return;
  }

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
        return interaction.reply('No duos on the board yet — use `/pair` to add some! 💞');
      }
      const medals = ['🥇', '🥈', '🥉'];
      const lines = couples.slice(0, 10).map((c, i) => {
        const place = medals[i] || `**#${i + 1}**`;
        const [m1, m2] = c.members;
        return `${place}  <@${m1.id}> ❤️ <@${m2.id}>\n **${c.totalXp.toLocaleString()} XP**`;
      });
      const embed = new EmbedBuilder()
        .setColor(0xf472b6)
        .setTitle(`🏆 ${interaction.guild.name} — Duo XP Leaderboard`)
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
      // Don't send a request while one is already pending for either user.
      for (const req of pendingPairRequests.values()) {
        if (req.guildId !== guildId) continue;
        if ([req.user1.id, req.user2.id].some((id) => id === u1.id || id === u2.id)) {
          return interaction.reply({
            content: '❌ One of them already has a pending pair request. Wait for it to resolve first.',
            ephemeral: true,
          });
        }
      }

      const reqId = crypto.randomUUID();
      const request = {
        guildId,
        guildName: interaction.guild.name,
        user1: u1,
        user2: u2,
        accepted: new Set(),
      };
      request.timeout = setTimeout(() => {
        if (!pendingPairRequests.has(reqId)) return;
        pendingPairRequests.delete(reqId);
        interaction
          .editReply({ embeds: [pairRequestEmbed(request, 'expired')], components: [] })
          .catch(() => {});
      }, PAIR_REQUEST_TTL_MS);
      pendingPairRequests.set(reqId, request);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`pairreq:accept:${reqId}`)
          .setLabel('Accept')
          .setStyle(ButtonStyle.Success)
          .setEmoji('✅'),
        new ButtonBuilder()
          .setCustomId(`pairreq:deny:${reqId}`)
          .setLabel('Deny')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('❌'),
      );

      return interaction.reply({
        content: `<@${u1.id}> <@${u2.id}> — you've been proposed as a couple! Both of you must **Accept** below.`,
        embeds: [pairRequestEmbed(request, 'pending')],
        components: [row],
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

      // DM both users about unpairing
      const unpairDm = (otherId) => ({
        color: 0x6b7280,
        title: '💔 COUPLE STATUS UPDATED',
        description: `You are no longer paired with <@${otherId}> in the **${interaction.guild.name}** event.\n\nYour previously earned XP has not been deleted.`,
      });
      client.users.fetch(target.id).then((u) => u.send({ embeds: [unpairDm(partner)] })).catch(() => {});
      client.users.fetch(partner).then((u) => u.send({ embeds: [unpairDm(target.id)] })).catch(() => {});

      return interaction.reply({
        content: `💔 <@${target.id}> and <@${partner}> are no longer paired.`,
        allowedMentions: { users: [] },
      });
    }

    if (interaction.commandName === 'pairlist') {
      const pairs = pairStore.listPairs(guildId);
      if (pairs.length === 0) {
        return interaction.reply('No duos yet — use `/pair` to create the first one! 💞');
      }
      const lines = pairs.map(([a, b], i) => `**${i + 1}.** <@${a}> 💕 <@${b}>`);
      const embed = new EmbedBuilder()
        .setColor(0xf472b6)
        .setTitle(`💞 ${interaction.guild.name} — Duos`)
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
app.use(express.json({ limit: '1mb' }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Block access to sensitive data files
app.use((req, res, next) => {
  const blocked = ['.json', '.env', 'organizer-data', 'audit-log', 'xp-data', 'pair-data', 'invite-data'];
  const lower = req.path.toLowerCase();
  if (blocked.some(b => lower.includes(b)) && !lower.startsWith('/api/')) {
    return res.status(403).send('Forbidden');
  }
  next();
});

app.use(express.static('public'));

// Rate limiting for login (max 5 attempts per IP per 5 minutes)
const loginAttempts = new Map(); // ip -> { count, resetAt }
function checkLoginRate(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (record && record.resetAt > now && record.count >= 5) {
    const waitSec = Math.ceil((record.resetAt - now) / 1000);
    return res.status(429).json({ success: false, error: `Too many login attempts. Try again in ${waitSec}s.` });
  }
  if (!record || record.resetAt <= now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 5 * 60 * 1000 });
  } else {
    record.count++;
  }
  next();
}
// Clear old entries every 10 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of loginAttempts) {
    if (rec.resetAt <= now) loginAttempts.delete(ip);
  }
}, 10 * 60 * 1000);

// Apply rate limit to login endpoint
app.post('/api/admin/auth/login', checkLoginRate);

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

// ---------------------------------------------------------------------------
// Extended API for the Dashboard
// ---------------------------------------------------------------------------

// Bot overview stats
app.get('/api/stats', (req, res) => {
  const isReady = !!client.user;
  const guilds = [];
  let totalMembers = 0;
  let totalPairs = 0;
  let totalVoiceUsers = 0;

  if (isReady) {
    for (const [id, guild] of client.guilds.cache) {
      const pairs = pairStore.listPairs(id);
      const voiceCount = guild.voiceStates.cache.filter(
        (vs) => vs.channelId && vs.channelId !== guild.afkChannelId,
      ).size;
      totalMembers += guild.memberCount;
      totalPairs += pairs.length;
      totalVoiceUsers += voiceCount;
      guilds.push({
        id,
        name: guild.name,
        icon: guild.iconURL({ size: 128 }),
        memberCount: guild.memberCount,
        pairCount: pairs.length,
        voiceActive: voiceCount,
      });
    }
  }

  res.json({
    success: true,
    ready: isReady,
    bot: {
      username: client.user?.username || null,
      tag: client.user?.tag || null,
      avatar: client.user?.displayAvatarURL?.({ size: 128 }) || null,
      uptime: client.uptime || 0,
      guildCount: client.guilds.cache.size,
    },
    totals: {
      members: totalMembers,
      pairs: totalPairs,
      voiceActive: totalVoiceUsers,
      guilds: client.guilds.cache.size,
    },
    guilds,
    config: {
      chatMin: XP_MSG_MIN,
      chatMax: XP_MSG_MAX,
      chatCooldownSec: MESSAGE_COOLDOWN_MS / 1000,
      voicePerMinute: XP_PER_VOICE_MINUTE,
      requirePair: XP_REQUIRE_PAIR,
      roleGated: !!XP_ROLE_ID,
      inviteBonusXp: INVITE_BONUS_XP,
    },
  });
});

// All servers the bot is in
app.get('/api/servers', (req, res) => {
  const servers = [];
  for (const [id, guild] of client.guilds.cache) {
    servers.push({
      id,
      name: guild.name,
      icon: guild.iconURL({ size: 128 }),
      memberCount: guild.memberCount,
      pairCount: pairStore.listPairs(id).length,
    });
  }
  res.json({ success: true, servers });
});

// Pairs for a specific guild
app.get('/api/pairs/:guildId', (req, res) => {
  const { guildId } = req.params;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return res.status(404).json({ success: false, error: 'Guild not found' });

  const pairs = pairStore.listPairs(guildId).map(([a, b]) => {
    const m1 = memberInfo(guildId, a);
    const m2 = memberInfo(guildId, b);
    return {
      pairId: [a, b].sort().join('-'),
      members: [m1, m2],
      totalXp: m1.xp + m2.xp,
    };
  });
  pairs.sort((x, y) => y.totalXp - x.totalXp);
  res.json({ success: true, guildName: guild.name, pairs });
});

// All members with XP for a specific guild
app.get('/api/members/:guildId', (req, res) => {
  const { guildId } = req.params;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return res.status(404).json({ success: false, error: 'Guild not found' });

  const lb = store.leaderboard(guildId, 100);
  const allInvites = inviteStore.getAllInvites(guildId);
  const members = lb.map((entry) => {
    const { level } = levelForXp(entry.xp);
    const partner = pairStore.getPartner(guildId, entry.userId);
    const invites = allInvites[entry.userId]?.invites ?? 0;
    return {
      id: entry.userId,
      username: entry.username,
      avatar: entry.avatar,
      xp: entry.xp,
      chatXp: entry.chatXp,
      voiceXp: entry.voiceXp,
      level,
      partnerId: partner,
      invites,
    };
  });
  res.json({ success: true, guildName: guild.name, members, inviteBonusXp: INVITE_BONUS_XP });
});

// Voice activity — who's currently in voice
app.get('/api/voice/:guildId', (req, res) => {
  const { guildId } = req.params;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return res.status(404).json({ success: false, error: 'Guild not found' });

  const voiceUsers = [];
  for (const [, vs] of guild.voiceStates.cache) {
    if (!vs.channelId || vs.channelId === guild.afkChannelId) continue;
    const member = vs.member;
    if (!member || member.user.bot) continue;
    voiceUsers.push({
      id: member.id,
      username: member.displayName || member.user.username,
      avatar: member.user.displayAvatarURL?.() || null,
      channel: vs.channel?.name || 'Unknown',
      selfDeaf: vs.selfDeaf,
      selfMute: vs.selfMute,
      streaming: vs.streaming,
    });
  }
  res.json({ success: true, guildName: guild.name, voiceUsers });
});

// ---------------------------------------------------------------------------
// Admin Dashboard API (organizer roles, auth, XP management, pairing)
// ---------------------------------------------------------------------------
const createAdminRouter = require('./api-routes');
const organizerStore = require('./organizer-store');
const auditStore = require('./audit-store');

const adminRouter = createAdminRouter(
  () => client,
  () => pendingPairRequests,
);
app.use('/api/admin', adminRouter);

// Handle web-initiated pair requests: after the API returns success,
// the frontend POSTs to /api/admin/couples/pair and we send the Discord request.
// We override the default response with a middleware that fires after.
app.post('/api/admin/couples/pair-via-discord', require('./auth').requireAuth, require('./auth').requirePermission('couples.pair'), async (req, res) => {
  let { userId1, userId2 } = req.body;
  if (!userId1 || !userId2) return res.status(400).json({ success: false, error: 'userId1 and userId2 required.' });
  if (userId1 === userId2) return res.status(400).json({ success: false, error: 'Cannot pair a user with themselves.' });

  const GUILD_ID = '1289894372887760991';
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return res.status(500).json({ success: false, error: 'Bot not connected to the server.' });

  // Resolve user input — accepts Discord ID, username, or displayName
  async function resolveUser(input) {
    input = input.trim();
    // If it looks like a numeric ID (all digits, 17-20 chars)
    if (/^\d{17,20}$/.test(input)) {
      try { return await client.users.fetch(input); } catch { return null; }
    }
    // Otherwise search guild members by username or displayName
    try {
      await guild.members.fetch({ query: input, limit: 5 });
    } catch {}
    const member = guild.members.cache.find(m =>
      m.user.username.toLowerCase() === input.toLowerCase() ||
      m.displayName.toLowerCase() === input.toLowerCase() ||
      m.user.tag.toLowerCase() === input.toLowerCase()
    );
    if (member) return member.user;
    // Try partial match
    const partial = guild.members.cache.find(m =>
      m.user.username.toLowerCase().includes(input.toLowerCase()) ||
      m.displayName.toLowerCase().includes(input.toLowerCase())
    );
    if (partial) return partial.user;
    return null;
  }

  const u1 = await resolveUser(userId1);
  const u2 = await resolveUser(userId2);
  if (!u1) return res.status(400).json({ success: false, error: `Could not find user: "${userId1}". Try their Discord ID or exact username.` });
  if (!u2) return res.status(400).json({ success: false, error: `Could not find user: "${userId2}". Try their Discord ID or exact username.` });

  // Use resolved IDs from here
  userId1 = u1.id;
  userId2 = u2.id;
  if (userId1 === userId2) return res.status(400).json({ success: false, error: 'Both inputs resolved to the same user.' });

  const cur1 = pairStore.getPartner(GUILD_ID, userId1);
  if (cur1) return res.status(400).json({ success: false, error: `${u1.username} is already paired.` });
  const cur2 = pairStore.getPartner(GUILD_ID, userId2);
  if (cur2) return res.status(400).json({ success: false, error: `${u2.username} is already paired.` });

  // Check no pending request
  for (const r of pendingPairRequests.values()) {
    if (r.guildId !== GUILD_ID) continue;
    if ([r.user1.id, r.user2.id].some((id) => id === userId1 || id === userId2)) {
      return res.status(400).json({ success: false, error: 'A pending pair request already exists for one of these users.' });
    }
  }

  // Create the pair request (same logic as /pair slash command)
  const crypto = require('crypto');
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
  const reqId = crypto.randomUUID();
  const request = {
    guildId: GUILD_ID,
    guildName: guild.name,
    user1: u1,
    user2: u2,
    accepted: new Set(),
  };
  request.timeout = setTimeout(() => {
    if (!pendingPairRequests.has(reqId)) return;
    pendingPairRequests.delete(reqId);
    // Try to edit the message if we stored a reference
  }, PAIR_REQUEST_TTL_MS);
  pendingPairRequests.set(reqId, request);

  // Send the pair request message in a channel the users can see
  const channelId = process.env.CHANNEL_ID;
  const channel = guild.channels.cache.get(channelId) || guild.systemChannel;
  if (!channel) {
    pendingPairRequests.delete(reqId);
    clearTimeout(request.timeout);
    return res.status(500).json({ success: false, error: 'No suitable channel to send pair request.' });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`pairreq:accept:${reqId}`).setLabel('Accept').setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder().setCustomId(`pairreq:deny:${reqId}`).setLabel('Deny').setStyle(ButtonStyle.Danger).setEmoji('❌'),
  );

  try {
    await channel.send({
      content: `<@${u1.id}> <@${u2.id}> — you've been proposed as a duo! Both of you must **Accept** below.`,
      embeds: [pairRequestEmbed(request, 'pending')],
      components: [row],
      allowedMentions: { users: [u1.id, u2.id] },
    });
  } catch (e) {
    pendingPairRequests.delete(reqId);
    clearTimeout(request.timeout);
    return res.status(500).json({ success: false, error: 'Failed to send Discord message: ' + e.message });
  }

  auditStore.record({
    actor: req.user.username,
    actorRole: req.user.role,
    action: 'pair.request',
    target: `${userId1} + ${userId2}`,
    details: { source: 'web-dashboard' },
    result: 'pending',
  });

  res.json({ success: true, message: 'Pair request sent via Discord. Both users must accept.' });
});

// ---------------------------------------------------------------------------
// Seed Owner account on startup
// ---------------------------------------------------------------------------
const OWNER_USERNAME = process.env.OWNER_USERNAME || 'owner';
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || 'changeme123';
const seedResult = organizerStore.seedOwner(OWNER_USERNAME, OWNER_PASSWORD);
if (seedResult.seeded) {
  console.log(`👑 Owner account created: username="${OWNER_USERNAME}" (change password on first login or set OWNER_PASSWORD env)`);
} else {
  console.log(`👑 Owner account exists: ${seedResult.existing?.username}`);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Web server running on http://localhost:${PORT}`);
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('❌ Failed to login to Discord:', err.message);
  console.error('🌐 Web server will keep running — fix DISCORD_TOKEN in .env and restart.');
});

client.on('error', console.error);
process.on('unhandledRejection', console.error);
