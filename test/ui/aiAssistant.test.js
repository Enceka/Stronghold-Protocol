import test from 'node:test';
import assert from 'node:assert/strict';
import { describeAIAction } from '../../public/js/ui/aiAssistant.js';

test('AI recommendations name the chosen units, shop slot, facing and equipment replacement', () => {
  const lookup = (id) => ({ name: `名称-${id}` });
  const gd = { chess: lookup, item: lookup, token: lookup, band: lookup };
  const priv = { hand: [{ uid: 1, id: 'operator' }, { uid: 2, id: 'item' }], board: [], temp: [], shop: { slots: [{ id: 'shop' }] } };
  assert.match(describeAIAction({ t: 'g.buy', slot: 0 }, gd, priv), /名称-shop.*第 1 格/);
  assert.match(describeAIAction({ t: 'g.move', uid: 1, to: { area: 'board', row: 10, col: 2 }, dir: 'LEFT' }, gd, priv), /名称-operator.*10, 2.*朝左/);
  assert.match(describeAIAction({ t: 'g.equip', itemUid: 2, targetUid: 1, replaceUid: 3 }, gd, priv), /名称-operator.*名称-item.*替换/);
  assert.match(describeAIAction({ t: 'g.choice', idx: 0 }, gd, priv), /第 1 张/);
  assert.match(describeAIAction({ t: 'g.ready', ready: true }, gd, priv), /准备作战/);
});
