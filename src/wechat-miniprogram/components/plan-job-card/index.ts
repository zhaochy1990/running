// 赛季计划 job 卡（#1024 R3）——聊天流里的本地进度 / 结果 / 失败卡。
//
// 数据来自 coach 页的 plan-jobs 轮询（服务端为真源）；本组件只负责展示：
//   running  平滑进度条（utils/planJobProgress 的 R3 引擎：阶段预估匀速
//            推进 + 真实锚点提前跳上 / 迟到停住）+ 阶段清单
//   done     结果卡（标题/日期/周数/峰值 + 查看完整计划 / 修改目标）
//   failed   失败卡（请求已保留 + 重试 / 修改目标）
//
// 事件：
//   bindretry  无 detail   重试同一 idempotency_key 的投递
//   bindview   无 detail   查看完整计划（父页拉 job 结果 → 预览页）
//   bindedit   无 detail   修改目标（父页回表单卡重填）

import { PLAN_JOB_PHASES, phaseIndexForStage, phaseStates, planJobTrack, type PlanJobPhaseState } from '../../utils/planJobProgress';
import type { PlanJobCardView } from '../../utils/planJobCards';

/** 进度补帧间隔：轮询 2.5s 之间匀速补帧，120ms 一帧（约 8fps，够顺滑且省 setData）。 */
const TICK_MS = 120;

interface PhaseRow {
  key: string;
  label: string;
  state: PlanJobPhaseState;
}

interface JobCardData {
  status: PlanJobCardView['status'];
  /** 当前展示阶段序号（1 起，用于「第 N 步 · 共 5 步」）。 */
  stepIndex: number;
  totalSteps: number;
  percent: number;
  holding: boolean;
  phaseRows: PhaseRow[];
  title: string;
  subtitle: string;
  applied: boolean;
  /** 网络持续失败，轮询暂停（显示「轻触恢复」）。 */
  paused: boolean;
}

type JobCardProps = {
  job: { type: ObjectConstructor; value: PlanJobCardView | null };
};

/** 实例字段（非渲染数据）：补帧定时器挂 this 上，卸载/切卡即清。 */
interface JobCardInstance {
  _timer: number | null;
}

type JobCardMethods = {
  restartTicker(): void;
  stopTicker(): void;
  tick(): void;
  syncFromJob(): void;
  onRetryTap(): void;
  onViewTap(): void;
  onEditTap(): void;
  onResumeTap(): void;
};

function phaseRows(phaseIndex: number, finished: boolean): PhaseRow[] {
  const states = phaseStates(phaseIndex, finished);
  return PLAN_JOB_PHASES.map((phase, index) => ({ key: phase.key, label: phase.label, state: states[index] }));
}

Component<JobCardData, JobCardProps, JobCardMethods, [], JobCardInstance>({
  properties: {
    job: { type: Object, value: null },
  },

  data: {
    status: 'running',
    stepIndex: 1,
    totalSteps: PLAN_JOB_PHASES.length,
    percent: 0,
    holding: false,
    phaseRows: phaseRows(0, false),
    title: '',
    subtitle: '',
    applied: false,
    paused: false,
  },

  observers: {
    job() {
      this.restartTicker();
    },
  },

  lifetimes: {
    attached() {
      this.restartTicker();
    },
    detached() {
      this.stopTicker();
    },
  },

  // 宿主页切走（tab 切换/navigateTo）只触发 page hide，不停的话 120ms 补帧
  // 会在隐藏页上持续 setData；回来时按最新锚点重建。
  pageLifetimes: {
    hide() {
      this.stopTicker();
    },
    show() {
      this.restartTicker();
    },
  },

  methods: {
    restartTicker() {
      this.stopTicker();
      this.syncFromJob();
      if ((this.properties.job as PlanJobCardView | null)?.status !== 'running') return;
      this._timer = setInterval(() => this.tick(), TICK_MS) as unknown as number;
    },

    stopTicker() {
      if (this._timer != null) {
        clearInterval(this._timer);
        this._timer = null;
      }
    },

    /** 每帧：预估轨道 + 服务端锚点 → 展示值；仅变化时 setData。 */
    tick() {
      const job = this.properties.job as PlanJobCardView | null;
      if (!job || job.status !== 'running') {
        this.stopTicker();
        return;
      }
      const track = planJobTrack({
        elapsedMs: Date.now() - job.createdAt,
        targetPct: job.progressPct,
        targetPhase: phaseIndexForStage(job.stage, job.progressPct),
      });
      const percent = Math.round(track.percent);
      const stepIndex = track.phaseIndex + 1;
      if (percent === this.data.percent && stepIndex === this.data.stepIndex && track.holding === this.data.holding) return;
      this.setData({
        percent,
        stepIndex,
        holding: track.holding,
        phaseRows: phaseRows(track.phaseIndex, false),
      });
    },

    /** 属性变更：done → 100% 全绿；failed → 冻结；running → 起补帧。 */
    syncFromJob() {
      const job = this.properties.job as PlanJobCardView | null;
      if (!job) return;
      if (job.status === 'done') {
        this.stopTicker();
        this.setData({
          status: 'done',
          percent: 100,
          holding: false,
          phaseRows: phaseRows(0, true),
          title: job.title ?? '训练计划已生成',
          subtitle: job.subtitle ?? '',
          applied: job.applied === true,
          paused: false,
        });
        return;
      }
      if (job.status === 'failed') {
        this.stopTicker();
        this.setData({ status: 'failed', holding: false, applied: false, paused: false });
        return;
      }
      this.setData({ status: 'running', title: '', subtitle: '', applied: false, paused: job.pollPaused === true });
      this.tick();
    },

    onRetryTap() {
      this.triggerEvent('retry');
    },

    onViewTap() {
      this.triggerEvent('view');
    },

    onEditTap() {
      this.triggerEvent('edit');
    },

    onResumeTap() {
      this.triggerEvent('resume');
    },
  },
});
