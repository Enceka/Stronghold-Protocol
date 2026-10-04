// Versioned, JSON-only AI configuration; also used by the browser before submitting.
export const AI_VERSION = 1;
export const AI_DEFAULT = Object.freeze({ policy: 'builtin' });
export const AI_WEIGHTS = Object.freeze({ victory: 100000, survival: 10000, rounds: 1000, lp: 10, layers: 0.1, funds: 1, bossDamage: 0.25, coreMembers: 30, coreTier: 80, coreLayers: 0.5 });
const plain = (x) => !!x && Object.getPrototypeOf(x) === Object.prototype;
const ids = (x) => Array.isArray(x) && x.length <= 32 && x.every((s) => typeof s === 'string' && /^[\w.:-]{1,64}$/.test(s));

export function checkAIConfig(c) {
  if (!plain(c) || Object.keys(c).some((k) => !['policy', 'coreBondId', 'autoCore', 'preferredBands', 'preferredChess', 'weights', 'search'].includes(k))) return false;
  if (!['builtin', 'preferences', 'search', 'global'].includes(c.policy)) return false;
  if (c.coreBondId !== undefined && !ids([c.coreBondId])) return false;
  if (c.autoCore !== undefined && typeof c.autoCore !== 'boolean') return false;
  for (const k of ['preferredBands', 'preferredChess']) if (c[k] !== undefined && !ids(c[k])) return false;
  if (c.weights !== undefined && (!plain(c.weights) || Object.entries(c.weights).some(([k, v]) => !Object.hasOwn(AI_WEIGHTS, k) || !Number.isFinite(v) || v < 0 || v > 1e6))) return false;
  const limits = { candidates: [1, 16], samples: [1, 64], rounds: [1, 32], budgetMs: [10, 10000], lookahead: [0, 2], risk: [0, 100], maxActions: [1, 16] };
  if (c.search !== undefined && (!plain(c.search) || Object.entries(c.search).some(([k, v]) => !limits[k] || !Number.isInteger(v) || v < limits[k][0] || v > limits[k][1]))) return false;
  return true;
}

export const AI_ACTIONS = Object.freeze(['g.infoReady', 'g.band', 'g.bandSkip', 'g.choice', 'g.reward', 'g.buy', 'g.refresh', 'g.freeze', 'g.levelUp', 'g.sell', 'g.move', 'g.equip', 'g.art', 'g.destroy', 'g.ready']);

/** Same key on server and browser; ignores transport timestamps, includes every decision-visible change. */
export function aiStateKey(pub, priv) {
  const { t, rid, serverNow, deadline, ...p } = pub || {};
  const { t: privateType, rid: privateRid, ...self } = priv || {};
  void t; void rid; void serverNow; void deadline; void privateType; void privateRid;
  const text = JSON.stringify([p, self]);
  let a = 2166136261, b = 0x85ebca6b;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b ^ text.charCodeAt(i), 2246822519); }
  return `${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}`;
}
