// 训练课表免登录分享落地页 —— devops#703（Epic #700，设计 #690-#694）。
// B 点开分享链接 ?user=<A_uuid>&workout=<workout_uuid>：免登录拉公开端点
// GET /api/workouts/shared/:user/:workout（#701，{auth:false} 同 strategy-share），
// 零身份只读渲染 V1 沉浸课卡：hero（课名+「原排期」chip+三 stat）→ summary
// 左边线引用 → 全量分段（复用 workout-detail 定稿语言：行构造公用
// utils/workoutSegments，样式整包 @import workout-detail.wxss）。
// CTA 并排双按钮（#693 amendment）：主「保存到我的课表」+ 次「推送手表」；
// 未登录 tap 任一 → login?redirect=本页（#692，回来不 toast）。
// 保存 = ±7 天选日（push-date-sheet，默认原排期落在 [今天,今天+7] 用之否则
// 今天）→ upsertCustomWorkout（save_token=shared-<A_workout_id> 幂等）。
// 推送 = 先存后推（coach 卡同款），推送前查绑表；未绑 modal → watch 页，
// 回来自动续推（零引导）。缺参 / 端点 404 → 「该分享已失效」空态。
import { ApiError } from '../../services/request';
import {
  estimateWorkoutSeconds,
  getSharedWorkout,
  pushCustomWorkout,
  upsertCustomWorkout,
  type SharedWorkout,
} from '../../services/plan';
import { getWatchInfo } from '../../services/watch';
import { userStore } from '../../store/index';
import { buildPushDateOptions, shanghaiWeekdayLabel } from '../../utils/date';
import { fmtDose, fmtDurationShort, fmtKm } from '../../utils/format';
import {
  buildExerciseRows,
  buildRunGroups,
  type ExerciseRowVM,
  type SegmentGroupVM,
} from '../../utils/workoutSegments';
import type {
  CustomWorkoutCard,
  NormalizedRunWorkout,
  NormalizedStrengthWorkout,
} from '../../types/plan';

interface WorkoutSharePageData {
  statusBarHeight: number;
  /** 冷开分享卡时页面栈只有本页，无上级可回：顶栏显示回主页的小房子 */
  canBack: boolean;
  /** loading：请求中；ready：已渲染；dead：链接失效（缺参/404）；error：网络失败可重试 */
  loadState: 'loading' | 'ready' | 'dead' | 'error';
  header: {
    name: string;
    /** `原排期 10月20日 · 周二` */
    dateLabel: string;
    summary: string;
    iconPath: string;
  };
  stats: Array<{ value: string; label: string }>;
  runGroups: SegmentGroupVM[];
  exercises: ExerciseRowVM[];
  specNote: string;
  /** 保存按钮态：true = 已保存（徽章），再点为幂等空操作 */
  saved: boolean;
  /** 推送按钮态：true = 已推送（仅展示，可重复推） */
  pushed: boolean;
  /** 选日弹层（push-date-sheet）：保存 / 保存并推送共用，标题区分 */
  sheetVisible: boolean;
  sheetTitle: string;
  sheetOptions: Array<{ label: string; value: string; selected?: boolean }>;
  /** 保存请求在途（含保存+推送链），防双击重放 */
  saving: boolean;
}

