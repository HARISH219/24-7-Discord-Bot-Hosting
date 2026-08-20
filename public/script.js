const boardEl = document.getElementById('board');
const serverSelect = document.getElementById('serverSelect');
const botStatus = document.getElementById('botStatus');
const serverMeta = document.getElementById('serverMeta');
const criteriaEl = document.getElementById('criteria');

let guilds = [];
let selectedGuildId = null;
let criteria = null;

function medal(rank) {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `#${rank}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

const fmt = (n) => (n ?? 0).toLocaleString();

function avatarTag(m) {
  return m.avatar
    ? `<img class="avatar" src="${escapeHtml(m.avatar)}" alt="" />`
    : `<div class="avatar"></div>`;
}

// One partner's detailed block (level, total, chat, voice, contribution).
function memberBlock(m) {
  const pct = Math.max(0, Math.min(100, m.contribution ?? 0));
  return `
    <div class="member">
      ${avatarTag(m)}
      <div class="member-body">
        <div class="member-top">
          <span class="member-name">${escapeHtml(m.username)}</span>
          <span class="member-level">Lv ${m.level}</span>
        </div>
        <div class="member-xp">${fmt(m.xp)} XP • <b>${pct}%</b> of couple</div>
        <div class="chips">
          <span class="chip chat">💬 ${fmt(m.chatXp)}</span>
          <span class="chip voice">🎙️ ${fmt(m.voiceXp)}</span>
        </div>
        <div class="contrib-bar"><i style="width:${pct}%"></i></div>
      </div>
    </div>`;
}

function coupleCard(c) {
  const [m1, m2] = c.members;
  const topClass = c.rank <= 3 ? ` top${c.rank}` : '';
  return `
    <div class="couple${topClass}">
      <div class="couple-head">
        <div class="rank">${medal(c.rank)}</div>
        <div class="couple-title">
          ${escapeHtml(m1.username)} <span class="heart">❤️</span> ${escapeHtml(m2.username)}
        </div>
        <div class="couple-total">${fmt(c.totalXp)}<span>XP</span></div>
      </div>
      <div class="couple-stats">
        <div class="stat"><span>💬 Chat</span><b>${fmt(c.chatXp)}</b></div>
        <div class="stat"><span>🎙️ Voice</span><b>${fmt(c.voiceXp)}</b></div>
        <div class="stat total"><span>⭐ Total</span><b>${fmt(c.totalXp)}</b></div>
      </div>
      <div class="members">
        ${memberBlock(m1)}
        ${memberBlock(m2)}
      </div>
    </div>`;
}

function renderBoard() {
  const guild = guilds.find((g) => g.id === selectedGuildId) || guilds[0];
  if (!guild) {
    boardEl.innerHTML = '<div class="empty">No servers found.</div>';
    serverMeta.textContent = '';
    return;
  }
  serverMeta.textContent = `${guild.name} • ${guild.memberCount?.toLocaleString?.() ?? '—'} members`;
  const couples = guild.couples || [];
  if (!couples.length) {
    boardEl.innerHTML =
      '<div class="empty">No couples yet — pair up with <code>/pair</code> to join the board! 💞</div>';
    return;
  }
  boardEl.innerHTML = couples.map(coupleCard).join('');
}

function renderCriteria() {
  if (!criteria || !criteriaEl) return;
  const chat =
    criteria.chatMin === criteria.chatMax
      ? `${criteria.chatMin} XP`
      : `${criteria.chatMin}–${criteria.chatMax} XP`;
  criteriaEl.innerHTML = `
    <h3>How XP works</h3>
    <p class="crit-note">${
      criteria.requirePair
        ? 'Only <b>paired</b> members earn XP. Both partners’ XP are combined for the ranking.'
        : 'Everyone earns XP.'
    }</p>
    <div class="crit-grid">
      <div class="crit"><div class="crit-ico">💬</div><div><b>Chat</b><span>${chat} per message<br>${criteria.chatCooldownSec}s cooldown</span></div></div>
      <div class="crit"><div class="crit-ico">🎙️</div><div><b>Voice</b><span>${criteria.voicePerMinute} XP per active minute</span></div></div>
      <div class="crit"><div class="crit-ico">❤️</div><div><b>Couple XP</b><span>Partner A + Partner B combined</span></div></div>
    </div>`;
}

async function load() {
  try {
    const res = await fetch('/api/leaderboard');
    const data = await res.json();
    if (!data.success) throw new Error('bad response');

    guilds = data.guilds || [];
    criteria = data.criteria || null;
    botStatus.textContent = data.botUsername ? `${data.botUsername} · online` : 'online';

    const ids = guilds.map((g) => g.id).join(',');
    if (serverSelect.dataset.ids !== ids) {
      serverSelect.dataset.ids = ids;
      serverSelect.innerHTML = guilds
        .map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`)
        .join('');
      if (!selectedGuildId || !guilds.find((g) => g.id === selectedGuildId)) {
        selectedGuildId = guilds[0]?.id ?? null;
      }
      serverSelect.value = selectedGuildId;
    }

    renderBoard();
    renderCriteria();
  } catch (err) {
    botStatus.textContent = 'Connection error';
    boardEl.innerHTML = '<div class="empty">Could not load the leaderboard. Is the bot running?</div>';
  }
}

serverSelect.addEventListener('change', (e) => {
  selectedGuildId = e.target.value;
  renderBoard();
});

load();
setInterval(load, 10000);
