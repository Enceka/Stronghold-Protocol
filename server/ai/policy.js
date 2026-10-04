import { AI_DEFAULT, AI_WEIGHTS, checkAIConfig } from '../../shared/ai.js';
import { PHASE } from '../../shared/constants.js';
import { deriveSeed } from '../sim/rng.js';
import { observe, baselineAction, legalActions, testAction, rolloutSteps, evaluateAction } from './model.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
function freeze(x) { if (x && typeof x === 'object') { Object.freeze(x); for (const v of Object.values(x)) freeze(v); } return x; }
export function policyFailure(m, ps, detail) {
  ps.aiFailures = (ps.aiFailures || 0) + 1;
  m.log.warn?.(`[match ${m.roomCode}] AI ${ps.playerId}: ${detail}; using builtin`);
}

/** A seat's own configurable policy; local modules may return an intent, {action, reason}, null or a generator. */
export function* decideSteps(m, ps, { advice = false } = {}) {
  const observation = freeze(observe(m, ps.playerId));
  const config = freeze(clone(checkAIConfig(ps.aiConfig) ? ps.aiConfig : AI_DEFAULT));
  const memory = advice ? clone(ps.aiMemory || {}) : (ps.aiMemory ||= {});
  let base;
  const baseline = () => { if (base === undefined) base = baselineAction(m, ps.playerId); return base ? clone(base) : null; };
  const context = Object.freeze({
    observation, config, memory,
    baseline,
    actions: (options) => legalActions(m, ps.playerId, options),
    test: (action) => testAction(m, ps.playerId, action),
    record: (kind, id) => { const value = m.data[kind]?.[id]; return value ? clone(value) : null; },
    evaluate: (action, options) => evaluateAction(m, ps.playerId, action, options),
    evaluateSteps: (action, options) => rolloutSteps(m, ps.playerId, action, options),
  });
  try {
    let result;
    if (typeof m.aiPolicy === 'function') {
      result = m.aiPolicy(context);
      if (result && typeof result.next === 'function') {
        const gen = result, deadline = performance.now() + (config.search?.budgetMs || 2000);
        let done = false;
        try {
          for (let steps = 0; ; steps++) {
            if (steps >= 100000 || performance.now() >= deadline) throw new Error('custom generator exceeded decision budget');
            const r = gen.next();
            if (r.done) { done = true; result = r.value; break; }
            yield;
          }
        } finally { if (!done) gen.return(); }
      }
      if (result && typeof result.then === 'function') throw new Error('use a synchronous function or generator, not a Promise');
      if (result == null) return { action: advice ? baseline() : null, reason: '自定义策略委托内置 AI', policy: 'custom' };
      result = result.t ? { action: result, reason: '自定义 AI 推荐' } : result;
    } else {
      const preferred = preferenceAction(context);
      if (preferred) result = { action: preferred, reason: '按你的策略与干员偏好选择', policy: config.policy };
      else if (config.policy === 'search') {
        const key = `${observation.public.phase}:${observation.public.round}`;
        if (!advice && memory.searchTurn === key) return { action: null, reason: '本阶段搜索完成，委托内置 AI', policy: 'search' };
        result = yield* searchSteps(context);
        if (!advice) memory.searchTurn = key;
      } else result = { action: advice ? baseline() : null, reason: '内置 AI 根据经济、羁绊、敌人路线与阵容选择', policy: config.policy };
    }
    if (observe(m, ps.playerId).modelKey !== observation.modelKey) return { action: null, reason: '状态已变化，委托内置 AI', policy: config.policy };
    if (result?.action && testAction(m, ps.playerId, result.action).error) throw new Error('policy returned an illegal action');
    if (!result || !('action' in result)) throw new Error('policy must return an intent, {action}, or null');
    if (!advice && result.search) {
      const stats = ps.aiSearchStats ||= { decisions: 0, samples: 0, evaluated: 0, truncated: 0 };
      stats.decisions++; stats.samples += result.search.samples; stats.evaluated += result.search.evaluated;
      if (result.search.truncated) stats.truncated++;
    }
    return { ...result, policy: result.policy || (m.aiPolicy ? 'custom' : config.policy) };
  } catch (e) {
    policyFailure(m, ps, e.message || String(e));
    return { action: advice ? baseline() : null, reason: '策略无法完成，使用内置 AI', policy: 'builtin', fallback: true };
  }
}

