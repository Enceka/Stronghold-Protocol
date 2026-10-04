// Decision-only forward model. No game rule is duplicated here.
import { AI_ACTIONS, AI_VERSION, AI_WEIGHTS, aiStateKey } from '../../shared/ai.js';
import { PHASE, GEO } from '../../shared/constants.js';
import { DIRS, validateC2S } from '../../shared/protocol.js';
import { createRng, deriveSeed } from '../sim/rng.js';
import { VirtualScheduler } from '../match/scheduler.js';
import { EffectDispatcher } from '../match/effectsMeta.js';
import { botPickBand, botPickCard, botPrepBeginSteps, botPrepEndSteps, shopBuyScores } from '../match/bot.js';

const DECISIONS = new Set([PHASE.INFO_CHECK, PHASE.BAND_DRAFT, PHASE.SP_DRAFT, PHASE.PREP]);
const noLog = { info() {}, debug() {}, warn() {}, error() {} };
const copyJSON = (x) => JSON.parse(JSON.stringify(x));
function cloneGraph(x, seen) {
  if (!x || typeof x !== 'object') return x;
  if (seen.has(x)) return seen.get(x);
  const y = x instanceof Map ? new Map() : x instanceof Set ? new Set() : x instanceof WeakMap ? new WeakMap() : Array.isArray(x) ? [] : Object.create(Object.getPrototypeOf(x));
  seen.set(x, y);
  if (x instanceof Map) for (const [k, v] of x) y.set(cloneGraph(k, seen), cloneGraph(v, seen));
  else if (x instanceof Set) for (const v of x) y.add(cloneGraph(v, seen));
  // Instrumentation (e.g. attachAudit) installs own method wrappers that close over the live seat. A decision fork
  // uses the class's original prototype methods; copying those closures would report simulations as live actions.
  else if (!(x instanceof WeakMap)) for (const [k, v] of Object.entries(x)) if (typeof v !== 'function') y[k] = cloneGraph(v, seen);
  return y;
}

/** Fork only quiescent decision phases. Data/rule registries are read-only; mutable match state is copied. */
export function forkDecision(m, { sampleSeed = null, playerId = null } = {}) {
  if (m.ended || m.disposed || !DECISIONS.has(m.phase)) throw new Error('AI model requires an active decision phase');
  const f = Object.create(Object.getPrototypeOf(m));
  const seen = new Map([[m, f]]);
  for (const x of [m.data, m.gd, m.ds, m.registry]) if (x) seen.set(x, x);
  const skip = new Set(['opts', 'sched', 'sendFn', 'broadcastFn', 'onEndFn', 'log', 'dispatcher', 'fields', 'runner', 'pacer', '_timers', '_unitStatsCache', '_botPath', '_botTraits', '_privDirty', 'aiPolicy', '_aiJobs', '_aiTransposition']);
  for (const [k, v] of Object.entries(m)) {
    if (skip.has(k) || k.startsWith('rng')) continue;
    if (/Timer$/.test(k) || k === '_bossClock') f[k] = null;
    else if (typeof v !== 'function' || k === 'BattleClass') f[k] = cloneGraph(v, seen);
  }
  f.opts = {}; f.log = noLog; f.sendFn = () => true; f.broadcastFn = () => {}; f.onEndFn = () => {};
  f.sched = new VirtualScheduler({ start: m.sched.now(), instantCombat: false });
  f.ownsScheduler = true; f.clientCombat = false; f.verifyMode = 'off';
  f.fields = []; f.runner = null; f.pacer = null; f._timers = new Set(); f._privDirty = new Set();
  f._pubDirty = false; f._prepEndQueued = false; f.aiPolicy = null; f._aiJobs = new Set(); f._aiTransposition = new Map();
  f.botRehearsal = 0; f.botSliceMs = 8; f.headlessSliceMs = 8;
  f.dispatcher = new EffectDispatcher(f, f.registry);
  if (sampleSeed !== null) f.seed = sampleSeed >>> 0;
  for (const name of ['Setup', 'Shop', 'Waves', 'Draft', 'Bots', 'Meta']) {
    f[`rng${name}`] = sampleSeed === null ? m[`rng${name}`].clone() : createRng(deriveSeed(sampleSeed, name.toLowerCase()));
  }
  // Scouted boards are visible; other seats' hands, shops, offers and funds are not. Approximate them, never use
  // the server's hidden information to rank a human's choices. Return hidden pool copies before dropping pieces.
  if (sampleSeed !== null && playerId) for (const p of f.order) if (p.playerId !== playerId) {
    for (const piece of [...p.hand, ...p.temp].filter(Boolean)) if (piece.kind === 'chess') { p.returnCopies(piece); p.removeTokensOf(piece.uid); }
    p.hand.fill(null); p.temp.fill(null); p._tempDue.clear(); p.offers = [];
    p.funds = f.gd.income(f.round); p.pendingFunds = 0;
    p.loadout = Object.freeze({}); p.rollShop(); p.recompute();
  }
  return f;
}

