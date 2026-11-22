import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { PaceRaceTemplate } from '../services/pace-calculator.ts';
import { applyRaceTemplate, calculate, decodeCalculation, encodeCalculation, type Calculation } from './paceCalculator.ts';

function resultFor(calculation: Calculation) {
  const outcome = calculate(calculation);
  assert.ok('result' in outcome, 'error' in outcome ? outcome.error : undefined);
  return outcome.result;
}

assert.equal(resultFor({ mode: 'pace', distance: '42.195', time: '3:30', pace: '' }).pace, '4:59/km');
assert.equal(resultFor({ mode: 'time', distance: '10', time: '', pace: '5:00' }).time, '50:00');
assert.equal(resultFor({ mode: 'distance', distance: '', time: '1:00:00', pace: '5:00' }).distance, '12 km');
assert.equal(resultFor({ mode: 'time', distance: '1.609344', time: '', pace: '5:00' }).time, '08:03');
assert.ok('error' in calculate({ mode: 'time', distance: '10xyz', time: '', pace: '5:00' }));
assert.ok('error' in calculate({ mode: 'time', distance: '10', time: '', pace: '5:60' }));

const split: Calculation = {
  mode: 'segment',
  segments: [{ end: '0.5', pace: '4:00' }, { end: '2.195', pace: '5:00' }],
};
const segmented = resultFor(split);
assert.equal(segmented.kilometers[0].time, '04:30');
assert.equal(segmented.rows[1].label, '0.5–2.195 km');
assert.equal(segmented.kilometers.at(-1)?.end, 2.195);
assert.equal(segmented.kilometers.at(-1)?.cumulative, segmented.time);
assert.equal(segmented.rows.at(-1)?.cumulative, segmented.time);
assert.ok('error' in calculate({ mode: 'segment', segments: [{ end: '2', pace: '5:00' }, { end: '1', pace: '5:00' }] }));

for (const calc of [
  split,
  { mode: 'pace', distance: '0.8', time: '0:04:00', pace: '' },
  { mode: 'time', distance: '42.195', time: '', pace: '5:32' },
  { mode: 'distance', distance: '', time: '0:59:59', pace: '5:59' },
] satisfies Calculation[]) {
  const shared = decodeCalculation(encodeCalculation(calc));
  assert.ok(shared);
  assert.deepEqual(resultFor(shared), resultFor(calc));
}
assert.equal(decodeCalculation('2~pace~10~1234~'), null);
assert.equal(decodeCalculation('1~segment~10'), null);

const { templates }: { templates: PaceRaceTemplate[] } = JSON.parse(
  readFileSync(new URL('../../go/internal/api/pace_race_templates.json', import.meta.url), 'utf8'),
);
assert.equal(templates.length, 7);
for (const template of templates) {
  const segments = applyRaceTemplate(template, '03:30:00');
  assert.ok(segments, template.name);
  const result = resultFor({ mode: 'segment', segments });
  const totalSeconds = result.time.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0);
  assert.ok(Math.abs(totalSeconds - 12600) <= 4, `${template.name} calculated ${result.time}`);
  assert.equal(result.rows[0].note, template.segments[0].note);
  assert.equal(result.checkpoints.at(-1)?.cumulative, result.time);
  assert.equal(applyRaceTemplate(template, '1:59:59'), null);
}
console.log('paceCalculator.check: all assertions passed');
