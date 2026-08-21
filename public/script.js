// ---------------------------------------------------------------------------
// Lovers Cafe Dashboard — SPA Frontend (Single Server)
// ---------------------------------------------------------------------------

const GUILD_ID = '1289894372887760991';

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const botTag = document.getElementById('botTag');
const menuBtn = document.getElementById('menuBtn');
const sidebar = document.getElementById('sidebar');
const mobileBadge = document.getElementById('mobileBadge');

let currentPage = 'leaderboard';
let refreshTimer = null;

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

const fmt = (n) => (n ?? 0).toLocaleString();

function medal(rank) {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `#${rank}`;
}

function avatarImg(url, size = 44) {
  return url
    ? `<img class="avatar" src="${escapeHtml(url)}" alt="" style="width:${size}px;height:${size}px" />`
    : `<div class="avatar" style="width:${size}px;height:${size}px"></div>`;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchPage(btn.dataset.page));
});

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchPage(btn.dataset.page));
});

menuBtn.addEventListener('click', () => {
  sidebar.classList.toggle('open');
});

function switchPage(page) {
  currentPage = page;
  // Desktop nav
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
  document.querySelector(`.nav-btn[data-page="${page}"]`)?.classList.add('active');
  // Mobile tabs
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
  document.querySelector(`.tab-btn[data-page="${page}"]`)?.classList.add('active');
  // Pages
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  document.getElementById(`page-${page}`)?.classList.add('active');
  sidebar.classList.remove('open');
  loadPageData(page);
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function checkStatus() {
  try {
    const data = await fetchJSON('/api/stats');
    if (!data.success) throw new Error('Bad');
    if (!data.ready) {
      statusDot.classList.remove('online');
      statusText.textContent = 'Starting...';
      botTag.textContent = 'Connecting to Discord...';
      if (mobileBadge) mobileBadge.textContent = '● STARTING';
      return;
    }
    statusDot.classList.add('online');
    statusText.textContent = 'Online';
    botTag.textContent = data.bot.tag || 'Connected';
    if (mobileBadge) { mobileBadge.textContent = '● LIVE'; mobileBadge.classList.add('online'); }
  } catch (err) {
    statusDot.classList.remove('online');
    statusText.textContent = 'Reconnecting...';
    botTag.textContent = 'Waiting for bot...';
    if (mobileBadge) { mobileBadge.textContent = '● OFFLINE'; mobileBadge.classList.remove('online'); }
  }
}

async function loadPageData(page) {
  switch (page) {
    case 'leaderboard': await loadLeaderboard(); break;
    case 'pairs': await loadPairs(); break;
    case 'members': await loadMembers(); break;
  }
}

// ---------------------------------------------------------------------------
// Duo Leaderboard
// ---------------------------------------------------------------------------
async function loadLeaderboard() {
  const el = document.getElementById('leaderboardContent');
  try {
    const data = await fetchJSON('/api/leaderboard');
    if (!data.success) throw new Error('Bad');
    const guild = data.guilds.find((g) => g.id === GUILD_ID);
    if (!guild || !guild.couples.length) {
      el.innerHTML = '<div class="empty">No duos on the board yet. Use <code>/pair</code> to get started! 💞</div>';
      renderCriteria(data.criteria);
      return;
    }
    el.innerHTML = guild.couples.map(duoCard).join('');
    renderCriteria(data.criteria);
  } catch (err) {
    el.innerHTML = '<div class="empty">Could not load leaderboard data.</div>';
  }
}

function memberBlock(m) {
  const pct = Math.max(0, Math.min(100, m.contribution ?? 0));
  return `
    <div class="member">
      ${avatarImg(m.avatar, 44)}
      <div class="member-body">
        <div class="member-top">
          <span class="member-name">${escapeHtml(m.username)}</span>
          <span class="member-level">Lv ${m.level}</span>
        </div>
        <div class="member-xp">${fmt(m.xp)} XP • <b>${pct}%</b></div>
        <div class="chips">
          <span class="chip chat">💬 ${fmt(m.chatXp)}</span>
          <span class="chip voice">🎙️ ${fmt(m.voiceXp)}</span>
          ${m.invites ? `<span class="chip invites">⭐ ${m.invites}</span>` : ''}
        </div>
        <div class="contrib-bar"><i style="width:${pct}%"></i></div>
      </div>
    </div>`;
}

function duoCard(c) {
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

function renderCriteria(criteria) {
  const criteriaEl = document.getElementById('criteria');
  if (!criteria || !criteriaEl) return;
  const chat = criteria.chatMin === criteria.chatMax
    ? `${criteria.chatMin} XP`
    : `${criteria.chatMin}–${criteria.chatMax} XP`;
  criteriaEl.innerHTML = `
    <h3>How XP Works</h3>
    <p class="crit-note">${criteria.requirePair ? 'Only <b>paired</b> duos earn XP. Both partners\' XP are combined for the ranking.' : 'Everyone earns XP.'}</p>
    <div class="crit-grid">
      <div class="crit"><div class="crit-ico">💬</div><div><b>Chat</b><span>${chat} per message<br>${criteria.chatCooldownSec}s cooldown</span></div></div>
      <div class="crit"><div class="crit-ico">🎙️</div><div><b>Voice</b><span>${criteria.voicePerMinute} XP per active minute</span></div></div>
      <div class="crit"><div class="crit-ico">❤️</div><div><b>Duo XP</b><span>Partner A + Partner B combined</span></div></div>
      <div class="crit"><div class="crit-ico">⭐</div><div><b>Invites</b><span>100 XP per invite</span></div></div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Duos (Pairs)
// ---------------------------------------------------------------------------
async function loadPairs() {
  const el = document.getElementById('pairsContent');
  try {
    const data = await fetchJSON(`/api/pairs/${GUILD_ID}`);
    if (!data.success) throw new Error('Bad');
    if (!data.pairs.length) {
      el.innerHTML = '<div class="empty">No duos in this server yet. Use <code>/pair</code> to create some! 💞</div>';
      return;
    }
    el.innerHTML = data.pairs.map((p, i) => `
      <div class="pair-card">
        <div class="pair-rank">${medal(i + 1)}</div>
        <div class="pair-members">
          <div class="pair-member">
            ${avatarImg(p.members[0].avatar, 50)}
            <div>
              <div class="pair-member-name">${escapeHtml(p.members[0].username)}</div>
              <div class="pair-member-xp">Lv ${p.members[0].level} • ${fmt(p.members[0].xp)} XP</div>
            </div>
          </div>
          <span class="pair-heart">❤️</span>
          <div class="pair-member">
            ${avatarImg(p.members[1].avatar, 50)}
            <div>
              <div class="pair-member-name">${escapeHtml(p.members[1].username)}</div>
              <div class="pair-member-xp">Lv ${p.members[1].level} • ${fmt(p.members[1].xp)} XP</div>
            </div>
          </div>
        </div>
        <div class="pair-total">
          <span class="pair-total-val">${fmt(p.totalXp)}</span>
          <span class="pair-total-label">Combined XP</span>
        </div>
      </div>`).join('');
  } catch (err) {
    el.innerHTML = '<div class="empty">Could not load duos data.</div>';
  }
}

// ---------------------------------------------------------------------------
// Members (with invites column)
// ---------------------------------------------------------------------------
async function loadMembers() {
  const el = document.getElementById('membersContent');
  const noteEl = document.getElementById('inviteBonusNote');
  try {
    const data = await fetchJSON(`/api/members/${GUILD_ID}`);
    if (!data.success) throw new Error('Bad');
    if (!data.members.length) {
      el.innerHTML = '<div class="empty">No members with XP yet.</div>';
      if (noteEl) noteEl.innerHTML = '';
      return;
    }

    // Desktop table
    const tableHTML = `
      <table class="members-table desktop-only">
        <thead>
          <tr>
            <th>#</th>
            <th>Member</th>
            <th>Level</th>
            <th>Total XP</th>
            <th>💬 Chat</th>
            <th>🎙️ Voice</th>
            <th>⭐ Invites</th>
            <th>Partner</th>
          </tr>
        </thead>
        <tbody>
          ${data.members.map((m, i) => `
            <tr>
              <td class="rank-cell">${medal(i + 1)}</td>
              <td class="member-cell">
                ${avatarImg(m.avatar, 36)}
                <span>${escapeHtml(m.username)}</span>
              </td>
              <td><span class="level-badge">${m.level}</span></td>
              <td class="xp-cell">${fmt(m.xp)}</td>
              <td class="xp-cell chat-xp">${fmt(m.chatXp)}</td>
              <td class="xp-cell voice-xp">${fmt(m.voiceXp)}</td>
              <td class="xp-cell invite-cell">⭐ ${m.invites ?? 0}</td>
              <td class="partner-cell">${m.partnerId ? '💞 Paired' : '<span class="unpaired">—</span>'}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;

    // Mobile cards
    const cardsHTML = `
      <div class="members-cards mobile-only">
        ${data.members.map((m, i) => `
          <div class="member-card">
            <div class="mc-rank">${medal(i + 1)}</div>
            ${avatarImg(m.avatar, 48)}
            <div class="mc-info">
              <div class="mc-name">${escapeHtml(m.username)}</div>
              <div class="mc-stats">
                <span class="level-badge">Lv ${m.level}</span>
                <span class="mc-xp">${fmt(m.xp)} XP</span>
              </div>
              <div class="mc-breakdown">
                <span class="chip chat">💬 ${fmt(m.chatXp)}</span>
                <span class="chip voice">🎙️ ${fmt(m.voiceXp)}</span>
                <span class="chip invites">⭐ ${m.invites ?? 0}</span>
              </div>
            </div>
          </div>`).join('')}
      </div>`;

    el.innerHTML = tableHTML + cardsHTML;

    if (noteEl) {
      noteEl.innerHTML = `<p class="invite-note">⭐ Invite bonus = <b>${data.inviteBonusXp ?? 100} XP</b> per successful invite</p>`;
    }
  } catch (err) {
    el.innerHTML = '<div class="empty">Could not load member data.</div>';
    if (noteEl) noteEl.innerHTML = '';
  }
}

// ---------------------------------------------------------------------------
// Init & auto-refresh
// ---------------------------------------------------------------------------
async function init() {
  await checkStatus();
  loadPageData(currentPage);
}

init();
refreshTimer = setInterval(() => {
  checkStatus();
  loadPageData(currentPage);
}, 10000);