export function observe(m, playerId) {
  const f = forkDecision(m);
  try {
    // A forward model runs battles on the server; the observation must still describe the live transport mode.
    f.clientCombat = m.clientCombat;
    const p = f.players.get(playerId);
    if (!p) throw new Error('unknown AI seat');
    const pub = f.publicView(), priv = p.privateView();
    const teammates = f.order.filter((other) => other.alive && other.playerId !== playerId).map((other) => ({ playerId: other.playerId, ...f.prepFieldMeta(other) }));
    const observation = { version: AI_VERSION, public: pub, self: priv, teammates, map: { field: f.deployFieldOf(p), tiles: [...p.deployMap()], stage: f.stage } };
    return copyJSON({ ...observation, stateKey: aiStateKey(pub, priv), modelKey: aiStateKey({ ...pub, teammates }, priv) });
  } finally { f.dispose(); }
}

export function applyAIAction(m, playerId, action) {
  if (!action || !AI_ACTIONS.includes(action.t) || validateC2S(action)) return { error: 'BAD_MSG', detail: 'invalid AI action' };
  const ps = m.players.get(playerId);
  if (!ps || ps.left) return { error: 'NOT_IN_ROOM' };
  return m._handle(ps, copyJSON(action)) || { ok: true };
}

export function testAction(m, playerId, action) {
  const f = forkDecision(m);
  try { return applyAIAction(f, playerId, action); } finally { f.dispose(); }
}

export function purchaseScores(m, playerId) {
  const f = forkDecision(m);
  try { return shopBuyScores(f, f.players.get(playerId)); } finally { f.dispose(); }
}

/** All ordinary decision intents. Board moves/Arts can be omitted for a small economy/draft candidate set. */
export function legalActions(m, playerId, { placements = true } = {}) {
  const o = observe(m, playerId), p = o.self, pub = o.public;
  const c = [];
  const add = (t, fields = {}) => c.push({ t, ...fields });
  if (pub.phase === PHASE.INFO_CHECK) add('g.infoReady');
  if (pub.phase === PHASE.BAND_DRAFT && m.draftTurn() === playerId) {
    for (const bandId of m.gd.bandIds()) add('g.band', { bandId });
    add('g.bandSkip');
  }
  if (pub.phase === PHASE.SP_DRAFT && pub.sp?.turn === playerId) for (const card of pub.sp.cards) add('g.choice', { idx: card.idx });
  if (pub.phase === PHASE.PREP) {
    add('g.ready', { ready: !p.ready });
    if (!p.ready) {
      add('g.refresh'); add('g.freeze'); add('g.levelUp');
      p.shop.slots.forEach((s, slot) => { if (s && !s.sold) add('g.buy', { slot }); });
      p.shop.rewardOffer?.slots.forEach((s, idx) => { if (!s.sold) add('g.reward', { idx }); });
      const pieces = [...p.board, ...p.hand, ...p.temp].filter(Boolean);
      const chess = pieces.filter((x) => x.kind === 'chess');
      for (const piece of pieces) {
        if (piece.kind === 'chess') add('g.sell', { uid: piece.uid });
        if (piece.kind === 'item') {
          add('g.destroy', { uid: piece.uid });
          for (const target of chess) {
            add('g.equip', { itemUid: piece.uid, targetUid: target.uid });
            for (const item of target.items) add('g.equip', { itemUid: piece.uid, targetUid: target.uid, replaceUid: item.uid });
          }
        }
        if (!placements) continue;
        for (let idx = 0; idx < p.hand.length; idx++) if (p.hand[idx]?.uid !== piece.uid) add('g.move', { uid: piece.uid, to: { area: 'hand', idx } });
        for (let row = GEO.FIELD.r0; row <= GEO.FIELD.r1; row++) for (let col = GEO.FIELD.c0; col <= GEO.FIELD.c1; col++) for (const dir of DIRS) {
          if (piece.kind === 'item') add('g.art', { itemUid: piece.uid, row, col, dir });
          else if (piece.row !== row || piece.col !== col || (piece.dir || 'RIGHT') !== dir) add('g.move', { uid: piece.uid, to: { area: 'board', row, col }, dir });
        }
      }
    }
  }
  return c.filter((action) => !testAction(m, playerId, action).error);
}

