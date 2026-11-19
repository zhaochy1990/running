// 赛季计划生成进度卡（#1024 R3）的平滑进度引擎 —— 参考
// prototypes/chat-plan-generation/preview.html 的 playTrack：
//   阶段预估耗时 → 百分比匀速推进；真实锚点（服务端 stage/progress_pct）
//   提前到 → 直接跳上去；迟到 → 预估值在本阶段封顶停住等真实进度。
//
// 服务端（coach_agent_worker kernel/master MASTER_PLAN_NODES）只报五个
// 阶段 + 单调 progress_pct（8/18/26/38/48/70/92/96/99），2.5s 一次轮询
// 粒度太粗，客户端在两次锚点之间按本表匀速补帧。预估表初值按现场实测
// 口径（goal 45s / 画像 60s / 阶段划分 150s / 排课 180s / 审计 20s），
// 纯展示常量，可随时调。
//
// 纯函数模块（无 wx 依赖），配套 utils/planJobProgress.check.mts 自检。

export interface PlanJobPhase {
  /** 稳定 key（埋点/测试用）。 */
  key: string;
  /** 进度卡阶段清单文案。 */
  label: string;
  /** 该阶段预估耗时（秒）：展示层匀速推进的斜率。 */
  estSeconds: number;
  /** 该阶段预估结束时累计百分比（也是等真实锚点时的封顶值）。 */
  pct: number;
}

export const PLAN_JOB_PHASES: readonly PlanJobPhase[] = [
  { key: 'goal', label: '确认训练目标', estSeconds: 45, pct: 18 },
  { key: 'profile', label: '分析运动画像', estSeconds: 60, pct: 38 },
  { key: 'phases', label: '划分训练阶段', estSeconds: 150, pct: 60 },
  { key: 'schedule', label: '安排每周课表', estSeconds: 180, pct: 88 },
  { key: 'audit', label: '检查负荷与审计', estSeconds: 20, pct: 97 },
];

/** 未完成时展示层封顶（done 才到 100，避免假完成）。 */
export const PLAN_JOB_MAX_PREDICTED_PCT = 97;

/** 轮询间隔：job 状态服务端为真源，2.5s 一次（#1024 R3）。 */
export const PLAN_JOB_POLL_MS = 2500;

/**
 * 服务端 stage → 展示阶段序号。`planning_phases` 内部还有 38/48/70 三个
 * 锚点：70 已经进入逐周排课，按 progress 细分到「安排每周课表」。
 * 未知 stage 按百分比阈值兜底，绝不回退到 0（避免进度条倒退）。
 */
export function phaseIndexForStage(stage: string, progressPct: number): number {
  switch (stage) {
    case 'reading_history':
      return 0;
    case 'evaluating':
      return 1;
    case 'planning_phases':
      // l2_phasing 38 / l3_load 48 属「划分阶段」，l4_content 70 起进入逐周排课。
      return progressPct >= 70 ? 3 : 2;
    case 'rule_filter':
    case 'outputting':
      return 4;
    default:
      break;
  }
  if (progressPct >= 90) return 4;
  if (progressPct >= 60) return 3;
  if (progressPct >= 30) return 2;
  if (progressPct >= 15) return 1;
  return 0;
}

export interface PlanJobTrackInput {
  /** 距 job 创建（首次投递/重试重置）的毫秒数。 */
  elapsedMs: number;
  /** 服务端 progress_pct（真实锚点）。 */
  targetPct: number;
  /** 服务端 stage 推导出的展示阶段序号（真实锚点）。 */
  targetPhase: number;
}

export interface PlanJobTrackState {
  percent: number;
  phaseIndex: number;
  /** true = 预估值已到本阶段封顶、真实进度还没跟上（百分比脉冲提示）。 */
  holding: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 展示进度 = max(预估轨道, 真实锚点)，封顶 97；阶段 = max(两者)。 */
export function planJobTrack(input: PlanJobTrackInput): PlanJobTrackState {
  const elapsedSec = Math.max(0, input.elapsedMs) / 1000;
  let predictedPct = 0;
  let predictedPhase = 0;
  let cursorSec = 0;
  let startPct = 0;
  for (let i = 0; i < PLAN_JOB_PHASES.length; i += 1) {
    const phase = PLAN_JOB_PHASES[i];
    if (elapsedSec <= cursorSec + phase.estSeconds) {
      predictedPhase = i;
      const ratio = phase.estSeconds <= 0 ? 1 : (elapsedSec - cursorSec) / phase.estSeconds;
      predictedPct = startPct + (phase.pct - startPct) * clamp(ratio, 0, 1);
      break;
    }
    cursorSec += phase.estSeconds;
    startPct = phase.pct;
    predictedPct = phase.pct;
    predictedPhase = i;
  }

  const targetPct = clamp(input.targetPct, 0, PLAN_JOB_MAX_PREDICTED_PCT);
  const targetPhase = clamp(Math.round(input.targetPhase), 0, PLAN_JOB_PHASES.length - 1);
  const percent = clamp(Math.max(predictedPct, targetPct), 0, PLAN_JOB_MAX_PREDICTED_PCT);
  return {
    percent,
    phaseIndex: Math.max(predictedPhase, targetPhase),
    // 真实锚点落后于预估轨道：预估停在本阶段封顶，进度条脉冲提示等待。
    // 第一个锚点（progress>0）到达前不脉冲——开场几秒的预估推进只匀速走，
    // 否则卡片一出现就闪「等待中」，观感像卡住（#1031）。
    holding: targetPct > 0 && targetPct + 0.5 < predictedPct,
  };
}

export type PlanJobPhaseState = 'pending' | 'active' | 'done';

/** 阶段清单的逐项状态：序号小于当前 = done，等于 = active。 */
export function phaseStates(phaseIndex: number, finished: boolean): PlanJobPhaseState[] {
  return PLAN_JOB_PHASES.map((_, index) => {
    if (finished || index < phaseIndex) return 'done';
    return index === phaseIndex ? 'active' : 'pending';
  });
}
