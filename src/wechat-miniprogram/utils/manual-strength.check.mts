import assert from 'node:assert/strict';
import type { ManualStrengthWrite } from '../types/manual-strength.ts';
import {
  copySet,
  getStrengthDraft,
  newAction,
  setStrengthDraft,
  settleStrengthDraft,
  strengthSetLabel,
  validateStrengthForm,
  type StrengthDraft,
} from './manual-strength.ts';

const storage = new Map<string, unknown>();
Object.assign(globalThis, {
  wx: {
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    removeStorageSync: (key: string) => storage.delete(key),
  },
});

const deadlift = newAction();
deadlift.name = '硬拉';
const set = deadlift.sets[0];
set.load = '20 + 杠';
set.quantity = '10';
const form = { name: '2026-11-26 力量训练', note: '训练备注', actions: [deadlift] };
const validated = validateStrengthForm(form);
assert.ok('content' in validated);
assert.equal(validated.content.actions[0].sets[0].quantity, 10);
assert.equal(strengthSetLabel(validated.content.actions[0].sets[0]), '20 + 杠 kg · 10 个');

const plank = newAction();
plank.name = '平板支撑';
plank.sets[0].load_unit = 'bodyweight';
plank.sets[0].quantity_unit = 'seconds';
assert.deepEqual(validateStrengthForm({ ...form, actions: [deadlift, plank] }), {
  field: `quantity-${plank.sets[0].key}`,
  actionKey: plank.key,
  message: '请输入大于 0 的整数',
});
plank.sets[0].quantity = '30';
const updatedForm = { ...form, actions: [{ ...deadlift, sets: [set, copySet(set)] }, plank] };
assert.notEqual(updatedForm.actions[0].sets[0].key, updatedForm.actions[0].sets[1].key);

const write: ManualStrengthWrite = { ...validated.content, revision: 0, mutation_id: 'first' };
const draft: StrengthDraft = { id: 'record', startedAt: '2026-11-25T16:30:00Z', revision: 0, form, pending: write };
setStrengthDraft('owner', { ...draft, form: updatedForm });
settleStrengthDraft('owner', draft.id, write, 1);
const persisted = getStrengthDraft('owner');
assert.equal(persisted?.revision, 1);
assert.equal(persisted?.pending, undefined);
assert.equal(persisted?.form.actions[0].sets.length, 2);
assert.equal(persisted?.form.actions[1].name, '平板支撑');
assert.equal(getStrengthDraft('other'), undefined);

setStrengthDraft('owner', draft);
settleStrengthDraft('owner', draft.id, write, 1);
assert.equal(getStrengthDraft('owner'), undefined);
console.log('manual-strength.check: all assertions passed');
