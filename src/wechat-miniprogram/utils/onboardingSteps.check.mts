/**
 * onboardingSteps.ts 自检：`node utils/onboardingSteps.check.mts`（或 `npm test`）。
 * 只覆盖进度映射与越界夹紧，不依赖小程序运行时。
 */
import { describeRun, STEP_LABELS } from './onboardingSteps.ts';

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

const onboarding = (status: string, currentStep: number) => ({
  status,
  current_step: currentStep,
  steps: [
    { name: 'sync' },
    { name: 'race_detection' },
    { name: 'calibration' },
    { name: 'compute' },
    { name: 'route_thumbnails' },
    { name: 'ability' },
  ],
});

// —— 正常推进：下标 0 基 → stepIndex 1 基 ——
eq(describeRun(onboarding('running', 0)), { label: '同步训练数据', stepIndex: 1, stepTotal: 6, percent: 0 }, 'first step');
eq(
  describeRun(onboarding('running', 2)),
  { label: '计算能力基线', stepIndex: 3, stepTotal: 6, percent: 33 },
  'third step',
);
eq(
  describeRun(onboarding('running', 5)),
  { label: '评估当前能力', stepIndex: 6, stepTotal: 6, percent: 83 },
  'last step still shows partial progress',
);

// —— done：进度必须满，且仍落回最后一步而不是越界 ——
eq(describeRun(onboarding('done', 5)).percent, 100, 'done → 100%');
eq(describeRun(onboarding('done', 5)).stepIndex, 6, 'done keeps last step index');

// —— 越界夹紧：后端步骤增减时不能算出 undefined 或 >100 ——
eq(describeRun(onboarding('running', 99)).stepIndex, 6, 'over-range clamps to last');
eq(describeRun(onboarding('running', -3)).stepIndex, 1, 'negative clamps to first');
eq(describeRun(onboarding('running', 99)).percent, 83, 'over-range keeps percent ≤ 100');

// —— 步骤缺失 / 名字未知：不编造文案，回落到原名，实在没有就说"准备中" ——
eq(describeRun({ status: 'running', current_step: 1, steps: [{ name: 'bogus_step' }] }).label, 'bogus_step', 'unknown step falls back to raw name');
eq(describeRun({ status: 'running', current_step: 0, steps: [] }).label, '准备中', 'no steps → 准备中');
eq(describeRun({ status: 'queued', current_step: 0, steps: [] }), { label: '准备中', stepIndex: 1, stepTotal: 1, percent: 0 }, 'no steps → total 1, no divide-by-zero');
eq(describeRun({ status: 'running', current_step: 0 }).label, '准备中', 'steps undefined tolerated');

// —— 步骤名映射表：这六个名字是与后端 catalog 的契约，改名必须两端一起改 ——
eq(Object.keys(STEP_LABELS).length, 6, 'six onboarding steps mapped');

console.log('onboardingSteps.check: OK');
