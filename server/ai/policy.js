import { AI_DEFAULT, AI_WEIGHTS, checkAIConfig } from '../../shared/ai.js';
import { PHASE } from '../../shared/constants.js';
import { deriveSeed } from '../sim/rng.js';
import { observe, baselineAction, legalActions, testAction, rolloutSteps, purchaseScores, runSteps } from './model.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
function freeze(x) { if (x && typeof x === 'object') { Object.freeze(x); for (const v of Object.values(x)) freeze(v); } return x; }
export function policyFailure(m, ps, detail) {
  ps.aiFailures = (ps.aiFailures || 0) + 1;
  m.log.warn?.(`[match ${m.roomCode}] AI ${ps.playerId}: ${detail}; using builtin`);
}

/** Choose an available core for autonomous global planning; explicit coreBondId always wins. */
function autoCoreBond(m, ps) {
  let best = null, bestScore = -Infinity;
  for (const id of m.gd.bondIds) {
    const bond = m.gd.bond(id);
    if (!bond?.isCore || m.gd.modeInactiveBonds.has(id) || m.disabledBonds.includes(id) || !m.bondInPool(id)) continue;
    let supply = 0, reachable = 0, owned = ps.bonds?.[id]?.count || 0;
    for (const [cid, e] of m.pool.entries) {
      if (!(e.left > 0)) continue;
      const c = m.gd.chess(cid);
      if (!c?.bonds?.includes(id)) continue;
      supply += e.left * (c.tier <= ps.shop.level + 1 ? 1 : 0.2);
      if (c.tier <= ps.shop.level + 1) reachable++;
    }
    const threshold = Array.isArray(bond.thresholds) ? bond.thresholds[0] || 3 : 3;
    const score = owned * 40 + reachable * 12 + supply * 0.08 - Math.max(0, threshold - owned) * 2;
    if (score > bestScore) { bestScore = score; best = id; }
  }
  return best;
}

