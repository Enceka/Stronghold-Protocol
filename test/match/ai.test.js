import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, giveItem, chessOfTier, legalTileFor, DATA } from './harness.js';
import { createRng } from '../../server/sim/rng.js';
import { observe, forkDecision, baselineAction, legalActions, testAction, applyAIAction, evaluateAction, rolloutSteps, runSteps, purchaseScores } from '../../server/ai/model.js';
import { decideSteps } from '../../server/ai/policy.js';
import { aiStateKey, checkAIConfig } from '../../shared/ai.js';
import { validateC2S } from '../../shared/protocol.js';
import { attachAudit } from '../../server/match/audit.js';

function state(h) {
  const m = h.m;
  return JSON.stringify({ pub: m.publicView(), players: m.order.map((p) => [p.privateView(), p.layers, p.counters, p.aiMemory]), pool: m.pool.snapshot(),
    uid: m.uidSeq, rng: ['Setup', 'Shop', 'Waves', 'Draft', 'Bots', 'Meta'].map((n) => m[`rng${n}`].state()),
    timers: m._timers.size, queued: h.sched.pending(), sent: h.sent.length, bc: h.bc.length, errors: m.errorCount });
}
function prep(options = {}) { return makeMatch({ mode: 'solo', difficulty: 'FUNNY', fake: true, ...options }).start().toPrep(); }

test('AI protocol checks configuration and rejects non-decision commands', () => {
  assert.ok(checkAIConfig({ policy: 'search', weights: { lp: 10 }, search: { samples: 2, candidates: 3, rounds: 32, budgetMs: 1000 } }));
  for (const c of [{ policy: 'unknown' }, { policy: 'builtin', code: 'run' }, { policy: 'search', weights: { lp: -1 } }, { policy: 'search', search: { samples: 0 } }, { policy: 'search', search: { rounds: 33 } }]) {
    assert.equal(checkAIConfig(c), false); assert.ok(validateC2S({ t: 'g.aiConfig', config: c }));
  }
  const h = prep();
  assert.equal(applyAIAction(h.m, 'p_0', { t: 'g.leave' }).error, 'BAD_MSG');
  assert.equal(applyAIAction(h.m, 'p_0', { t: 'g.buy', slot: -1 }).error, 'BAD_MSG');
  assert.ok(h.ps('p_0').alive); h.m.dispose();
});

test('RNG clones are independent continuations, including internal state zero', () => {
  for (const initial of [0, 1, 0xffffffff]) {
    const a = createRng(1, initial), b = a.clone();
    assert.equal(a(), b()); b(); assert.notEqual(a.state(), b.state());
    assert.equal(a.clone()(), a());
  }
});

test('observation, baseline advice, legal actions and a real rollout leave the live game untouched', () => {
  const h = prep({ fake: false, seed: 4 });
  const before = state(h);
  const o = observe(h.m, 'p_0');
  assert.equal(o.version, 1); assert.equal(o.stateKey, aiStateKey(h.m.publicView(), h.ps('p_0').privateView()));
  assert.equal(o.seed, undefined); assert.equal(o.rngShop, undefined);
  const { t: publicType, ...pubPayload } = h.m.publicView(), { t: privateType, ...privatePayload } = h.ps('p_0').privateView();
  void publicType; void privateType;
  assert.equal(o.stateKey, aiStateKey(pubPayload, privatePayload));
  o.self.funds = 100000; o.map.tiles.length = 0;
  const a = baselineAction(h.m, 'p_0');
  assert.ok(a); assert.equal(testAction(h.m, 'p_0', a).error, undefined);
  assert.ok(legalActions(h.m, 'p_0', { placements: false }).some((x) => x.t === 'g.buy'));
  const r = evaluateAction(h.m, 'p_0', a, { sampleSeed: 17 });
  assert.ok(r.complete); assert.equal(r.errors, 0); assert.ok(Number.isFinite(r.score));
  assert.equal(state(h), before); h.invariants(); h.m.dispose();
});

