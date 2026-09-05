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
// If set, ONLY members with this role earn XP (e.g. the Loverswilla event role).
// Leave empty so everyone earns XP.
const XP_ROLE_ID = (process.env.XP_ROLE_ID || '').trim();

// ---------------------------------------------------------------------------
// OTP Storage for Discord ID verification (fallback when bot cannot DM)
// ---------------------------------------------------------------------------
const OTP_TTL_MS = 15 * 60 * 1000; // 15 minutes expiry
const otpStore = new Map(); // discordUserId -> { otp, createdAt, username }

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit OTP
}

function storeOtp(discordUserId, username) {
  const otp = generateOtp();
  otpStore.set(discordUserId, {
    otp,
    createdAt: Date.now(),
    username,
  });
  // Auto-cleanup after TTL
  setTimeout(() => {
    otpStore.delete(discordUserId);
  }, OTP_TTL_MS);
  return otp;
}

function verifyOtp(discordUserId, inputOtp) {
  const record = otpStore.get(discordUserId);
  if (!record) return { valid: false, reason: 'No OTP found or expired' };
  if (Date.now() - record.createdAt > OTP_TTL_MS) {
    otpStore.delete(discordUserId);
    return { valid: false, reason: 'OTP expired' };
  }
  if (record.otp !== inputOtp) {
    return { valid: false, reason: 'Invalid OTP' };
  }
  otpStore.delete(discordUserId); // One-time use
  return { valid: true };
}

// ---------------------------------------------------------------------------
// If true (default), ONLY members who are currently paired via /pair earn XP.
const XP_REQUIRE_PAIR = false; // Disabled — all members earn XP regardless of pair status

// True if this member is allowed to earn XP.
function canEarnXp(member) {
  if (!member) return false;
  // Role gate: if a role is configured, require it.
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
const LEADERBOARD_AUTO_INTERVAL_MS = 10 * 60 * 1000; // 10 min auto-reload
// Stores the most recently posted leaderboard message so the auto-reload
// and the refresh button always edit the SAME message in place.
let lastLbMessage = null; // { channelId, messageId }

/** Generate a fresh leaderboard screenshot and edit the stored message. */
async function autoReloadLeaderboard() {
  if (!lastLbMessage) return;
  try {
    const { screenshotLeaderboard } = require('./urlbox-screenshot');
    const { AttachmentBuilder } = require('discord.js');
    const imgBuffer = await screenshotLeaderboard(true);
    const attachment = new AttachmentBuilder(imgBuffer, { name: 'leaderboard.png' });
    const lbRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('refresh_leaderboard').setLabel('🔄 Refresh').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setLabel('View Full Leaderboard').setStyle(ButtonStyle.Link).setURL('https://www.loverscafe.online/leaderboard'),
    );
    const channel = await client.channels.fetch(lastLbMessage.channelId).catch(() => null);
    if (!channel) return;
    const msg = await channel.messages.fetch(lastLbMessage.messageId).catch(() => null);
    if (!msg) { lastLbMessage = null; return; } // message was deleted — reset
    await msg.edit({ files: [attachment], components: [lbRow], embeds: [] });
    console.log('🔄 Leaderboard auto-reloaded');
  } catch (err) {
    console.error('Auto-reload leaderboard error:', err.message);
  }
}

const msgCooldown = new Map(); // `${guildId}:${userId}` -> last award timestamp

// Sync XP to the website's Turso database
const WEBSITE_API = 'https://www.loverscafe.online/api/leaderboard';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // Set in .env — get from admin login

