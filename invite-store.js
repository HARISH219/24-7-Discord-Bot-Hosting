const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'invite-data.json');

// Shape: { [guildId]: { [userId]: { invites: number, username, avatar } } }
let data = {};
try {
  if (fs.existsSync(DATA_FILE)) {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {};
  }
} catch (err) {
  console.error('⚠️  Could not read invite-data.json, starting fresh:', err.message);
  data = {};
}

function save() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data));
  } catch (err) {
    console.error('⚠️  Could not save invite-data.json:', err.message);
  }
}

function guildBucket(guildId) {
  if (!data[guildId]) data[guildId] = {};
  return data[guildId];
}

function getInvites(guildId, userId) {
  const bucket = data[guildId] || {};
  return bucket[userId]?.invites ?? 0;
}

function setInvites(guildId, userId, count, meta = {}) {
  const bucket = guildBucket(guildId);
  const current = bucket[userId] || {};
  bucket[userId] = {
    invites: count,
    username: meta.username ?? current.username ?? null,
    avatar: meta.avatar ?? current.avatar ?? null,
  };
  save();
}

function addInvite(guildId, userId, meta = {}) {
  const bucket = guildBucket(guildId);
  const current = bucket[userId] || {};
  bucket[userId] = {
    invites: (current.invites ?? 0) + 1,
    username: meta.username ?? current.username ?? null,
    avatar: meta.avatar ?? current.avatar ?? null,
  };
  save();
  return bucket[userId].invites;
}

function getAllInvites(guildId) {
  return data[guildId] || {};
}

process.on('exit', save);

module.exports = { getInvites, setInvites, addInvite, getAllInvites };
