// 训练调整追问弹窗（#858 PR-E）—— 自绘半屏弹层，两步状态机：
//   Step1 ask     追问原因（六选一，preselect=后端预判 reason，可改）→「查看方案」
//   Step2 plan    diff 表 + 窗口 + 审计行 →「同意调整」accept /「保持原计划」dismiss
//   loading       异因换路：choose(202) → plan-jobs enqueue → 轮询 pending（8s×≤11 次）
//   timeout       轮询超时：提示「稍后在训练计划页查看」后关闭（收提示条）
// 受伤路径（选「受伤了」）不走 choose：抛 injury 事件，由父页打开伤病登记弹层，
// 登记成功后父页 dismiss 该调整行（伤病接管）。
//
// 纯逻辑（选项/文案/分流/轮询判定）抽在 utils/adjustFlow.ts（node 可测），
// 本组件只做事件接线与 wx API 调用。
//
// 事件：
//   bindaccepted   detail = { applied }       同意并应用成功
//   binddismissed  无 detail                   保持原计划（事件关闭）
//   bindclosed     无 detail                   用户关闭（未决策，pending 行保留）
//   bindinjury     detail = { adjustmentId }   选「受伤了」→ 父页转伤病进入流

import {
  ADJUST_POLL_INTERVAL_MS,
  ADJUST_POLL_MAX_ATTEMPTS,
  ADJUST_REASON_OPTIONS,
  type AdjustDialogStep,
  type AdjustDiffRowVM,
  type AdjustReasonOption,
  buildAuditLine,
  buildDiffRows,
  buildWindowLabel,
  decideAfterChoose,
  decidePollResult,
  evidenceOf,
  parseAdjustPayload,
} from '../../utils/adjustFlow';
import {
  acceptAdjustment,
  chooseAdjustment,
  dismissAdjustment,
  getPendingAdjustment,
} from '../../services/plan-adjustment';
import { enqueueGenerateAdjustment } from '../../services/plan-jobs';
import type { AcceptAdjustmentResponse, PlanAdjustment } from '../../types/adjustment';

interface AdjustDialogData {
  step: AdjustDialogStep;
  question: string;
  evidence: string;
  options: AdjustReasonOption[];
  selected: string;
  submitting: boolean;
  // Step2 视图模型
  diffRows: AdjustDiffRowVM[];
  windowLabel: string;
  auditLine: string;
  /** loading 态副行提示。 */
  loadingHint: string;
}

/** 组件属性定义（Component 第二泛型收窄 this.properties 的值类型）。 */
type AdjustDialogProps = {
  show: { type: BooleanConstructor; value: boolean };
  userId: { type: StringConstructor; value: string };
  adjustment: { type: ObjectConstructor; value: PlanAdjustment | null };
};

/** 实例字段（非渲染数据）：轮询定时器挂在 this 上，避免模块级状态多实例串扰。 */
interface AdjustDialogInstance {
  _pollTimer: number | null;
  _pollAttempts: number;
  /** 已为哪一行 enqueue 过重生成（同一行重开弹层不重复提交 job）。 */
  _enqueuedFor: string;
}

type AdjustDialogMethods = {
  noop(): void;
  onClose(): void;
  onReasonTap(e: WechatMiniprogram.TouchEvent): void;
  onViewPlanTap(): void;
  runChoose(adjustment: PlanAdjustment, reason: Exclude<AdjustReasonOption['value'], 'injured'>): Promise<void>;
  startRegeneration(adjustment: PlanAdjustment, reason: Exclude<AdjustReasonOption['value'], 'injured'>): Promise<void>;
  waitRegeneration(adjustment: PlanAdjustment): Promise<void>;
  enqueueOnce(adjustment: PlanAdjustment, reason: Exclude<AdjustReasonOption['value'], 'injured'>): Promise<boolean>;
  startPolling(): void;
  stopPolling(): void;
  showPlan(adjustment: PlanAdjustment): void;
  onAcceptTap(): Promise<void>;
  onKeepTap(): Promise<void>;
  onTimeoutCloseTap(): void;
};

