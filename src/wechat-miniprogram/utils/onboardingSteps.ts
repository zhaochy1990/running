// onboarding pipeline 的进度展示 —— 纯函数，自检见 utils/onboardingSteps.check.mts。
// 步骤名与 Go catalog 的 onboarding 步骤一一对应：
//   sync → race_detection → calibration → compute → route_thumbnails → ability

/** describeRun 的入参：只用到这三个字段，所以不依赖 types/sync 的完整类型。 */
export interface RunLike {
  status: string;
  current_step: number;
  steps?: Array<{ name: string }> | null;
}

export interface RunProgress {
  /** 当前步骤的中文名；未知步骤回落到后端给的步骤原名。 */
  label: string;
  /** 第几步（1 基）/ 共几步。 */
  stepIndex: number;
  stepTotal: number;
  /** 0-100，按步骤数算的粗粒度进度。 */
  percent: number;
}

export const STEP_LABELS: Record<string, string> = {
  sync: '同步训练数据',
  race_detection: '识别比赛',
  calibration: '计算能力基线',
  compute: '生成负荷与趋势',
  route_thumbnails: '生成路线缩略图',
  ability: '评估当前能力',
};

export function describeRun(run: RunLike): RunProgress {
  const steps = run.steps || [];
  const total = steps.length || 1;
  // current_step 是"正在跑第几步"的下标；夹紧是为了容忍后端多加/少加步骤时的越界
  const index = Math.min(Math.max(run.current_step || 0, 0), total - 1);
  const name = steps[index]?.name || '';
  const finished = run.status === 'done' ? total : index;
  return {
    label: STEP_LABELS[name] || name || '准备中',
    stepIndex: index + 1,
    stepTotal: total,
    percent: Math.round((finished / total) * 100),
  };
}
