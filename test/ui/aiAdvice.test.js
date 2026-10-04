import test from 'node:test';
import assert from 'node:assert/strict';
import { shopAIRecommendations, availableCoreBonds } from '../../public/js/ui/aiAdvice.js';
import { aiStateKey } from '../../shared/ai.js';

const pub = { phase: 'PREP', round: 1, players: [], disabledBonds: ['lateranoShip'] };
const priv = { playerId: 'p_0', alive: true, ready: false, funds: 5, aiConfig: { policy: 'search', coreBondId: 'victoriaShip' }, shop: { slots: [{ id: 'a', price: 2 }, { id: 'b', price: 8 }] } };

test('core list marks disabled bonds and shop recommendation requires the exact current card/state', () => {
  const list = availableCoreBonds([{ bondId: 'victoriaShip', name: '维多利亚', isCore: true }, { bondId: 'lateranoShip', name: '拉特兰', isCore: true }], pub);
  assert.equal(list.find((x) => x.bondId === 'lateranoShip').unavailable, true);
  const stateKey = aiStateKey(pub, priv);
  const advice = { stateKey, coreBondId: 'victoriaShip', shopRecommendations: [{ slot: 0, id: 'a', recommended: true, basis: 'simulation' }] };
  assert.equal(shopAIRecommendations(pub, priv, advice).get(0).id, 'a');
  priv.shop.slots[0].id = 'changed'; assert.equal(shopAIRecommendations(pub, priv, advice).size, 0);
  priv.shop.slots[0].id = 'a'; assert.equal(shopAIRecommendations(pub, { ...priv, funds: 1 }, advice).size, 0);
  assert.equal(shopAIRecommendations(pub, priv, { ...advice, stateKey: 'old' }).size, 0);
});
