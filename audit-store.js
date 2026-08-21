const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'audit-log.json');
const MAX_ENTRIES = 5000; // Keep last 5000 entries in memory/file

// Shape: [ { id, timestamp, actor, actorRole, action, target, details, result } ]
let logs = [];
try {
  if (fs.existsSync(DATA_FILE)) {
    logs = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || [];
  }
} catch (err) {
  console.error('⚠️  Could not read audit-log.json, starting fresh:', err.message);
  logs = [];
}

let saveTimer = null;
let dirty = false;

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 2000);
}

function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!dirty) return;
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(logs));
    dirty = false;
  } catch (err) {
    console.error('⚠️  Could not save audit-log.json:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record an audit log entry.
 * @param {object} entry
 * @param {string} entry.actor - Username or ID of who performed the action
 * @param {string} entry.actorRole - Role of the actor (OWNER, ADMIN, etc.)
 * @param {string} entry.action - Action type (e.g. 'account.create', 'xp.reset', 'pair.create')
 * @param {string} [entry.target] - Who/what was acted upon
 * @param {object} [entry.details] - Additional context (never includes passwords)
 * @param {string} [entry.result] - Outcome (e.g. 'success', 'denied', 'pending')
 */
function record({ actor, actorRole, action, target, details, result }) {
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    timestamp: new Date().toISOString(),
    actor: actor || 'system',
    actorRole: actorRole || 'SYSTEM',
    action,
    target: target || null,
    details: details || null,
    result: result || 'success',
  };
  logs.push(entry);
  // Trim oldest entries if over limit
  if (logs.length > MAX_ENTRIES) {
    logs = logs.slice(logs.length - MAX_ENTRIES);
  }
  scheduleSave();
  return entry;
}

/**
 * Query logs with optional filters.
 * @param {object} [filters]
 * @param {string} [filters.actor]
 * @param {string} [filters.action] - Prefix match (e.g. 'pair' matches 'pair.create', 'pair.remove')
 * @param {string} [filters.target]
 * @param {number} [filters.limit] - Max entries to return (default 100)
 * @param {number} [filters.offset] - Skip entries (for pagination)
 * @returns {object} { entries, total }
 */
function query(filters = {}) {
  let results = logs;

  if (filters.actor) {
    const a = filters.actor.toLowerCase();
    results = results.filter((e) => (e.actor || '').toLowerCase().includes(a));
  }
  if (filters.action) {
    const act = filters.action.toLowerCase();
    results = results.filter((e) => (e.action || '').toLowerCase().startsWith(act));
  }
  if (filters.target) {
    const t = filters.target.toLowerCase();
    results = results.filter((e) => (e.target || '').toLowerCase().includes(t));
  }

  const total = results.length;
  // Return newest first
  results = results.slice().reverse();

  const offset = filters.offset || 0;
  const limit = filters.limit || 100;
  results = results.slice(offset, offset + limit);

  return { entries: results, total };
}

/**
 * Get total log count.
 */
function count() {
  return logs.length;
}

// Persist on shutdown
process.on('exit', flush);
process.on('SIGINT', () => { flush(); process.exit(0); });
process.on('SIGTERM', () => { flush(); process.exit(0); });

module.exports = { record, query, count, flush };