test('sampled forks keep the revealed shop but resample the unknown future reproducibly', () => {
  const h = prep();
  const shop = (m) => m.players.get('p_0').shop.slots.map((s) => s.id);
  const sample = (seed) => { const f = forkDecision(h.m, { sampleSeed: seed, playerId: 'p_0' }); assert.deepEqual(shop(f), shop(h.m)); f.players.get('p_0').shop.freeRefreshes++; assert.ok(applyAIAction(f, 'p_0', { t: 'g.refresh' }).ok); const rolled = shop(f); f.dispose(); return rolled; };
  assert.deepEqual(sample(31), sample(31)); assert.notDeepEqual(sample(31), sample(32));
  const before = state(h);
  assert.deepEqual(evaluateAction(h.m, 'p_0', { t: 'g.ready', ready: true }, { sampleSeed: 31 }), evaluateAction(h.m, 'p_0', { t: 'g.ready', ready: true }, { sampleSeed: 31 }));
  assert.equal(state(h), before); h.m.dispose();
});

test('audited live games do not count simulated actions or income in their audit', () => {
  const h = makeMatch({ mode: 'solo', difficulty: 'FUNNY', fake: true });
  const audit = attachAudit(h.m, { invariants: true }); h.start().toPrep();
  const before = state(h), auditBefore = JSON.stringify(audit);
  assert.ok(baselineAction(h.m, 'p_0'));
  assert.ok(evaluateAction(h.m, 'p_0', { t: 'g.refresh' }, { sampleSeed: 19 }).complete);
  assert.equal(JSON.stringify(audit), auditBefore); assert.equal(state(h), before);
  h.autoHumans(); h.m.kickBot(h.ps('p_0')); h.runToEnd();
  assert.deepEqual(audit.violations, []); h.m.dispose();
});

test('observation state keys match the live client-combat views as well as server-combat views', () => {
  const h = prep({ clientCombat: true });
  const o = observe(h.m, 'p_0');
  assert.equal(o.public.combatMode, 'client');
  assert.equal(o.stateKey, aiStateKey(h.m.publicView(), h.ps('p_0').privateView()));
  h.m.dispose();
});

test('co-op observations hide other seats hands and shops; sampled continuations approximate them', () => {
  const h = makeMatch({ humans: 2, fake: true, difficulty: 'FUNNY' }).start().toPrep();
  const other = h.ps('p_1'), piece = give(h.m, other, chessOfTier(1)[0]);
  other.funds = 7777;
  const o = observe(h.m, 'p_0');
  const teammate = o.public.players.find((p) => p.playerId === 'p_1');
  assert.equal(teammate.hand, undefined); assert.equal(teammate.funds, undefined); assert.equal(teammate.shop, undefined);
  const before = state(h), f = forkDecision(h.m, { sampleSeed: 30, playerId: 'p_0' });
  assert.ok(!f.players.get('p_1').find(piece.uid)); assert.equal(f.players.get('p_1').funds, f.gd.income(f.round));
  f.dispose(); assert.equal(state(h), before); h.invariants(); h.m.dispose();
});

test('legal actions include placement facings, bench moves and usable equipment; denied moves stay denied', () => {
  const h = prep();
  const p = give(h.m, h.ps('p_0'), chessOfTier(1)[0]);
  const itemId = Object.values(DATA.items).find((x) => x.itemType === 'EQUIP' && !x.isGolden)?.id;
  assert.ok(itemId); const item = giveItem(h.m, h.ps('p_0'), itemId);
  const before = state(h), actions = legalActions(h.m, 'p_0');
  assert.ok(actions.some((a) => a.t === 'g.move' && a.uid === p.uid && a.to.area === 'board' && a.dir === 'LEFT'));
  assert.ok(actions.some((a) => a.t === 'g.move' && a.uid === p.uid && a.to.area === 'hand'));
  assert.ok(actions.some((a) => a.t === 'g.equip' && a.itemUid === item.uid && a.targetUid === p.uid));
  assert.ok(testAction(h.m, 'p_0', { t: 'g.move', uid: p.uid, to: { area: 'board', row: 0, col: 0 } }).error);
  assert.equal(state(h), before); h.m.dispose();
});