Component<AdjustDialogData, AdjustDialogProps, AdjustDialogMethods, [], AdjustDialogInstance>({
  properties: {
    show: { type: Boolean, value: false },
    userId: { type: String, value: '' },
    adjustment: { type: Object, value: null },
  },

  data: {
    step: 'ask',
    question: '',
    evidence: '',
    options: [...ADJUST_REASON_OPTIONS] as AdjustReasonOption[],
    selected: '',
    submitting: false,
    diffRows: [],
    windowLabel: '',
    auditLine: '',
    loadingHint: '',
  },

  observers: {
    // 弹层每次打开 / adjustment 刷新时重置状态。payload 为 null（重生成中
    // reopened，如上一会话换了因还没回填）→ 直接进 loading 轮询态，不再追问。
    'show, adjustment': function reset(show: boolean, adjustment: PlanAdjustment | null) {
      this.stopPolling();
      this._enqueuedFor = '';
      if (!show || !adjustment) return;
      this.setData({
        step: 'ask',
        question: adjustment.question || '上周完成得不理想，主要是？',
        evidence: evidenceOf(adjustment),
        selected: adjustment.reason,
        submitting: false,
        loadingHint: '',
      });
      if (adjustment.payload == null) {
        void this.waitRegeneration(adjustment);
      }
    },
  },

  lifetimes: {
    detached() {
      this.stopPolling();
    },
  },

  methods: {
    noop() {},

    onClose() {
      this.stopPolling();
      this.triggerEvent('closed');
    },

    onReasonTap(e: WechatMiniprogram.TouchEvent) {
      const value = e.currentTarget.dataset.value as string | undefined;
      if (!value || this.data.submitting) return;
      this.setData({ selected: value });
    },

    // Step1 底部按钮：受伤 → 转伤病登记（父页接管）；其余 → choose。
    onViewPlanTap() {
      const adjustment = this.data.adjustment as PlanAdjustment | null;
      const selected = this.data.selected as AdjustReasonOption['value'] | '';
      if (!adjustment || !selected || this.data.submitting) return;
      if (selected === 'injured') {
        this.triggerEvent('injury', { adjustmentId: adjustment.id });
        return;
      }
      void this.runChoose(adjustment, selected);
    },

    // 回答原因：同因直接出方案；异因 202（payload 清空）→ 重生成 + 轮询。
    async runChoose(adjustment: PlanAdjustment, reason: Exclude<AdjustReasonOption['value'], 'injured'>) {
      this.setData({ submitting: true });
      try {
        const updated = await chooseAdjustment(this.properties.userId, adjustment.id, reason);
        const decision = decideAfterChoose(reason, updated);
        if (decision.kind === 'show-plan') {
          this.showPlan(updated);
          return;
        }
        await this.startRegeneration(adjustment, decision.reason);
      } catch (err) {
        console.error('[adjust-dialog] choose 失败', err);
        wx.showToast({ title: '提交失败，请重试', icon: 'none' });
      } finally {
        this.setData({ submitting: false });
      }
    },

    // 异因路径：enqueue generate_adjustment → loading 轮询 pending。
    async startRegeneration(adjustment: PlanAdjustment, reason: Exclude<AdjustReasonOption['value'], 'injured'>) {
      this.setData({
        step: 'loading',
        loadingHint: '正在按你的情况重新生成…（约 1-2 分钟）',
      });
      if (!(await this.enqueueOnce(adjustment, reason))) return;
      this.startPolling();
    },

    // payload 为 null 的 reopened 行：直接 loading——先探一次（上一会话可能
    // 已在重生成，payload 随时可能回填），没好再补 enqueue 轮询。
    async waitRegeneration(adjustment: PlanAdjustment) {
      this.setData({
        step: 'loading',
        loadingHint: '正在按你的情况重新生成…（约 1-2 分钟）',
      });
      try {
        const pending = await getPendingAdjustment(this.properties.userId);
        if (pending != null && decidePollResult(pending) === 'ready') {
          this.showPlan(pending);
          return;
        }
      } catch (err) {
        console.warn('[adjust-dialog] 重开探查 pending 失败', err);
      }
      const reason = adjustment.reason === 'injured' ? 'no_time' : adjustment.reason;
      if (!(await this.enqueueOnce(adjustment, reason))) return;
      this.startPolling();
    },

    // enqueue 幂等守卫：同一调整行本次弹层生命周期内只提交一次 job。
    // 返回 false = 提交失败（已转 timeout 态，调用方不必轮询）。
    async enqueueOnce(
      adjustment: PlanAdjustment,
      reason: Exclude<AdjustReasonOption['value'], 'injured'>,
    ): Promise<boolean> {
      if (this._enqueuedFor === adjustment.id) return true;
      try {
        await enqueueGenerateAdjustment({
          eventWeekStart: adjustment.event_week_start,
          reason,
          masterPlanId: adjustment.master_plan_id,
        });
      } catch (err) {
        // enqueue 失败（coach_api 不可达等）：不硬等一个不会开始的 job，直接收尾。
        console.error('[adjust-dialog] enqueue generate_adjustment 失败', err);
        this.setData({ step: 'timeout', loadingHint: '' });
        wx.showToast({ title: '生成任务提交失败，稍后在训练计划页查看', icon: 'none' });
        return false;
      }
      this._enqueuedFor = adjustment.id;
      return true;
    },

    // 轮询 pending：payload 恢复 → Step2；超预算（8s×11≈90s）→ timeout 收提示条。
    startPolling() {
      this.stopPolling();
      this._pollAttempts = 0;
      const tick = async () => {
        this._pollAttempts += 1;
        try {
          const pending = await getPendingAdjustment(this.properties.userId);
          if (pending != null && decidePollResult(pending) === 'ready') {
            this.stopPolling();
            this.showPlan(pending);
            return;
          }
        } catch (err) {
          // 单次轮询失败（网络抖动）不终止，继续等下一次。
          console.warn('[adjust-dialog] 轮询 pending 失败', err);
        }
        if (this._pollAttempts >= ADJUST_POLL_MAX_ATTEMPTS) {
          this.stopPolling();
          this.setData({ step: 'timeout', loadingHint: '' });
          wx.showToast({ title: '方案还在生成，稍后在训练计划页查看', icon: 'none' });
          return;
        }
        this._pollTimer = setTimeout(tick, ADJUST_POLL_INTERVAL_MS) as unknown as number;
      };
      this._pollTimer = setTimeout(tick, ADJUST_POLL_INTERVAL_MS) as unknown as number;
    },

    stopPolling() {
      if (this._pollTimer != null) {
        clearTimeout(this._pollTimer);
        this._pollTimer = null;
      }
    },

    // 进入 Step2：解析 payload 组装 diff/窗口/审计视图。
    showPlan(adjustment: PlanAdjustment) {
      const payload = parseAdjustPayload(adjustment.payload);
      if (!payload) {
        // 竞态兜底：payload 仍不可读 → 按重生成中处理（受伤枚举不是引擎输入）。
        const reason = adjustment.reason === 'injured' ? 'no_time' : adjustment.reason;
        void this.startRegeneration(adjustment, reason);
        return;
      }
      this.setData({
        step: 'plan',
        evidence: payload.evidence,
        diffRows: buildDiffRows(payload.diff),
        windowLabel: buildWindowLabel(payload.window),
        auditLine: buildAuditLine(payload.audit_summary),
      });
    },

    // Step2「同意调整」：accept → toast → 抛 accepted。
    async onAcceptTap() {
      const adjustment = this.properties.adjustment as PlanAdjustment | null;
      if (!adjustment || this.data.submitting) return;
      this.setData({ submitting: true });
      try {
        const res = await acceptAdjustment(this.properties.userId, adjustment.id) as AcceptAdjustmentResponse;
        wx.showToast({ title: '已按新方案调整', icon: 'success' });
        this.triggerEvent('accepted', { applied: res.applied });
      } catch (err) {
        console.error('[adjust-dialog] accept 失败', err);
        wx.showToast({ title: '应用失败，请重试', icon: 'none' });
      } finally {
        this.setData({ submitting: false });
      }
    },

    // Step2「保持原计划」：dismiss（同一偏差周不再问）→ 抛 dismissed。
    async onKeepTap() {
      const adjustment = this.properties.adjustment as PlanAdjustment | null;
      if (!adjustment || this.data.submitting) return;
      this.setData({ submitting: true });
      try {
        await dismissAdjustment(this.properties.userId, adjustment.id);
        this.triggerEvent('dismissed');
      } catch (err) {
        console.error('[adjust-dialog] dismiss 失败', err);
        wx.showToast({ title: '提交失败，请重试', icon: 'none' });
      } finally {
        this.setData({ submitting: false });
      }
    },

    // timeout 态关闭：只抛 closed（pending 行保留，训练计划页提示条仍指向它）。
    onTimeoutCloseTap() {
      this.stopPolling();
      this.triggerEvent('closed');
    },
  },
})