async function syncXpToWebsite(userId, username, displayName, chatXp, voiceXp) {
  if (!ADMIN_TOKEN) return; // Skip sync if no token configured
  try {
    await fetch(WEBSITE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({
        action: 'set-xp',
        discordUserId: userId,
        chat_xp: chatXp,
        voice_xp: voiceXp,
        username: username,
        display_name: displayName,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* fail silently — don't block XP awarding */ }
}

// ---------------------------------------------------------------------------
// Live server settings (fetched from the website, cached ~60s). Lets XP
// amounts / cooldown / role gates be changed in the dashboard WITHOUT a bot
// restart — the cache simply expires and the next award uses new values.
// Falls back to env/const defaults if the fetch fails or a field is missing.
// ---------------------------------------------------------------------------
const SETTINGS_TTL_MS = 60 * 1000;
let cachedXpSettings = null;
let cachedXpAt = 0;

async function getXpSettings() {
  const now = Date.now();
  if (cachedXpSettings && now - cachedXpAt < SETTINGS_TTL_MS) return cachedXpSettings;
  if (!ADMIN_TOKEN) return null;
  try {
    const res = await fetch(WEBSITE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ action: 'bot-settings' }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.xp) {
        cachedXpSettings = data.xp;
        cachedXpAt = now;
      }
    }
  } catch { /* keep stale cache / fall back to defaults */ }
  return cachedXpSettings;
}

/** Effective message cooldown (ms): settings override → env/const default. */
function effectiveMessageCooldownMs() {
  const s = cachedXpSettings;
  const sec = s && Number.isFinite(Number(s.messageCooldown)) ? Number(s.messageCooldown) : null;
  return sec != null ? sec * 1000 : MESSAGE_COOLDOWN_MS;
}

/** Effective per-message XP: settings messageXp → env/const random range. */
function effectiveMessageXp() {
  const s = cachedXpSettings;
  if (s && Number.isFinite(Number(s.messageXp))) return Number(s.messageXp);
  return randomInt(XP_MSG_MIN, XP_MSG_MAX);
}

/** Effective per-voice-minute XP: settings voiceXp → env/const default. */
function effectiveVoiceXp() {
  const s = cachedXpSettings;
  if (s && Number.isFinite(Number(s.voiceXp))) return Number(s.voiceXp);
  return XP_PER_VOICE_MINUTE;
}

/** Whether XP is globally enabled (settings.xp.enabled; default true). */
function xpEnabled() {
  const s = cachedXpSettings;
  return !s || s.enabled !== false;
}

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

  // Sync to website database
  const stats = store.getUser(guild.id, user.id);
  syncXpToWebsite(user.id, user.username, displayName, stats.chatXp, stats.voiceXp);

  const levelBefore = levelForXp(before).level;
  const levelAfter = levelForXp(after).level;
  // Level up announcements disabled
}

function awardMessageXp(message) {
  if (!xpEnabled()) return; // XP globally disabled in dashboard
  if (!canEarnXp(message.member)) return; // role gate
  const key = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  const last = msgCooldown.get(key) || 0;
  if (now - last < effectiveMessageCooldownMs()) return;
  msgCooldown.set(key, now);
  handleXpGain(message.guild, message.member || message.author, effectiveMessageXp(), 'chat');
}

// Award voice XP once per minute to everyone actively sitting in a voice channel.
function tickVoiceXp() {
  if (!xpEnabled()) return; // XP globally disabled in dashboard
  const voiceXp = effectiveVoiceXp();
  for (const [, guild] of client.guilds.cache) {
    for (const [, voiceState] of guild.voiceStates.cache) {
      if (!voiceState.channelId) continue; // not in voice
      if (voiceState.channelId === guild.afkChannelId) continue; // AFK room
      const member = voiceState.member;
      if (!member || member.user.bot) continue;
      if (voiceState.selfDeaf || voiceState.deaf) continue; // deafened = not participating
      if (!canEarnXp(member)) continue; // role gate
      handleXpGain(guild, member, voiceXp, 'voice');
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

  // Auto-reload the leaderboard message every 10 minutes.
  setInterval(autoReloadLeaderboard, LEADERBOARD_AUTO_INTERVAL_MS);

  // Prime + periodically refresh live XP settings from the dashboard so
  // changes take effect without a bot restart (cache TTL is also enforced).
  getXpSettings().catch(() => {});
  setInterval(() => { getXpSettings().catch(() => {}); }, SETTINGS_TTL_MS);

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

// Register commands when the bot is invited to a new server (e.g. Loverswilla).
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

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  // Handle owner-only prefix commands
  if (message.content.startsWith('!')) {
    const args = message.content.slice(1).trim().split(/\s+/);
    const command = args.shift()?.toLowerCase();

    // !testdm <discord_user_id> — Harish-only DM test command
    if (command === 'testdm') {
      // Permission check: only Harish can use this command
      if (message.author.id !== '359747431036092417') {
        return message.reply('⛔ This command is owner-only.');
      }

      const targetUserId = args[0];
      if (!targetUserId) {
        return message.reply('❌ Usage: `!testdm <discord_user_id>`\nExample: `!testdm 359747431036092417`');
      }

      // Validate Discord ID format (snowflake: 17-19 digits)
      if (!/^\d{17,19}$/.test(targetUserId)) {
        return message.reply('❌ Invalid Discord ID. Must be a 17-19 digit numeric snowflake.');
      }

      try {
        // Attempt to fetch the user
        const targetUser = await client.users.fetch(targetUserId).catch(() => null);
        if (!targetUser) {
          return message.reply(`❌ Could not find user with ID \`${targetUserId}\`. They may not share any servers with the bot.`);
        }

        // Attempt to send DM
        await targetUser.send('🧪 Test DM from LoversVilla');
        
        // Success response
        await message.reply(`✅ DM sent successfully to **${targetUser.username}** (\`${targetUserId}\`)`);
        console.log(`🧪 Test DM sent to ${targetUser.username} (${targetUserId}) by ${message.author.username}`);
      } catch (error) {
        // DM failed — generate OTP fallback
        const targetUser = await client.users.fetch(targetUserId).catch(() => null);
        const username = targetUser ? targetUser.username : 'Unknown User';
        const otp = storeOtp(targetUserId, username);
        
        // Log OTP prominently in console
        console.log('');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔐 OTP GENERATED (DM FAILED)');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`👤 Discord User: ${username} (${targetUserId})`);
        console.log(`🔢 OTP: ${otp}`);
        console.log(`⏰ Valid for: 15 minutes`);
        console.log(`📝 User can request this from organizers`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('');
        
        // Build error message
        let errorMsg = '❌ Failed to send DM.';
        
        if (error.code === 50007) {
          errorMsg += ' **Reason:** Cannot send messages to this user (they may have DMs disabled or have blocked the bot).';
        } else if (error.code === 50278) {
          errorMsg += ' **Reason:** Discord spam prevention - the bot must wait before DMing this user. Try again in a few minutes, or have them message the bot first.';
        } else if (error.code === 10013) {
          errorMsg += ' **Reason:** Unknown user.';
        } else if (error.code) {
          errorMsg += ` **Discord Error Code:** ${error.code}`;
        } else {
          errorMsg += ' **Reason:** Unknown error.';
        }
        
        errorMsg += `\n\n✅ **Fallback OTP generated and logged.**\nUser **${username}** can ask organizers for the OTP from the logs.`;

        await message.reply(errorMsg);
        console.error(`🧪 Test DM failed for ${targetUserId}: ${error.message} (code: ${error.code || 'none'})`);
      }
      return;
    }

    // !verifyotp <discord_user_id> <otp> — Harish-only OTP verification test
    if (command === 'verifyotp') {
      // Permission check: only Harish can use this command
      if (message.author.id !== '359747431036092417') {
        return message.reply('⛔ This command is owner-only.');
      }

      const targetUserId = args[0];
      const inputOtp = args[1];
      
      if (!targetUserId || !inputOtp) {
        return message.reply('❌ Usage: `!verifyotp <discord_user_id> <otp>`\nExample: `!verifyotp 847461074348933151 123456`');
      }

      const result = verifyOtp(targetUserId, inputOtp);
      if (result.valid) {
        await message.reply(`✅ OTP verified successfully for user ID \`${targetUserId}\``);
        console.log(`✅ OTP verified for ${targetUserId} by ${message.author.username}`);
      } else {
        await message.reply(`❌ OTP verification failed: ${result.reason}`);
        console.log(`❌ OTP verification failed for ${targetUserId}: ${result.reason}`);
      }
      return;
    }
  }

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

  // Refresh leaderboard button
  if (interaction.isButton() && interaction.customId === 'refresh_leaderboard') {
    await interaction.deferUpdate();
    try {
      const { screenshotLeaderboard } = require('./urlbox-screenshot');
      const imgBuffer = await screenshotLeaderboard(true); // cacheBust=true for refresh
      const { AttachmentBuilder } = require('discord.js');
      const attachment = new AttachmentBuilder(imgBuffer, { name: 'leaderboard.png' });
      const lbRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('refresh_leaderboard')
          .setLabel('🔄 Refresh')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setLabel('View Full Leaderboard')
          .setStyle(ButtonStyle.Link)
          .setURL('https://www.loverscafe.online/leaderboard')
      );
      const updatedMsg = await interaction.editReply({ files: [attachment], components: [lbRow], embeds: [] });
      // Keep the stored reference up to date so auto-reload edits this message.
      if (updatedMsg) lastLbMessage = { channelId: updatedMsg.channelId, messageId: updatedMsg.id };
    } catch (err) {
      console.error('Refresh leaderboard error:', err.message);
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
      await interaction.deferReply();
      try {
        const { screenshotLeaderboard } = require('./urlbox-screenshot');
        const imgBuffer = await screenshotLeaderboard();
        const { AttachmentBuilder } = require('discord.js');
        const attachment = new AttachmentBuilder(imgBuffer, { name: 'leaderboard.png' });
        const lbRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('refresh_leaderboard')
            .setLabel('🔄 Refresh')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setLabel('View Full Leaderboard')
            .setStyle(ButtonStyle.Link)
            .setURL('https://www.loverscafe.online/leaderboard')
        );
        const lbReply = await interaction.editReply({ files: [attachment], components: [lbRow] });
        // Store so the 10-min auto-reload knows which message to edit.
        if (lbReply) lastLbMessage = { channelId: lbReply.channelId, messageId: lbReply.id };
      } catch (lbErr) {
        console.error('Leaderboard error:', lbErr.message);
        await interaction.editReply('Could not generate leaderboard image. Visit https://www.loverscafe.online/leaderboard');
      }
      return;
    }


    if (interaction.commandName === 'pair') {
      return interaction.reply({
        content: '⚠️ Pairing is now managed via the admin website: https://www.loverscafe.online/admin/splitsvilla',
        ephemeral: true,
      });
    }

    if (interaction.commandName === 'unpair') {
      return interaction.reply({
        content: '⚠️ Unpairing is now managed via the admin website: https://www.loverscafe.online/admin/splitsvilla',
        ephemeral: true,
      });
    }

    if (interaction.commandName === 'pairlist') {
      return interaction.reply({
        content: '💞 View all couples on the live leaderboard: https://www.loverscafe.online/leaderboard',
        ephemeral: true,
      });
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

// OTP verification endpoint for Discord ID linking
app.post('/api/discord/verify-otp', express.json(), (req, res) => {
  const { discordUserId, otp } = req.body;
  
  if (!discordUserId || !otp) {
    return res.status(400).json({ 
      success: false, 
      error: 'discordUserId and otp required' 
    });
  }

  // Validate Discord ID format
  if (!/^\d{17,19}$/.test(discordUserId)) {
    return res.status(400).json({ 
      success: false, 
      error: 'Invalid Discord ID format' 
    });
  }

  const result = verifyOtp(discordUserId, otp);
  
  if (result.valid) {
    console.log(`✅ OTP verified via API for Discord ID: ${discordUserId}`);
    return res.json({ 
      success: true, 
      message: 'OTP verified successfully' 
    });
  } else {
    console.log(`❌ OTP verification failed via API for ${discordUserId}: ${result.reason}`);
    return res.status(400).json({ 
      success: false, 
      error: result.reason 
    });
  }
});

// OTP fallback generation endpoint (called when DM fails during registration)
app.post('/api/discord/send-otp-fallback', express.json(), async (req, res) => {
  const { discordUserId, discordUsername } = req.body;
  
  if (!discordUserId) {
    return res.status(400).json({ 
      success: false, 
      error: 'discordUserId required' 
    });
  }

  // Validate Discord ID format
  if (!/^\d{17,19}$/.test(discordUserId)) {
    return res.status(400).json({ 
      success: false, 
      error: 'Invalid Discord ID format' 
    });
  }

  try {
    // Fetch user info for better logs
    const targetUser = await client.users.fetch(discordUserId).catch(() => null);
    const username = discordUsername || targetUser?.username || 'Unknown User';
    
    // Generate and store OTP
    const otp = storeOtp(discordUserId, username);
    
    // Log OTP prominently
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔐 REGISTRATION OTP (DM FAILED - USER NEEDS ORGANIZER HELP)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`👤 Discord User: ${username} (${discordUserId})`);
    console.log(`🔢 OTP: ${otp}`);
    console.log(`⏰ Valid for: 15 minutes`);
    console.log(`📝 User is trying to register - they need this code to continue`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
    
    return res.json({ 
      success: true, 
      otp: otp, // Return OTP so website can log it in admin logs
      message: 'OTP generated and logged for organizers' 
    });
  } catch (error) {
    console.error(`❌ Failed to generate fallback OTP for ${discordUserId}:`, error);
    return res.status(500).json({ 
      success: false, 
      error: 'Failed to generate OTP' 
    });
  }
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