test('truncated rollout has no comparable score, cleans up on cancellation and can continue to game end', () => {
  const h = prep({ script: () => ({ bossDps: 1e7 }) });
  const before = state(h), action = { t: 'g.ready', ready: true };
  assert.deepEqual(evaluateAction(h.m, 'p_0', action, { maxSteps: 0 }).score, null);
  const gen = rolloutSteps(h.m, 'p_0', action, { rounds: 32 }); gen.next(); gen.return();
  assert.equal(state(h), before);
  const r = evaluateAction(h.m, 'p_0', action, { rounds: 32, sampleSeed: 9 });
  assert.ok(r.complete && r.victory); assert.equal(r.errors, 0);
  assert.equal(state(h), before); h.m.dispose();
});

test('draft rollout evaluates at least one battle, rather than stopping at the first prep', () => {
  const h = makeMatch({ mode: 'solo', difficulty: 'FUNNY', fake: true }).start();
  h.m.handle('p_0', { t: 'g.infoReady' }); h.runToPhase('BAND_DRAFT');
  const action = baselineAction(h.m, 'p_0');
  const r = evaluateAction(h.m, 'p_0', action, { rounds: 1 });
  assert.ok(r.complete); assert.equal(r.round, 2); h.m.dispose();
});

test('search compares complete common-sample batches and keeps the live state/memory unchanged for advice', () => {
  const h = prep(); h.ps('p_0').aiConfig = { policy: 'search', search: { candidates: 2, samples: 2, budgetMs: 2000 } };
  const before = state(h), r = runSteps(decideSteps(h.m, h.ps('p_0'), { advice: true }));
  assert.equal(r.policy, 'search'); assert.equal(r.search.samples, 2); assert.equal(r.search.ranking.length, 2);
  assert.equal(testAction(h.m, 'p_0', r.action).error, undefined); assert.equal(state(h), before); h.m.dispose();
});

test('advice only recommends; explicit apply executes once and the server rejects stale recommendations', () => {
  const h = prep(), p = h.ps('p_0'), before = p.funds;
  assert.ok(h.m.handle('p_0', { t: 'g.advice', seq: 1 }).ok);
  let advice = h.lastTo('p_0', 'm.advice');
  assert.ok(advice.action && !advice.stale); assert.equal(p.funds, before);
  assert.equal(h.m.handle('p_0', { t: 'g.advice', seq: 2 }).error, 'RATE');
  assert.ok(h.m.handle('p_0', { t: 'g.aiApply', seq: advice.seq, stateKey: advice.stateKey }).ok);
  assert.equal(h.m.handle('p_0', { t: 'g.aiApply', seq: advice.seq, stateKey: advice.stateKey }).error, 'BAD_TARGET');
  h.sched.advance(1000); h.m.handle('p_0', { t: 'g.advice', seq: 3 }); advice = h.lastTo('p_0', 'm.advice');
  assert.ok(advice.action); h.m.handle('p_0', { t: 'g.freeze' });
  assert.equal(h.m.handle('p_0', { t: 'g.aiApply', seq: advice.seq, stateKey: advice.stateKey }).error, 'BAD_TARGET');
  h.invariants(); h.m.dispose();
});

test('advice memory is disposable; local modules get frozen observations and may delegate prep', () => {
  const contexts = [];
  const h = prep({ aiPolicy: (ctx) => { contexts.push(ctx); ctx.memory.asked = 1; return ctx.baseline(); } });
  const p = h.ps('p_0'); runSteps(decideSteps(h.m, p, { advice: true }));
  assert.deepEqual(p.aiMemory, {}); assert.ok(Object.isFrozen(contexts[0].observation.self));
  assert.ok(Object.isFrozen(contexts[0].config)); h.m.dispose();
});

