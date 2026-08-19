// MEE6-style leveling curve.
// XP required to advance FROM `level` to `level + 1`.
function xpToNext(level) {
  return 5 * level * level + 50 * level + 100;
}

// Total cumulative XP needed to reach a given level from zero.
function totalXpForLevel(level) {
  let total = 0;
  for (let i = 0; i < level; i++) total += xpToNext(i);
  return total;
}

// Given a total XP amount, resolve the current level and progress within it.
function levelForXp(totalXp) {
  let level = 0;
  let remaining = Math.max(0, Math.floor(totalXp));
  while (remaining >= xpToNext(level)) {
    remaining -= xpToNext(level);
    level++;
  }
  return { level, xpIntoLevel: remaining, xpForNext: xpToNext(level) };
}

module.exports = { xpToNext, totalXpForLevel, levelForXp };
