/**
 * XP store — Turso is the source of truth.
 *
 * There is no local xp-data.json any more. XP is read from and written to the
 * same Turso `xp` table the website's leaderboard reads, so what the bot
 * awards is what loverscafe.online shows.
 *
 * How it works:
 *   - init()        loads every row into an in-memory mirror (one query).
 *   - reads         are served from that mirror, so the public API stays
 *                   synchronous and no call site had to change.
 *   - writes        update the mirror immediately and queue a batched UPSERT,
 *                   flushed ~3s later in a single HTTP request. Writes are
 *                   ABSOLUTE (not increments), so a retry can never double-count.
 *   - refresh()     re-reads periodically so XP changed from the admin
 *                   dashboard (add-xp / set-xp / bonus points) is picked up.
 *                   Users with an unflushed write are skipped so in-flight
 *                   awards aren't clobbered.
 *
 * bonus_xp belongs to the website (admin-awarded). It is read and counted in
 * totals but NEVER written here, so the bot can't wipe it.
 *
 * NOTE: the `xp` table is keyed by discord_user_id alone, so it holds exactly
 * one server's XP. Only MAIN_GUILD_ID is persisted; any other guild the bot is
 * in stays in memory for the process lifetime only.
 */

const turso = require('./turso');

const MAIN_GUILD_ID = (process.env.DISCORD_GUILD_ID || '1289894372887760991').trim();

// `${guildId}:${userId}` -> { chatXp, voiceXp, bonusXp, username, avatar }
const cache = new Map();
// user ids (main guild) with local changes not yet written to Turso
const pending = new Set();

let loaded = false;
let flushTimer = null;
let flushing = null;

const key = (guildId, userId) => `${guildId}:${userId}`;

function blank() {
  return { chatXp: 0, voiceXp: 0, bonusXp: 0, username: null, avatar: null };
}

function entry(guildId, userId) {
  const k = key(guildId, userId);
  let e = cache.get(k);
  if (!e) {
    e = blank();
    cache.set(k, e);
  }
  return e;
}

// ─── Loading ────────────────────────────────────────────────────────────────

/** Load all XP for the main guild from Turso. Safe to call more than once. */
async function init() {
  if (!turso.isConfigured()) {
    console.error('⚠️  TURSO_URL / TURSO_TOKEN are not set — XP cannot be stored. Add them to .env');
    loaded = true;
    return false;
  }
  try {
    const rows = await turso.query(
      'SELECT discord_user_id, username, display_name, avatar, chat_xp, voice_xp, bonus_xp FROM xp',
    );
    for (const r of rows) {
      const id = String(r.discord_user_id);
      if (pending.has(id)) continue; // don't overwrite un-flushed local changes
      cache.set(key(MAIN_GUILD_ID, id), {
        chatXp: Number(r.chat_xp) || 0,
        voiceXp: Number(r.voice_xp) || 0,
        bonusXp: Number(r.bonus_xp) || 0,
        username: r.display_name || r.username || null,
        avatar: r.avatar || null,
      });
    }
    loaded = true;
    console.log(`💾 XP loaded from Turso: ${rows.length} person(s)`);
    return true;
  } catch (err) {
    console.error('⚠️  Could not load XP from Turso:', err.message);
    loaded = true; // don't block the bot; writes will still be attempted
    return false;
  }
}

/** Re-read from Turso so dashboard-side edits show up in the bot. */
async function refresh() {
  if (!turso.isConfigured()) return;
  try {
    const rows = await turso.query(
      'SELECT discord_user_id, username, display_name, avatar, chat_xp, voice_xp, bonus_xp FROM xp',
    );
    for (const r of rows) {
      const id = String(r.discord_user_id);
      if (pending.has(id)) continue;
      const e = entry(MAIN_GUILD_ID, id);
      e.chatXp = Number(r.chat_xp) || 0;
      e.voiceXp = Number(r.voice_xp) || 0;
      e.bonusXp = Number(r.bonus_xp) || 0;
      if (r.display_name || r.username) e.username = r.display_name || r.username;
      if (r.avatar) e.avatar = r.avatar;
    }
  } catch { /* transient — next tick will retry */ }
}

// ─── Writing ────────────────────────────────────────────────────────────────

function scheduleFlush() {
  if (flushTimer || pending.size === 0) return;
  flushTimer = setTimeout(() => { flush(); }, 3000);
}

/**
 * Write every pending user to Turso in one request.
 * Only chat_xp / voice_xp / names are written — bonus_xp is left untouched.
 */