test('a teammate placement change invalidates advice even when the public bond/count summaries stay the same', () => {
  const h = makeMatch({ humans: 2, fake: true, difficulty: 'FUNNY' }).start().toPrep();
  const other = h.ps('p_1'), id = chessOfTier(1)[0], p = give(h.m, other, id);
  const first = legalTileFor(h.m, other, id), second = legalTileFor(h.m, other, id, new Set([first.join(',')]));
  assert.ok(second);
  assert.ok(h.m.handle('p_1', { t: 'g.move', uid: p.uid, to: { area: 'board', row: first[0], col: first[1] } }).ok);
  h.m.handle('p_0', { t: 'g.advice', seq: 1 }); const advice = h.lastTo('p_0', 'm.advice');
  assert.ok(advice.action);
  assert.ok(h.m.handle('p_1', { t: 'g.move', uid: p.uid, to: { area: 'board', row: second[0], col: second[1] } }).ok);
  assert.equal(aiStateKey(h.m.publicView(), h.ps('p_0').privateView()), advice.stateKey);
  assert.equal(h.m.handle('p_0', { t: 'g.aiApply', seq: 1, stateKey: advice.stateKey }).error, 'BAD_TARGET');
  h.m.dispose();
});

test('null user policy preserves baseline outcomes and per-seat memories remain independent', () => {
  const run = (aiPolicy) => {
    const h = makeMatch({ humans: 0, bots: 2, fake: true, difficulty: 'FUNNY', aiPolicy, script: () => ({ bossDps: 1e7 }) }).start();
    h.runToEnd(); const result = { victory: h.ended.victory, players: h.ended.players, bands: h.m.order.map((p) => p.bandId) };
    const memories = h.m.order.map((p) => p.aiMemory); h.m.dispose(); return { result, memories };
  };
  const baseline = run(null), custom = run(({ memory }) => { memory.calls = (memory.calls || 0) + 1; return null; });
  assert.deepEqual(custom.result, baseline.result); assert.ok(custom.memories.every((x) => x.calls > 0)); assert.notEqual(custom.memories[0], custom.memories[1]);
});

test('faulty policies, illegal intents and an endless sequence fall back and finish without engine errors', () => {
  for (const aiPolicy of [() => { throw new Error('user error'); }, () => ({ t: 'g.leave' }), ({ observation }) => observation.public.phase === 'PREP' ? { t: 'g.freeze' } : null]) {
    const h = makeMatch({ humans: 0, bots: 1, fake: true, difficulty: 'FUNNY', aiPolicy, script: () => ({ bossDps: 1e7 }) }).start();
    h.runToEnd(); assert.ok(h.ended.victory); assert.equal(h.m.errorCount, 0); assert.ok(h.m.order[0].aiFailures > 0);
    h.invariants(); h.m.dispose();
  }
});

test('disabling autoplay cancels a yielding custom strategy before it executes further actions', () => {
  let progressed = false;
  const h = prep({ aiPolicy: function* () { while (!progressed) { const start = performance.now(); while (performance.now() - start < 10) { /* force one slice */ } yield; } return { t: 'g.freeze' }; } });
  h.m.handle('p_0', { t: 'g.autoplay', on: true });
  h.run(() => h.m._aiJobs.size > 0); assert.equal(h.ps('p_0').shop.frozen, false);
  h.m.handle('p_0', { t: 'g.autoplay', on: false }); progressed = true;
  h.sched.advance(1); assert.equal(h.ps('p_0').shop.frozen, false); assert.equal(h.m._aiJobs.size, 0); h.m.dispose();
});

