const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'xp-data.json');

// Shape: { [guildId]: { [userId]: { chatXp, voiceXp, username, avatar } } }
// Total XP is always derived as chatXp + voiceXp (never stored separately, so it
// can't drift). Legacy records that only have `xp` are migrated on read.
let data = {};
try {
  if (fs.existsSync(DATA_FILE)) {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {};
  }
} catch (err) {
  console.error('⚠️  Could not read xp-data.json, starting fresh:', err.message);
  data = {};
}

// Throttled save so we don't hammer the disk on every message.
let saveTimer = null;
let dirty = false;
function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 4000);
}
function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!dirty) return;
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data));
    dirty = false;
  } catch (err) {
    console.error('⚠️  Could not save xp-data.json:', err.message);
  }
}

function guildBucket(guildId) {
  if (!data[guildId]) data[guildId] = {};
  return data[guildId];
}

// Split a stored record into chat/voice, migrating legacy `xp` -> chatXp.
function split(record) {
  if (!record) return { chatXp: 0, voiceXp: 0 };
  const chatXp = record.chatXp ?? record.xp ?? 0; // legacy total counts as chat
  const voiceXp = record.voiceXp ?? 0;
  return { chatXp, voiceXp };
}

function getUser(guildId, userId) {
  const bucket = data[guildId] || {};
  const record = bucket[userId];
  const { chatXp, voiceXp } = split(record);
  return {
    xp: chatXp + voiceXp,
    chatXp,
    voiceXp,
    username: record?.username ?? null,
    avatar: record?.avatar ?? null,
  };
}

// kind = 'chat' | 'voice'. Returns { before, after } as TOTAL xp (for level-up checks).
function addXp(guildId, userId, amount, meta = {}, kind = 'chat') {
  const bucket = guildBucket(guildId);
  const current = bucket[userId];
  const { chatXp, voiceXp } = split(current);
  const before = chatXp + voiceXp;
  const newChat = kind === 'voice' ? chatXp : chatXp + amount;
  const newVoice = kind === 'voice' ? voiceXp + amount : voiceXp;
  bucket[userId] = {
    chatXp: newChat,
    voiceXp: newVoice,
    username: meta.username ?? current?.username ?? null,
    avatar: meta.avatar ?? current?.avatar ?? null,
  };
  scheduleSave();
  return { before, after: newChat + newVoice };
}

function resetUser(guildId, userId) {
  const bucket = guildBucket(guildId);
  const current = bucket[userId] || {};
  bucket[userId] = {
    chatXp: 0,
    voiceXp: 0,
    username: current.username ?? null,
    avatar: current.avatar ?? null,
  };
  scheduleSave();
}

function resetGuild(guildId) {
  data[guildId] = {};
  scheduleSave();
}

// Individual leaderboard (used by /rank ranking). Entries carry chat/voice too.
function leaderboard(guildId, limit = 10) {
  const bucket = data[guildId] || {};
  return Object.entries(bucket)
    .map(([userId, v]) => {
      const { chatXp, voiceXp } = split(v);
      return {
        userId,
        xp: chatXp + voiceXp,
        chatXp,
        voiceXp,
        username: v.username,
        avatar: v.avatar || null,
      };
    })
    .sort((a, b) => b.xp - a.xp)
    .slice(0, limit);
}

function rankOf(guildId, userId) {
  const bucket = data[guildId] || {};
  const sorted = Object.entries(bucket)
    .map(([id, v]) => {
      const { chatXp, voiceXp } = split(v);
      return { id, xp: chatXp + voiceXp };
    })
    .sort((a, b) => b.xp - a.xp);
  const idx = sorted.findIndex((e) => e.id === userId);
  return { rank: idx === -1 ? null : idx + 1, total: sorted.length };
}

// Persist on shutdown so no XP is lost.
process.on('exit', flush);
process.on('SIGINT', () => {
  flush();
  process.exit(0);
});
process.on('SIGTERM', () => {
  flush();
  process.exit(0);
});

module.exports = { getUser, addXp, resetUser, resetGuild, leaderboard, rankOf, flush };