async function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (flushing) return flushing;
  if (pending.size === 0) return;
  if (!turso.isConfigured()) { pending.clear(); return; }

  const ids = [...pending];
  pending.clear();

  const statements = ids.map((id) => {
    const e = cache.get(key(MAIN_GUILD_ID, id)) || blank();
    const name = e.username || '';
    return {
      sql:
        'INSERT INTO xp (discord_user_id, username, display_name, avatar, chat_xp, voice_xp, bonus_xp) ' +
        "VALUES (?, ?, ?, ?, ?, ?, 0) " +
        'ON CONFLICT(discord_user_id) DO UPDATE SET ' +
        '  chat_xp = excluded.chat_xp, ' +
        '  voice_xp = excluded.voice_xp, ' +
        "  username = CASE WHEN excluded.username != '' THEN excluded.username ELSE xp.username END, " +
        "  display_name = CASE WHEN excluded.display_name != '' THEN excluded.display_name ELSE xp.display_name END, " +
        "  avatar = CASE WHEN excluded.avatar != '' THEN excluded.avatar ELSE xp.avatar END, " +
        "  updated_at = datetime('now')",
      args: [id, name, name, e.avatar || '', e.chatXp, e.voiceXp],
    };
  });

  flushing = (async () => {
    const out = await turso.pipeline(statements, 15000);
    if (!out.ok) {
      // Re-queue so the XP isn't lost; the next flush retries it.
      for (const id of ids) pending.add(id);
      console.error(`⚠️  XP write to Turso failed (${ids.length} person(s) re-queued): ${out.error}`);
      scheduleFlush();
    }
  })();

  try {
    await flushing;
  } finally {
    flushing = null;
  }
}

// ─── Public API (unchanged shape, so index.js/api-routes.js keep working) ────

function getUser(guildId, userId) {
  const e = cache.get(key(guildId, userId)) || blank();
  return {
    xp: e.chatXp + e.voiceXp + e.bonusXp,
    chatXp: e.chatXp,
    voiceXp: e.voiceXp,
    bonusXp: e.bonusXp,
    username: e.username,
    avatar: e.avatar,
  };
}

/** kind = 'chat' | 'voice'. Returns { before, after } as TOTAL xp. */
function addXp(guildId, userId, amount, meta = {}, kind = 'chat') {
  const e = entry(guildId, userId);
  const before = e.chatXp + e.voiceXp + e.bonusXp;

  if (kind === 'voice') {
    e.voiceXp = Math.max(0, e.voiceXp + amount);
  } else {
    e.chatXp = Math.max(0, e.chatXp + amount);
  }
  if (meta.username) e.username = meta.username;
  if (meta.avatar) e.avatar = meta.avatar;

  if (guildId === MAIN_GUILD_ID) {
    pending.add(String(userId));
    scheduleFlush();
  }
  return { before, after: e.chatXp + e.voiceXp + e.bonusXp };
}

function resetUser(guildId, userId) {
  const e = entry(guildId, userId);
  e.chatXp = 0;
  e.voiceXp = 0;
  if (guildId === MAIN_GUILD_ID) {
    pending.add(String(userId));
    scheduleFlush();
  }
}

function resetGuild(guildId) {
  for (const [k, e] of cache) {
    if (!k.startsWith(`${guildId}:`)) continue;
    e.chatXp = 0;
    e.voiceXp = 0;
    if (guildId === MAIN_GUILD_ID) pending.add(k.slice(guildId.length + 1));
  }
  if (guildId === MAIN_GUILD_ID) scheduleFlush();
}

function leaderboard(guildId, limit = 10) {
  const prefix = `${guildId}:`;
  const out = [];
  for (const [k, e] of cache) {
    if (!k.startsWith(prefix)) continue;
    out.push({
      userId: k.slice(prefix.length),
      xp: e.chatXp + e.voiceXp + e.bonusXp,
      chatXp: e.chatXp,
      voiceXp: e.voiceXp,
      username: e.username,
      avatar: e.avatar || null,
    });
  }
  out.sort((a, b) => b.xp - a.xp);
  return out.slice(0, limit);
}

function rankOf(guildId, userId) {
  const all = leaderboard(guildId, Number.MAX_SAFE_INTEGER);
  const idx = all.findIndex((e) => e.userId === String(userId));
  return { rank: idx === -1 ? null : idx + 1, total: all.length };
}

function isReady() {
  return loaded;
}

// Persist on shutdown so no XP is lost.
let shuttingDown = false;
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await flush(); } catch { /* best effort */ }
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

module.exports = {
  init,
  refresh,
  isReady,
  getUser,
  addXp,
  resetUser,
  resetGuild,
  leaderboard,
  rankOf,
  flush,
  MAIN_GUILD_ID,
};