test('a custom generator that never returns is closed at its decision budget and delegates to baseline', () => {
  let closed = false;
  const h = prep({ aiPolicy: function* () { try { while (true) { const start = performance.now(); while (performance.now() - start < 2) { /* finite atomic work */ } yield; } } finally { closed = true; } } });
  const p = h.ps('p_0'); p.aiConfig = { policy: 'builtin', search: { budgetMs: 10 } };
  const r = runSteps(decideSteps(h.m, p));
  assert.ok(closed); assert.equal(r.action, null); assert.equal(r.fallback, true); assert.equal(p.aiFailures, 1); assert.equal(h.m.errorCount, 0); h.m.dispose();
});

test('preferences pick the configured strategy and run a full real game using baseline for remaining decisions', () => {
  const h = makeMatch({ humans: 0, bots: 1, mode: 'coop', difficulty: 'FUNNY', seed: 1 }).start();
  h.m.order[0].aiConfig = { policy: 'preferences', preferredBands: ['band_bldsk'] };
  h.runToEnd(); assert.equal(h.m.order[0].bandId, 'band_bldsk'); assert.equal(h.m.errorCount, 0); assert.equal(h.m.order[0].aiFailures, 0);
  h.invariants(); h.m.dispose();
});

test('core-bond target drives focus, validates disabled bonds, scores shop cards and returns sampled comparisons', () => {
  const h = prep();
  assert.equal(h.m.handle('p_0', { t: 'g.aiConfig', config: { policy: 'search', coreBondId: 'victoriaShip', search: { candidates: 3, samples: 4, budgetMs: 2000 } } }).error, undefined);
  assert.equal(h.ps('p_0').aiConfig.coreBondId, 'victoriaShip');
  const scores = purchaseScores(h.m, 'p_0'); assert.equal(scores.length, 4); assert.ok(scores.some((x) => x.value > 0));
  const advice = runSteps(decideSteps(h.m, h.ps('p_0'), { advice: true }));
  assert.equal(advice.coreBondId, 'victoriaShip'); assert.ok(advice.shopRecommendations.length > 0);
  assert.equal(advice.search.samples, 4); assert.ok(advice.shopRecommendations.some((x) => x.recommended && x.basis === 'simulation'));
  assert.ok(h.m.handle('p_0', { t: 'g.aiConfig', config: { policy: 'search', coreBondId: 'lateranoShip' } }).error === 'BAD_TARGET');
  h.m.dispose();
});

test('global mode evaluates the current choice against a terminal horizon and reports the lack of proof', () => {
  const h = prep();
  h.ps('p_0').aiConfig = { policy: 'global', coreBondId: 'victoriaShip', search: { candidates: 2, samples: 2, rounds: 32, lookahead: 2, budgetMs: 10000 } };
  const advice = runSteps(decideSteps(h.m, h.ps('p_0'), { advice: true }));
  assert.equal(advice.policy, 'global'); assert.equal(advice.search.global, true); assert.equal(advice.search.rounds, 32); assert.equal(advice.search.lookahead, 2); assert.equal(advice.search.proof, false);
  assert.match(advice.reason, /全局规划/); assert.ok(advice.search.samples >= 1); assert.ok(advice.action);
  h.m.dispose();
});

test('completed stochastic evaluations are transposed by visible state, action and sample configuration', () => {
  const h = prep();
  const p = h.ps('p_0'); p.aiConfig = { policy: 'search', search: { candidates: 2, samples: 1, rounds: 1, budgetMs: 2000 } };
  const a = baselineAction(h.m, 'p_0');
  const first = runSteps(decideSteps(h.m, p, { advice: true }));
  const size = h.m._aiTransposition.size;
  assert.ok(size > 0); assert.equal(first.search.cacheMisses, first.search.evaluated); assert.equal(first.search.cacheHits, 0);
  const second = runSteps(decideSteps(h.m, p, { advice: true }));
  assert.ok(second.search.cacheHits > 0); assert.equal(h.m._aiTransposition.size, size);
  assert.ok(a); h.m.dispose();
});
