import { createStore } from '../store.js';
import { aiStateKey } from '../../../shared/ai.js';

// The assistant and shop share one observation-bound recommendation; no game state is changed locally.
export const aiAdviceStore = createStore({ message: null, open: false });

export function availableCoreBonds(bonds, pub) {
  const disabled = new Set(pub?.disabledBonds || []);
  return (bonds || []).filter((b) => b.isCore).map((b) => ({ ...b, unavailable: disabled.has(b.bondId) }));
}

export function shopAIRecommendations(pub, priv, advice) {
  if (!advice || advice.stale || pub?.phase !== 'PREP' || priv?.ready || advice.stateKey !== aiStateKey(pub, priv)
    || advice.coreBondId !== priv?.aiConfig?.coreBondId) return new Map();
  return new Map((advice.shopRecommendations || []).filter((r) => {
    const slot = priv?.shop?.slots?.[r.slot];
    return r.recommended && slot && !slot.sold && slot.id === r.id && slot.price <= priv.funds;
  }).map((r) => [r.slot, r]));
}