/** A seat's own configurable policy; local modules may return an intent, {action, reason}, null or a generator. */
export function* decideSteps(m, ps, { advice = false } = {}) {
  const observation = freeze(observe(m, ps.playerId));
  const rawConfig = clone(checkAIConfig(ps.aiConfig) ? ps.aiConfig : AI_DEFAULT);
  if (rawConfig.policy === 'global' && rawConfig.autoCore && !rawConfig.coreBondId && observation.public.phase === PHASE.PREP) {
    const picked = autoCoreBond(m, ps);
    if (picked) {
      rawConfig.coreBondId = picked;
      if (!advice) ps.aiConfig = { ...ps.aiConfig, coreBondId: picked };
    }
  }
  const config = freeze(rawConfig);
  const memory = advice ? clone(ps.aiMemory || {}) : (ps.aiMemory ||= {});
  let base;
  const baseline = () => { if (base === undefined) base = baselineAction(m, ps.playerId); return base ? clone(base) : null; };
  const cacheStats = { hits: 0, misses: 0 };
  const cacheKey = (action, options = {}) => {
    let body;
    try { body = JSON.stringify([observation.modelKey, action, options.sampleSeed ?? null, options.rounds ?? 1, options.maxSteps ?? 100000, options.weights || AI_WEIGHTS, options.continuationKey || null]); }
    catch { return null; }
    return body;
  };
  function* cachedEvaluateSteps(action, options = {}) {
    const key = cacheKey(action, options);
    const cache = m._aiTransposition;
    if (key && cache?.has(key)) { cacheStats.hits++; return clone(cache.get(key)); }
    cacheStats.misses++;
    const result = yield* rolloutSteps(m, ps.playerId, action, options);
    if (key && cache && result && result.complete && !result.errors) {
      if (cache.size >= 4096) cache.delete(cache.keys().next().value);
      cache.set(key, clone(result));
    }
    return result;
  }
  const context = Object.freeze({
    observation, config, memory,
    baseline,
    purchaseScores: () => purchaseScores(m, ps.playerId),
    actions: (options) => legalActions(m, ps.playerId, options),
    test: (action) => testAction(m, ps.playerId, action),
    record: (kind, id) => { const value = m.data[kind]?.[id]; return value ? clone(value) : null; },
    evaluate: (action, options) => runSteps(cachedEvaluateSteps(action, options)),
    evaluateSteps: (action, options) => cachedEvaluateSteps(action, options),
    cacheStats,
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
      const coreShopping = config.coreBondId && observation.public.phase === PHASE.PREP;
      const preferred = coreShopping ? null : preferenceAction(context);
      if (preferred) result = { action: preferred, reason: '按你的策略与干员偏好选择', policy: config.policy };
      else if (config.policy === 'search' || config.policy === 'global' || (coreShopping && advice)) {
        const key = `${observation.public.phase}:${observation.public.round}`;
        const maxActions = config.policy === 'global' ? (config.search?.maxActions || 8) : 1;
        if (!advice && config.policy === 'global' && memory.globalActionsKey === key && (memory.globalActions || 0) >= maxActions) {
          return { action: null, reason: `本休整期已完成 ${maxActions} 次全局规划，交回内置 AI`, policy: 'global' };
        }
        if (!advice && config.policy !== 'global' && memory.searchTurn === key) return { action: null, reason: '本阶段搜索完成，委托内置 AI', policy: 'search' };
        result = yield* searchSteps(context);
        if (!advice && config.policy !== 'global') memory.searchTurn = key;
        if (!advice && config.policy === 'global' && result?.action) {
          if (memory.globalActionsKey !== key) { memory.globalActionsKey = key; memory.globalActions = 0; }
          memory.globalActions++;
        }
      } else result = { action: advice ? baseline() : null, reason: '内置 AI 根据经济、羁绊、敌人路线与阵容选择', policy: config.policy };
    }
    if (observe(m, ps.playerId).modelKey !== observation.modelKey) return { action: null, reason: '状态已变化，委托内置 AI', policy: config.policy };
    if (result?.action && testAction(m, ps.playerId, result.action).error) throw new Error('policy returned an illegal action');
    if (!result || !('action' in result)) throw new Error('policy must return an intent, {action}, or null');
    if (result.search) {
      result.search.cacheHits = cacheStats.hits;
      result.search.cacheMisses = cacheStats.misses;
      result.search.transpositionSize = m._aiTransposition?.size || 0;
    }
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

/**
 * One-step decision-tree continuation for global planning. The root action is still evaluated to the terminal horizon,
 * but at the next decision of the controlled seat this policy compares a few legal choices before handing later work
 * back to baseline. Other seats deliberately delegate immediately; the observation remains partial-information safe.
 */
function globalContinuation({ playerId, sampleSeed, deadline, depth = 1, key = 'global-l1' }) {
  const seen = new Set();
  return (ctx) => {
    if (ctx.observation.self.playerId !== playerId) return null;
    const node = `${ctx.observation.public.phase}:${ctx.observation.public.round}`;
    if (seen.has(node) || performance.now() >= deadline) return null;
    seen.add(node);
    const base = ctx.baseline();
    const actions = [base, ...ctx.actions({ placements: false })]
      .filter(Boolean)
      .filter((a, i, all) => all.findIndex((b) => JSON.stringify(a) === JSON.stringify(b)) === i)
      .slice(0, 4);
    let best = base, bestScore = -Infinity;
    for (const candidate of actions) {
      if (performance.now() >= deadline) break;
      const result = ctx.evaluate(candidate, {
        sampleSeed,
        rounds: 1,
        deadline,
        continuationKey: `${key}:${node}:${JSON.stringify(candidate)}`,
        continuationPolicy: depth > 1 ? globalContinuation({ playerId, sampleSeed, deadline, depth: depth - 1, key: `${key}-d${depth - 1}` }) : null,
      });
      if (result?.complete && Number.isFinite(result.score) && result.score > bestScore) { best = candidate; bestScore = result.score; }
    }
    return best;
  };
}

/** Finite-budget Monte Carlo policy improvement with common random samples and baseline continuation. */
export function* searchSteps(ctx) {
  const o = ctx.observation, base = ctx.baseline(), coreBondId = ctx.config.coreBondId;
  if (!base) return { action: null, policy: 'search', reason: '当前无需决策' };
  const shopping = !!coreBondId && o.public.phase === PHASE.PREP && !o.self.shop.rewardOffer;
  const coreName = coreBondId ? ctx.record('bonds', coreBondId)?.name || coreBondId : '';
  const global = ctx.config.policy === 'global';
  const { candidates = global ? 8 : (shopping ? 4 : 3), samples = global ? 32 : (shopping ? 8 : 2), rounds = global ? 32 : 1, budgetMs = global ? 10000 : (shopping ? 5000 : 200), lookahead = global ? 1 : 0, risk = global ? 0 : 0 } = ctx.config.search || {};
  const deadline = performance.now() + budgetMs;
  const bossApproach = global && (o.public.round >= (o.public.bossRound || 1) - 1 || o.public.phase === 'FINAL_ASSAULT' || o.public.phase === 'HIDDEN_CORE');
  const planningWeights = { ...(ctx.config.weights || AI_WEIGHTS), ...(bossApproach ? { bossDamage: Math.max(1, Number(ctx.config.weights?.bossDamage) || 0) } : {}) };
  const available = ctx.actions({ placements: false });
  const values = shopping ? new Map(ctx.purchaseScores().map((x) => [x.slot, x.value])) : null;
  const rank = (a) => {
    if (shopping && a.t === 'g.buy') return values.get(a.slot) ?? -1e9;
    if (a.t === 'g.band') { const b = ctx.record('bands', a.bandId); return (b?.totalHp || 0) + (coreBondId && b?.bondIds?.includes(coreBondId) ? 30 : 0); }
    if (a.t === 'g.buy') { const s = o.self.shop.slots[a.slot]; return s?.kind === 'chess' ? 10 + (ctx.record('chess', s.id)?.tier || 1) : 5; }
    return { 'g.reward': 50, 'g.choice': 20, 'g.levelUp': 9, 'g.refresh': 1 }[a.t] || 0;
  };
  const options = shopping
    ? available.filter((a) => a.t === 'g.buy' && rank(a) >= 3).sort((a, b) => rank(b) - rank(a))
    : [base, ...available.filter((a) => ['g.band', 'g.choice', 'g.reward', 'g.buy', 'g.levelUp', 'g.refresh'].includes(a.t)).sort((a, b) => rank(b) - rank(a))];
  const seen = new Set(), actions = options.filter((a) => { const k = JSON.stringify(a); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, candidates);
  if (!actions.length) return { action: base, policy: 'search', coreBondId, shopRecommendations: [], reason: `围绕【${coreName}】，本店暂无值得购买的卡片；按阵容需要继续整备` };
  const outcomes = actions.map(() => []);
  let completed = 0, evaluated = 0, truncated = false;
  for (let sample = 0; sample < samples; sample++) {
    const batch = [];
    const sampleSeed = deriveSeed(1, `ai:${o.stateKey}:${sample}`);
    for (const action of actions) {
      if (performance.now() >= deadline) { truncated = true; break; }
      const r = yield* ctx.evaluateSteps(action, {
        sampleSeed, rounds, weights: planningWeights, deadline,
        continuationPolicy: global && lookahead > 0 ? globalContinuation({ playerId: o.self.playerId, sampleSeed, deadline, depth: lookahead }) : null,
        continuationKey: global ? `global-l${lookahead}` : null,
      });
      evaluated++;
      if (!r.complete || r.errors || !Number.isFinite(r.score)) { truncated = true; break; }
      batch.push(r);
    }
    // Only a complete common-sample batch contributes to any candidate's statistics.
    if (batch.length !== actions.length) break;
    batch.forEach((r, i) => outcomes[i].push(r)); completed++;
  }
  const ranking = completed ? actions.map((action, i) => {
    const rows = outcomes[i], score = rows.reduce((s, r) => s + r.score, 0) / completed;
    const ordered = rows.map((r) => r.score).sort((a, b) => a - b);
    const tailN = Math.max(1, Math.ceil(completed * Math.max(0.1, risk / 100)));
    const cvar = ordered.slice(0, tailN).reduce((s, x) => s + x, 0) / tailN;
    const deviation = completed > 1 ? Math.sqrt(rows.reduce((s, r) => s + (r.score - score) ** 2, 0) / (completed - 1)) : 0;
    const alive = rows.filter((r) => r.alive).length;
    const riskAdjustedScore = risk > 0 ? cvar : score;
    return { action, score, riskAdjustedScore, cvar, riskPercent: risk, deviation, alive, survivalRate: alive / completed, meanLp: rows.reduce((s, r) => s + r.lp, 0) / completed,
      terminal: rows.every((r) => r.terminal), winRate: rows.filter((r) => r.victory).length / completed };
  }) : [];
  const sufficient = completed >= (shopping ? 2 : 1);
  let best = 0;
  if (sufficient) for (let i = 1; i < ranking.length; i++) if (ranking[i].riskAdjustedScore > ranking[best].riskAdjustedScore) best = i;
  const shopRecommendations = shopping ? actions.map((a, i) => {
    const slot = o.self.shop.slots[a.slot];
    const fit = slot.kind === 'chess' ? ctx.record('chess', slot.id)?.bonds?.includes(coreBondId) : ctx.record('items', slot.id)?.giveBondId === coreBondId;
    return { slot: a.slot, id: slot.id, recommended: i === best, coreFit: !!fit, heuristic: rank(a), samples: completed,
      basis: sufficient ? 'simulation' : 'build', ...(ranking[i] || {}),
      reason: `${fit ? `补强【${coreName}】` : '补足阵容、装备或合成需求'}；${sufficient ? `${completed} 个随机样本的平均收益比较` : '样本不足，按构筑价值推荐'}` };
  }) : [];
  return {
    action: actions[best], policy: global ? 'global' : 'search', ...(coreBondId ? { coreBondId, shopRecommendations } : {}),
    reason: global ? `全局规划：从当前选择推演至终局，完成 ${completed}/${samples} 组共同随机样本；${sufficient ? '按终局综合收益推荐' : '样本不足，使用启发式建议'}${truncated ? '（已到计算预算）' : ''}`
      : shopping ? `围绕【${coreName}】，完成 ${completed}/${samples} 组共同随机样本；${sufficient ? '按平均收益推荐购买' : '样本不足，使用构筑建议'}${truncated ? '（已到计算预算）' : ''}`
        : completed ? `随机推演 ${completed} 组共同样本，比较 ${actions.length} 个选择${truncated ? '；已到计算预算' : ''}` : '计算预算内未完成比较，采用内置 AI 建议',
    search: { samples: completed, requestedSamples: samples, evaluated, candidates: actions.length, rounds, truncated, sufficient, global,
      continuation: global ? `lookahead-${lookahead}` : 'builtin', lookahead, risk, objective: risk > 0 ? 'cvar-lower-tail' : 'mean', proof: false, ranking },
  };
}