const METHODS = {
  buy: (slot) => ({ t: 'g.buy', slot }), refresh: () => ({ t: 'g.refresh' }), freeze: () => ({ t: 'g.freeze' }), levelUp: () => ({ t: 'g.levelUp' }),
  sell: (uid) => ({ t: 'g.sell', uid }), move: (uid, to, dir) => ({ t: 'g.move', uid, to, ...(dir ? { dir } : {}) }),
  equip: (itemUid, targetUid, replaceUid) => ({ t: 'g.equip', itemUid, targetUid, ...(replaceUid ? { replaceUid } : {}) }),
  useArt: (itemUid, row, col, dir) => ({ t: 'g.art', itemUid, row, col, ...(dir ? { dir } : {}) }), destroy: (uid) => ({ t: 'g.destroy', uid }),
  pickReward: (idx) => ({ t: 'g.reward', idx }), setReady: (ready) => ({ t: 'g.ready', ready }),
};

/** The next successful baseline decision, found on a disposable fork; no unseen future shop is returned. */
export function baselineAction(m, playerId) {
  const f = forkDecision(m), p = f.players.get(playerId);
  try {
    if (f.phase === PHASE.INFO_CHECK) return p.infoReady ? null : { t: 'g.infoReady' };
    if (f.phase === PHASE.BAND_DRAFT) {
      if (f.draftTurn() !== playerId) return null;
      let bandId = botPickBand(f, p);
      for (let i = 0; i < 8 && f.bandTaken(bandId, playerId); i++) bandId = botPickBand(f, p);
      if (f.bandTaken(bandId, playerId)) bandId = f.gd.bandIds().find((id) => !f.bandTaken(id, playerId));
      return bandId ? { t: 'g.band', bandId } : null;
    }
    if (f.phase === PHASE.SP_DRAFT) {
      if (f.spTurn() !== playerId) return null;
      const avail = f.sp.cards.map((c) => c.idx).filter((idx) => f.sp.taken[idx] == null);
      return avail.length ? { t: 'g.choice', idx: botPickCard(f, p, f.sp.cards, avail) } : null;
    }
    if (p.ready || !p.alive) return null;
    let first = null;
    for (const [name, build] of Object.entries(METHODS)) {
      const original = p[name];
      p[name] = function (...args) {
        const before = name === 'move' ? JSON.stringify(this.privateView()) : null;
        const result = original.apply(this, args);
        if (!first && !result?.error && (before === null || before !== JSON.stringify(this.privateView()))) first = build(...args);
        return result;
      };
    }
    const begin = botPrepBeginSteps(f, p);
    let r;
    do { r = begin.next(); } while (!r.done && !first);
    if (!first && r.done) {
      // The fork disables expensive layout rehearsal. Resolve temp and Ready using the ordinary bot end.
      const end = botPrepEndSteps(f, p);
      do { r = end.next(); } while (!r.done && !first);
    }
    return first;
  } finally { f.dispose(); }
}

