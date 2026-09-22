/**
 * Minimal Turso HTTP client (no SDK, no native deps).
 *
 * Talks to the SAME database the website reads, so XP written here shows up on
 * loverscafe.online/leaderboard immediately — there is no separate local copy
 * and no API round-trip through the website.
 *
 * Credentials come from the environment only (never hardcoded, because this
 * repo is pushed to GitHub):
 *   TURSO_URL    e.g. https://<db>-<org>.aws-ap-south-1.turso.io
 *   TURSO_TOKEN  a read-write database token
 */

const TURSO_URL = (process.env.TURSO_URL || '').trim().replace(/\/+$/, '');
const TURSO_TOKEN = (process.env.TURSO_TOKEN || '').trim();

function isConfigured() {
  return Boolean(TURSO_URL && TURSO_TOKEN);
}

/** Convert a JS value into Turso's wire format. */
function toArg(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'number') return { type: 'integer', value: String(Math.trunc(v)) };
  return { type: 'text', value: String(v) };
}

function parseResult(result) {
  if (!result || !result.rows) return [];
  const cols = result.cols.map((c) => c.name);
  return result.rows.map((row) => {
    const o = {};
    cols.forEach((c, i) => { o[c] = row[i]?.value ?? null; });
    return o;
  });
}

/**
 * Run one or more statements in a SINGLE HTTP request.
 * @param {Array<{sql: string, args?: unknown[]}>} statements
 * @returns {Promise<{ok: boolean, rows: object[][], error?: string}>}
 */
async function pipeline(statements, timeoutMs = 10000) {
  if (!isConfigured()) {
    return { ok: false, rows: [], error: 'TURSO_URL / TURSO_TOKEN not set' };
  }
  try {
    const res = await fetch(`${TURSO_URL}/v2/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TURSO_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: [
          ...statements.map((s) => ({
            type: 'execute',
            stmt: { sql: s.sql, args: (s.args || []).map(toArg) },
          })),
          { type: 'close' },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) return { ok: false, rows: [], error: `HTTP ${res.status}` };

    const data = await res.json();
    const results = Array.isArray(data.results) ? data.results : [];
    const firstErr = results.find((r) => r?.type === 'error');
    if (firstErr) {
      return { ok: false, rows: [], error: firstErr.error?.message || 'statement failed' };
    }
    return {
      ok: true,
      rows: results.slice(0, statements.length).map((r) => parseResult(r?.response?.result)),
    };
  } catch (err) {
    return { ok: false, rows: [], error: err?.message || String(err) };
  }
}

/** Run a single statement and return its rows. */
async function query(sql, args = []) {
  const out = await pipeline([{ sql, args }]);
  if (!out.ok) {
    const e = new Error(out.error || 'turso query failed');
    e.tursoError = true;
    throw e;
  }
  return out.rows[0] || [];
}

module.exports = { isConfigured, pipeline, query, TURSO_URL };
