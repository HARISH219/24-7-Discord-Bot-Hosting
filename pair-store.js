const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'pair-data.json');

// Shape: { [guildId]: { [userId]: partnerId } } — stored both ways so either
// partner resolves the pairing, which also enforces "one partner per user".
let data = {};
try {
  if (fs.existsSync(DATA_FILE)) {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {};
  }
} catch (err) {
  console.error('⚠️  Could not read pair-data.json, starting fresh:', err.message);
  data = {};
}

function save() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data));
  } catch (err) {
    console.error('⚠️  Could not save pair-data.json:', err.message);
  }
}

function guildBucket(guildId) {
  if (!data[guildId]) data[guildId] = {};
  return data[guildId];
}

// Current partner id for a user, or null if unpaired.
function getPartner(guildId, userId) {
  const bucket = data[guildId] || {};
  return bucket[userId] || null;
}

// Pair two users. Returns false if either is already paired.
function pair(guildId, a, b) {
  const bucket = guildBucket(guildId);
  if (bucket[a] || bucket[b]) return false;
  bucket[a] = b;
  bucket[b] = a;
  save();
  return true;
}

// Remove the pairing that includes userId. Returns the former partner id, or null.
function unpair(guildId, userId) {
  const bucket = data[guildId];
  if (!bucket || !bucket[userId]) return null;
  const partner = bucket[userId];
  delete bucket[userId];
  delete bucket[partner];
  save();
  return partner;
}

// Unique pairs as [a, b] tuples.
function listPairs(guildId) {
  const bucket = data[guildId] || {};
  const seen = new Set();
  const pairs = [];
  for (const [userId, partnerId] of Object.entries(bucket)) {
    if (seen.has(userId)) continue;
    seen.add(userId);
    seen.add(partnerId);
    pairs.push([userId, partnerId]);
  }
  return pairs;
}

process.on('exit', save);

module.exports = { getPartner, pair, unpair, listPairs };