export function scoreState(m, playerId, weights = {}) {
  const p = m.players.get(playerId), w = { ...AI_WEIGHTS, ...weights };
  const victory = !!m.outcome?.victory;
  const rounds = p.eliminatedRound == null ? Math.max(0, m.round - 1) : Math.max(0, p.eliminatedRound - 1);
  const core = p.aiConfig?.coreBondId && p.bonds[p.aiConfig.coreBondId];
  const bossDamage = m.bossPool ? Math.max(0, m.bossPool.maxHp - m.bossPool.hp) : 0;
  const teamLp = m.teamLp == null ? 0 : Math.max(0, m.teamLp);
  return (victory ? w.victory : 0) + (p.alive ? w.survival : 0) + rounds * w.rounds + p.lp * w.lp + teamLp * w.teamLp + bossDamage * w.bossDamage + Object.values(p.layers).reduce((a, b) => a + b, 0) * w.layers + p.funds * w.funds
    + (core ? (core.count || 0) * w.coreMembers + (core.tier || 0) * w.coreTier + (core.layers || 0) * w.coreLayers : 0);
}

/** A single sampled continuation. Each yield is one virtual scheduler callback, allowing live room time slicing. */
export function* rolloutSteps(m, playerId, action, options = {}) {
  const { sampleSeed = 1, rounds = 1, weights = {}, maxSteps = 100000, deadline = Infinity } = options;
  const f = forkDecision(m, { sampleSeed, playerId });
  if (typeof options.continuationPolicy === 'function') f.aiPolicy = options.continuationPolicy;
  const startRound = Math.max(1, f.round);
  try {
    const plan = Array.isArray(action) ? action : [action];
    for (let index = 0; index < plan.length; index++) {
      const applied = applyAIAction(f, playerId, plan[index]);
      if (applied.error) return { ...applied, index, complete: false, score: null, sampleSeed };
    }
    for (const p of f.order) { p.autoplay = true; p.aiConfig = { policy: 'builtin', ...(p.playerId === playerId && p.aiConfig.coreBondId ? { coreBondId: p.aiConfig.coreBondId } : {}) }; p.aiMemory = {}; }
    if (f.phase === PHASE.INFO_CHECK) { for (const p of f.order) p.infoReady = true; f.maybeEndInfo(); }
    else if (f.phase === PHASE.PREP) { for (const p of f.order) if (p.alive && !p.ready) f.kickBot(p); f.maybeEndPrep(); }
    else if (f.phase === PHASE.BAND_DRAFT || f.phase === PHASE.SP_DRAFT) for (const p of f.order) f.kickBot(p);
    let complete = false;
    for (let i = 0; i < maxSteps; i++) {
      if (f.ended || !f.players.get(playerId).alive || (f.phase === PHASE.PREP && f.round > startRound && f.round >= startRound + rounds)) { complete = true; break; }
      if (performance.now() >= deadline || !f.sched.runNext()) break;
      yield;
    }
    const ps = f.players.get(playerId);
    return { complete, score: complete ? scoreState(f, playerId, weights) : null, round: f.round, alive: ps.alive, lp: ps.lp, terminal: f.ended, victory: !!f.outcome?.victory,
      core: ps.aiConfig.coreBondId ? { id: ps.aiConfig.coreBondId, ...ps.bonds[ps.aiConfig.coreBondId] } : null,
      errors: f.errorCount + f.simErrors + f.dispatcher.errors, sampleSeed };
  } finally { f.dispose(); }
}

export function runSteps(gen) { let r; do { r = gen.next(); } while (!r.done); return r.value; }
export const evaluateAction = (m, playerId, action, options) => runSteps(rolloutSteps(m, playerId, action, options));