function preferenceAction(ctx) {
  const { config, observation: o } = ctx;
  if (config.policy === 'builtin') return null;
  if (o.public.phase === PHASE.BAND_DRAFT && config.preferredBands?.length) {
    const available = ctx.actions({ placements: false });
    for (const bandId of config.preferredBands) { const a = available.find((x) => x.t === 'g.band' && x.bandId === bandId); if (a) return a; }
  }
  if (o.public.phase === PHASE.PREP && config.preferredChess?.length) {
    const available = ctx.actions({ placements: false });
    for (const id of config.preferredChess) {
      const a = available.find((x) => x.t === 'g.buy' && o.self.shop.slots[x.slot]?.id === id);
      if (a) return a;
    }
  }
  return null;
}

/** Finite-budget Monte Carlo policy improvement with common random samples and baseline continuation. */
export function* searchSteps(ctx) {
  const o = ctx.observation, base = ctx.baseline();
  if (!base) return { action: null, policy: 'search', reason: '当前无需决策' };
  const { candidates = 3, samples = 2, rounds = 1, budgetMs = 200 } = ctx.config.search || {};
  const deadline = performance.now() + budgetMs;
  const rank = (a) => {
    if (a.t === 'g.band') { const b = ctx.record('bands', a.bandId); return b?.totalHp || 0; }
    if (a.t === 'g.buy') { const s = o.self.shop.slots[a.slot]; return s?.kind === 'chess' ? 10 + (ctx.record('chess', s.id)?.tier || 1) : 5; }
    return { 'g.reward': 50, 'g.choice': 20, 'g.levelUp': 9, 'g.refresh': 1 }[a.t] || 0;
  };
  const options = [base, ...ctx.actions({ placements: false }).filter((a) => ['g.band', 'g.choice', 'g.reward', 'g.buy', 'g.levelUp', 'g.refresh'].includes(a.t)).sort((a, b) => rank(b) - rank(a))];
  const seen = new Set(), actions = options.filter((a) => { const k = JSON.stringify(a); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, candidates);
  const sums = actions.map(() => 0);
  let completed = 0, evaluated = 0, truncated = false;
  for (let sample = 0; sample < samples; sample++) {
    const scores = [];
    // The observation hash, not the actual match seed/RNG state, determines the planning samples.
    const sampleSeed = deriveSeed(1, `ai:${o.stateKey}:${sample}`);
    for (const action of actions) {
      if (performance.now() >= deadline) { truncated = true; break; }
      const r = yield* ctx.evaluateSteps(action, { sampleSeed, rounds, weights: ctx.config.weights || AI_WEIGHTS, deadline });
      evaluated++;
      if (!r.complete || r.errors || !Number.isFinite(r.score)) { truncated = true; break; }
      scores.push(r.score);
    }
    // A partial sample cannot compare choices fairly. Only complete batches affect the ranking.
    if (scores.length !== actions.length) break;
    scores.forEach((s, i) => { sums[i] += s; }); completed++;
  }
  let best = 0;
  for (let i = 1; i < sums.length; i++) if (sums[i] > sums[best]) best = i;
  return {
    action: actions[best], policy: 'search',
    reason: completed ? `随机推演 ${completed} 组共同样本，比较 ${actions.length} 个选择${truncated ? '；已到计算预算' : ''}` : '计算预算内未完成比较，采用内置 AI 建议',
    search: { samples: completed, evaluated, candidates: actions.length, truncated, ranking: completed ? actions.map((action, i) => ({ action, score: sums[i] / completed })) : [] },
  };
}
