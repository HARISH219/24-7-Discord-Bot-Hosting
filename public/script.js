const boardEl = document.getElementById('board');
const serverSelect = document.getElementById('serverSelect');
const botStatus = document.getElementById('botStatus');
const serverMeta = document.getElementById('serverMeta');

let guilds = [];
let selectedGuildId = null;

function medal(rank) {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return rank;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function renderBoard() {
  const guild = guilds.find((g) => g.id === selectedGuildId) || guilds[0];
  if (!guild) {
    boardEl.innerHTML = '<div class="empty">No servers found.</div>';
    serverMeta.textContent = '';
    return;
  }

  serverMeta.textContent = `${guild.name} • ${guild.memberCount?.toLocaleString?.() ?? '—'} members`;

  if (!guild.entries.length) {
    boardEl.innerHTML =
      '<div class="empty">No XP earned yet — start chatting or hop into a voice channel!</div>';
    return;
  }

  boardEl.innerHTML = guild.entries
    .map((e) => {
      const pct = e.xpForNext ? Math.min(100, Math.round((e.xpIntoLevel / e.xpForNext) * 100)) : 0;
      const topClass = e.rank <= 3 ? ` top${e.rank}` : '';
      const avatar = e.avatar
        ? `<img class="avatar" src="${escapeHtml(e.avatar)}" alt="" />`
        : `<div class="avatar"></div>`;
      return `
        <div class="row${topClass}">
          <div class="rank">${medal(e.rank)}</div>
          ${avatar}
          <div class="who">
            <div class="name">${escapeHtml(e.username)}</div>
            <div class="meta">${e.xp.toLocaleString()} XP • ${e.xpIntoLevel}/${e.xpForNext} to next</div>
            <div class="bar"><i style="width:${pct}%"></i></div>
          </div>
          <div class="lvl"><b>${e.level}</b><span>Level</span></div>
        </div>`;
    })
    .join('');
}

async function load() {
  try {
    const res = await fetch('/api/leaderboard');
    const data = await res.json();
    if (!data.success) throw new Error('bad response');

    guilds = data.guilds || [];
    botStatus.textContent = data.botUsername ? `${data.botUsername} · online` : 'online';

    // Populate the server dropdown once (or when the set changes).
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
