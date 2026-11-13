import { strict as assert } from 'node:assert';
import { initialWeeksNotice } from './masterPlanApplyResult.ts';

assert.equal(initialWeeksNotice(undefined), null);
assert.equal(initialWeeksNotice({ applied: [], skipped: [], replayed: true }), null);
assert.equal(initialWeeksNotice({ applied: ['2026-11-16'], skipped: [], replayed: false }), null);
assert.match(initialWeeksNotice({ applied: [], skipped: [], replayed: false }) ?? '', /不含可应用的首批周课/);
assert.match(initialWeeksNotice({ applied: [], skipped: ['2026-11-09'], replayed: false }) ?? '', /原有安排未更改/);
console.log('master plan apply result checks passed');