interface WorkoutSharePageHandlers {
  onLoad(options: Record<string, string | undefined>): void;
  onShow(): void;
  onBack(): void;
  onRetryTap(): void;
  onSaveTap(): void;
  onPushTap(): void;
  onDateSelect(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
  onDateClose(): void;
  load(): Promise<void>;
  /** 拉到端点响应后构建视图模型（render 是 Page 实例保留名，故用 applyView）。 */
  applyView(res: SharedWorkout): void;
  /** 未登录 → login?redirect=本页；已登录返回 true。 */
  ensureLogin(): boolean;
  /** 分享课 → 自建课保存卡（save_token 幂等）。 */
  buildCard(date: string): CustomWorkoutCard;
  /** 推送已保存的课（绑表检查 → showLoading → 推送）。 */
  pushSaved(): Promise<void>;
  /** 推送前绑表检查；未绑 modal → watch 页，回来自动续推。 */
  ensureWatchBound(): Promise<boolean>;

  // 链接参数（onLoad 解析；retry 复用）
  _userId: string;
  _workoutId: string;
  /** 端点原始响应（保存链取 totals/spec/kind 原样字段） */
  _shared: SharedWorkout | null;
  /** 分享者原排期日（YYYY-MM-DD），选日弹层默认值用 */
  _sourceDate: string;
  /** 保存后的统一课表行（推送链要用的 workout_id） */
  _savedWorkoutId: string;
  /** 我保存这份课所选的日期（推送 target_date） */
  _savedDate: string;
  /** 待执行的推送意图：选完日先存后推 / 绑表回来续推 */
  _pendingPush: boolean;
  /** 从 watch 页回来时在 onShow 续推（零引导） */
  _resumePush: boolean;
}

function statusBarHeight(): number {
  try {
    return wx.getWindowInfo().statusBarHeight || 0;
  } catch {
    return wx.getSystemInfoSync().statusBarHeight || 0;
  }
}

Page<WorkoutSharePageData, WorkoutSharePageHandlers>({
  data: {
    statusBarHeight: 0,
    canBack: false,
    loadState: 'loading',
    header: { name: '', dateLabel: '', summary: '', iconPath: '' },
    stats: [],
    runGroups: [],
    exercises: [],
    specNote: '',
    saved: false,
    pushed: false,
    sheetVisible: false,
    sheetTitle: '',
    sheetOptions: [],
    saving: false,
  },

  // 链接参数（onLoad 解析；retry 复用）
  _userId: '',
  _workoutId: '',
  /** 端点原始响应（保存链取 totals/spec/kind 原样字段） */
  _shared: null as SharedWorkout | null,
  /** 分享者原排期日（YYYY-MM-DD），选日弹层默认值用 */
  _sourceDate: '',
  /** 保存后的统一课表行（推送链要用的 workout_id） */
  _savedWorkoutId: '',
  /** 我保存这份课所选的日期（推送 target_date） */
  _savedDate: '',
  /** 待执行的推送意图：选完日先存后推 / 绑表回来续推 */
  _pendingPush: false,
  /** 从 watch 页回来时在 onShow 续推（零引导） */
  _resumePush: false,

  onLoad(options) {
    this._userId = String(options.user || '');
    this._workoutId = String(options.workout || '');
    this.setData({
      statusBarHeight: statusBarHeight(),
      canBack: getCurrentPages().length > 1,
    });
    if (!this._userId || !this._workoutId) {
      this.setData({ loadState: 'dead' });
      return;
    }
    void this.load();
  },

  onShow() {
    // 从 watch 页绑表回来：有未完成的推送意图就自动续推，不再提示（零引导）。
    if (!this._resumePush) return;
    this._resumePush = false;
    if (!this._savedWorkoutId || !this._savedDate) return;
    void this.pushSaved();
  },

  // 有上级返回上级；栈深 1（冷开分享卡）navigateBack 必失败 → 回主页（教练 tab）
  onBack() {
    wx.navigateBack({
      fail: () => wx.switchTab({ url: '/pages/coach/coach' }),
    });
  },

  onRetryTap() {
    this.setData({ loadState: 'loading' });
    void this.load();
  },

  async load() {
    try {
      const res = await getSharedWorkout(this._userId, this._workoutId);
      this.applyView(res);
    } catch (err: unknown) {
      // 400/404（链接坏/已删/非自建课）→ 失效空态；网络/5xx → 可重试。
      const status = err instanceof ApiError ? err.statusCode : 0;
      this.setData({ loadState: status >= 500 || status === 0 ? 'error' : 'dead' });
    }
  },

  applyView(res: SharedWorkout) {
    const isRun = res.kind === 'run' && res.spec != null && 'blocks' in res.spec;
    const isStrength = res.kind === 'strength' && res.spec != null && 'exercises' in res.spec;
    const d = res.date || '';
    const dateLabel = /^\d{4}-\d{2}-\d{2}$/.test(d)
      ? `${Number(d.slice(5, 7))}月${Number(d.slice(8))}日 ${shanghaiWeekdayLabel(d)}`
      : '';

    // 指标口径与 workout-detail 一致（所见即所得）：跑课=距离/时长/负荷
    // （时长缺落库值用配速中值估时兜底），力量=时长/动作数/总组数。
    const totalDurationText = isRun
      ? res.total_duration_s != null
        ? fmtDurationShort(res.total_duration_s)
        : fmtDurationShort(estimateWorkoutSeconds((res.spec as NormalizedRunWorkout).blocks))
      : res.total_duration_s != null
        ? fmtDurationShort(res.total_duration_s)
        : '—';
    const exercises = isStrength ? buildExerciseRows(res.spec as NormalizedStrengthWorkout) : [];
    const stats = isStrength
      ? [
          { value: totalDurationText, label: '预计时长' },
          { value: `${exercises.length} 个`, label: '动作' },
          {
            value: `${(res.spec as NormalizedStrengthWorkout).exercises.reduce((sum, ex) => sum + ex.sets, 0)} 组`,
            label: '总组数',
          },
        ]
      : [
          { value: fmtKm(res.total_distance_m), label: '距离(公里)' },
          { value: totalDurationText, label: '总时长' },
          { value: fmtDose(res.estimated_dose), label: '训练负荷' },
        ];

    this._sourceDate = d;
    this._shared = res;
    this.setData({
      loadState: 'ready',
      header: {
        name: res.name || res.summary || '训练',
        dateLabel: dateLabel ? `原排期 ${dateLabel}` : '',
        summary: res.summary || '',
        iconPath:
          res.kind === 'strength'
            ? '/assets/icons/fitness_center.svg'
            : '/assets/icons/directions_run.svg',
      },
      stats,
      runGroups: isRun ? buildRunGroups(res.spec as NormalizedRunWorkout) : [],
      exercises,
      specNote: isRun ? (res.spec as NormalizedRunWorkout).note || '' : '',
    });
  },

  /** 未登录 → login?redirect=本页（#692 回跳白名单链路），不 toast。 */
  ensureLogin(): boolean {
    if (userStore.getState().isAuthenticated) return true;
    const target = `/${this.route}?user=${encodeURIComponent(this._userId)}&workout=${encodeURIComponent(this._workoutId)}`;
    wx.navigateTo({ url: `/pages/login/login?redirect=${encodeURIComponent(target)}` });
    return false;
  },

  onSaveTap() {
    if (this.data.saved || this.data.saving) return;
    if (!this.ensureLogin()) return;
    this._pendingPush = false;
    this.setData({
      sheetTitle: '保存到哪一天？',
      sheetOptions: buildPushDateOptions(this._sourceDate, '（原排期）'),
      sheetVisible: true,
    });
  },

  onPushTap() {
    if (this.data.saving) return;
    if (!this.ensureLogin()) return;
    if (this.data.saved && this._savedWorkoutId) {
      void this.pushSaved();
      return;
    }
    // 未保存先走「保存并推送」：选完日先 upsert 再推（coach 卡同款先后链）。
    this._pendingPush = true;
    this.setData({
      sheetTitle: '保存并推送到哪一天？',
      sheetOptions: buildPushDateOptions(this._sourceDate, '（原排期）'),
      sheetVisible: true,
    });
  },

  async onDateSelect(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const date = e.detail.value;
    const pushAfter = this._pendingPush;
    this._pendingPush = false;
    this.setData({ sheetVisible: false });
    if (!date || this.data.saving) return;

    this.setData({ saving: true });
    try {
      const row = await upsertCustomWorkout(this.buildCard(date));
      this._savedWorkoutId = row.workout_id;
      this._savedDate = date;
      this.setData({ saved: true });
      if (!pushAfter) {
        wx.showToast({ title: '已保存', icon: 'success' });
        return;
      }
      await this.pushSaved();
    } catch {
      wx.showToast({ title: '保存失败，请稍后再试', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  onDateClose() {
    this._pendingPush = false;
    this.setData({ sheetVisible: false });
  },

  /** 分享课 → 自建课保存卡：save_token=shared-<A_workout_id> 幂等，
   * kind/name/summary/spec/totals/dose 按端点响应原样透传。 */
  buildCard(date: string): CustomWorkoutCard {
    const s = this._shared!;
    return {
      save_token: `shared-${this._workoutId}`,
      date,
      kind: s.kind === 'strength' ? 'strength' : 'run',
      name: s.name,
      summary: s.summary ?? '',
      total_distance_m: s.total_distance_m,
      total_duration_s: s.total_duration_s,
      estimated_dose: s.estimated_dose,
      spec: s.spec as NormalizedRunWorkout,
    };
  },

  /** 推送已保存的课：先查绑表，未绑 modal 引导去 watch 页，回来自动续推。 */
  async pushSaved() {
    if (!(await this.ensureWatchBound())) return;
    wx.showLoading({ title: '推送中...', mask: true });
    try {
      await pushCustomWorkout(this._savedWorkoutId, this._savedDate);
      this.setData({ pushed: true });
      wx.showToast({ title: '已推送到手表', icon: 'success' });
    } catch (err: any) {
      const msg = err?.detail || err?.message || '推送失败';
      wx.showToast({ title: msg.length > 15 ? '推送失败' : msg, icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  /** 推送前绑表检查（getWatchInfo）；查询失败按已绑处理，让推送端点的
   * 服务端失败文案兜底（不把网络故障误判成未绑表送去绑表页）。 */
  ensureWatchBound(): Promise<boolean> {
    return getWatchInfo()
      .then((info) => {
        if (info.provider) return true;
        wx.showModal({
          title: '推送手表需先绑定',
          content: '绑定手表后即可推送课表到表盘',
          confirmText: '去绑定',
          cancelText: '暂不',
          success: (res) => {
            if (!res.confirm) return;
            this._resumePush = true;
            wx.navigateTo({ url: '/pages/watch/watch' });
          },
        });
        return false;
      })
      .catch(() => true);
  },
});
