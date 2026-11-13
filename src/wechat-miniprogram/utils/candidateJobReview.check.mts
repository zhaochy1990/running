import { strict as assert } from 'node:assert';
import { candidateJobReview } from './candidateJobReview.ts';

const id = '11111111-2222-4333-8444-555555555555';
const content = { candidate_job_id: id, candidate_user_id: 'user', weekly_docs: [{ week_name: '2026-11-16_11-22', sessions: [{ date: '2026-11-16', summary: '轻松跑', spec: { blocks: [{ steps: ['完整步骤'] }] } }], nutrition: [] }] };
const response = { status: 'done', candidate_card: { $type: 'master-plan', data: { goal: { race_name: '比赛', distance: 'FM', race_date: '2027-01-01', target_time: '3:00:00' }, start_date: '2026-11-16', end_date: '2027-01-01', total_weeks: 7, apply_token: id, content } } };
const review = candidateJobReview(response);
assert.ok(review);
assert.equal(review.card.buttonText, '应用');
assert.equal((review.card.data as { apply_token: string }).apply_token, id);
assert.match(review.text, /尚未生效/);
assert.match(review.text, /轻松跑/);
assert.match(review.text, /完整步骤/);
assert.equal(candidateJobReview({ status: 'running' }), null);
console.log('candidate job review checks passed');
