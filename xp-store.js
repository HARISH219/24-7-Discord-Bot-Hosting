const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'xp-data.json');

// Shape: { [guildId]: { [userId]: { xp, username, avatar } } }
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

function getUser(guildId, userId) {
  const bucket = data[guildId] || {};
  return bucket[userId] || { xp: 0, username: null, avatar: null };
}

function addXp(guildId, userId, amount, meta = {}) {
  const bucket = guildBucket(guildId);
  const current = bucket[userId] || { xp: 0 };
  const before = current.xp || 0;
  const after = before + amount;
  bucket[userId] = {
    xp: after,
    username: meta.username ?? current.username ?? null,
    avatar: meta.avatar ?? current.avatar ?? null,
  };
  scheduleSave();
  return { before, after };
}

function setXp(guildId, userId, value) {
  const bucket = guildBucket(guildId);
  const current = bucket[userId] || {};
  bucket[userId] = { ...current, xp: Math.max(0, Math.floor(value)) };
  scheduleSave();
}

function resetUser(guildId, userId) {
  setXp(guildId, userId, 0);
}

function resetGuild(guildId) {
  data[guildId] = {};
  scheduleSave();
}

function leaderboard(guildId, limit = 10) {
  const bucket = data[guildId] || {};
  return Object.entries(bucket)
    .map(([userId, v]) => ({ userId, xp: v.xp || 0, username: v.username, avatar: v.avatar || null }))
    .sort((a, b) => b.xp - a.xp)
    .slice(0, limit);
}

function rankOf(guildId, userId) {
  const bucket = data[guildId] || {};
  const sorted = Object.entries(bucket)
    .map(([id, v]) => ({ id, xp: v.xp || 0 }))
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

module.exports = { getUser, addXp, setXp, resetUser, resetGuild, leaderboard, rankOf, flush };
