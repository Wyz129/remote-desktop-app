'use strict';

const PROGRAM_IDS = Object.freeze(['browser', 'transfer', 'activity', 'htop', 'editor', 'image', 'video', 'home', 'settings', 'terminal']);
const programIds = new Set(PROGRAM_IDS);
const actions = new Set(['add', 'remove', 'launch']);
const MAX_LAUNCH_COUNT = 1_000_000;

function normalizeProgramPreferences(input) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const favorites = Array.isArray(value.favorites) ? [...new Set(value.favorites.filter(id => programIds.has(id)))] : [];
  const source = value.usage && typeof value.usage === 'object' && !Array.isArray(value.usage) ? value.usage : {};
  const usage = {};
  for (const id of PROGRAM_IDS) {
    const count = Object.hasOwn(source, id) ? source[id] : undefined;
    if (Number.isSafeInteger(count) && count > 0) usage[id] = Math.min(count, MAX_LAUNCH_COUNT);
  }
  return { favorites, usage };
}

function updateProgramPreferences(current, action, id) {
  if (!actions.has(action)) throw new Error('程序偏好操作无效。');
  if (!programIds.has(id)) throw new Error('程序标识无效。');
  const next = normalizeProgramPreferences(current);
  if (action === 'add' && !next.favorites.includes(id)) next.favorites.push(id);
  else if (action === 'remove') next.favorites = next.favorites.filter(item => item !== id);
  else if (action === 'launch') next.usage[id] = Math.min((next.usage[id] || 0) + 1, MAX_LAUNCH_COUNT);
  return next;
}

module.exports = { PROGRAM_IDS, MAX_LAUNCH_COUNT, normalizeProgramPreferences, updateProgramPreferences };
