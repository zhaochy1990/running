/**
 * planJobProgress.ts 自检（#1024 R3 平滑进度引擎）：
 * `node --import ./utils/ts-resolve-hooks.mjs utils/planJobProgress.check.mts`。
 * 覆盖 stage→阶段映射、匀速轨道补帧、真实锚点提前/落后、97% 封顶与阶段清单态。
 */
import { strict as assert } from 'node:assert';
import { phaseIndexForStage, phaseStates, planJobTrack } from './planJobProgress.ts';

// 服务端 stage → 展示阶段（planning_phases 按 progress 细分到排课）
assert.equal(phaseIndexForStage('reading_history', 8), 0);
assert.equal(phaseIndexForStage('evaluating', 18), 1);
assert.equal(phaseIndexForStage('planning_phases', 38), 2);
assert.equal(phaseIndexForStage('planning_phases', 60), 2);
assert.equal(phaseIndexForStage('planning_phases', 70), 3);
assert.equal(phaseIndexForStage('rule_filter', 92), 4);
assert.equal(phaseIndexForStage('outputting', 99), 4);
// 未知 stage 按百分比兜底，不回退到 0
assert.equal(phaseIndexForStage('unknown', 95), 4);
assert.equal(phaseIndexForStage('', 0), 0);

// 起步：0%，无服务端锚点
{
  const track = planJobTrack({ elapsedMs: 0, targetPct: 0, targetPhase: 0 });
  assert.equal(track.percent, 0);
  assert.equal(track.phaseIndex, 0);
  assert.equal(track.holding, false);
}

// 首锚点到达前不触发 holding 脉冲（#1031）：开场几秒 targetPct=0，预估>0
{
  const track = planJobTrack({ elapsedMs: 10_000, targetPct: 0, targetPhase: 0 });
  assert.equal(track.holding, false);
  assert.ok(track.percent > 0, 'prediction still advances smoothly');
}

// 匀速段：第 1 阶段 0→18% 用 45s，22.5s 时约 9%
{
  const track = planJobTrack({ elapsedMs: 22_500, targetPct: 0, targetPhase: 0 });
  assert.equal(Math.round(track.percent), 9);
  assert.equal(track.phaseIndex, 0);
}

// 跨阶段：45+60=105s 后进入第 3 阶段（阶段划分），106s 时从 38% 起
{
  const track = planJobTrack({ elapsedMs: 106_000, targetPct: 0, targetPhase: 0 });
  assert.equal(Math.round(track.percent), 38);
  assert.equal(track.phaseIndex, 2);
}

// 真实锚点提前：直接跳到服务端进度
{
  const track = planJobTrack({ elapsedMs: 30_000, targetPct: 92, targetPhase: 4 });
  assert.equal(track.percent, 92);
  assert.equal(track.phaseIndex, 4);
  assert.equal(track.holding, false);
}

// 真实锚点落后：预估在本阶段封顶停住（holding），不超预估
{
  const track = planJobTrack({ elapsedMs: 300_000, targetPct: 10, targetPhase: 0 });
  assert.equal(track.phaseIndex, 3);
  assert.equal(track.holding, true);
  assert.ok(track.percent < 88, 'holding should stay under the phase ceiling');
}

// 未完成阶段永远不到 100%（done 才由组件置 100）
{
  const track = planJobTrack({ elapsedMs: 3_600_000, targetPct: 100, targetPhase: 4 });
  assert.equal(track.percent, 97);
}

// 阶段清单：当前阶段 active、之前 done、之后 pending；完成态全 done
assert.deepEqual(phaseStates(0, false), ['active', 'pending', 'pending', 'pending', 'pending']);
assert.deepEqual(phaseStates(2, false), ['done', 'done', 'active', 'pending', 'pending']);
assert.deepEqual(phaseStates(0, true), ['done', 'done', 'done', 'done', 'done']);

console.log('plan job progress checks passed');
