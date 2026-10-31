export const LEVELS = Object.freeze(['A1', 'A2', 'B1', 'B2']);
export const PASS_PERCENTAGE = 90;

export function scorePercentage(correct, total) {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.round((Math.max(0, correct) / total) * 100);
}

// A score of exactly 90 is a pass. Never compare with > 90 or < 100.
export function qualifiesToUnlock(scorePercentageValue) {
  return Number.isFinite(scorePercentageValue) && scorePercentageValue >= PASS_PERCENTAGE;
}

export function nextLevel(level) {
  const index = LEVELS.indexOf(level);
  return index >= 0 && index < LEVELS.length - 1 ? LEVELS[index + 1] : null;
}

export function shouldUnlockLevel(scorePercentageValue, currentLevel, unlockedLevels = []) {
  const next = nextLevel(currentLevel);
  if (!next || !qualifiesToUnlock(scorePercentageValue)) return null;
  return unlockedLevels.includes(next) ? null : next;
}

// Pure state transition used by the app and unit tests. Previously opened
// levels are preserved; a passing final score only appends the next level.
export function unlockedLevelsAfterFinal(scorePercentageValue, currentLevel, unlockedLevels = ['A1']) {
  const current = [...new Set(unlockedLevels)];
  const next = nextLevel(currentLevel);
  if (!next || !qualifiesToUnlock(scorePercentageValue) || current.includes(next)) return current;
  return [...current, next];
}

export function progressKey(wordId, level) {
  return `${wordId}::${level}`;
}

export function shuffle(items, random = Math.random) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
