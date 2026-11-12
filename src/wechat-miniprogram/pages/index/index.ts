import {
  buildDayView,
  currentWeekName,
  deleteCustomWorkout,
  getPlanSessions,
  getWeeklyPlan,
  pushCustomWorkout,
  pushPlannedSession,
} from '../../services/plan';
import { getActivities } from '../../services/activities';
import { setPendingCoachContext } from '../../services/coach';
import {
  dismissAdjustment,
  getPendingAdjustment,
} from '../../services/plan-adjustment';
import {
  answerInjuryDoctor,
  checkinInjury,
  enterInjury,
  getInjuryState,
} from '../../services/plan-injury';
import { getCurrentMasterPlan } from '../../services/master-plan';
import { STORAGE_KEYS } from '../../constants/config';
import { shouldPopupToday } from '../../utils/adjustFlow';
import {
  checkinResultText,
  doctorResultText,
  enterResultText,
  raceClosingWithinWeeks,
} from '../../utils/injuryFlow';
import {
  buildPushDateOptions,
  buildWeekDays,
  shanghaiShiftDays,
  shanghaiToday,
  shanghaiWeekStart,
  weekSubtitle,
} from '../../utils/date';
import { fmtDose, fmtDurationShort, fmtKm, fmtPace } from '../../utils/format';
import { theme } from '../../utils/theme';
import { userStore } from '../../store/index';
import type { Activity } from '../../types/activity';
import type {
  PlanAdjustment,
  PlanInjuryState,
} from '../../types/adjustment';
import type {
  PlanSessionRow,
  TodayNutritionView,
  TodayWeekDay,
  TodayWorkoutView,
  WeeklyPlanDetail,
} from '../../types/plan';
import { defaultShareAppMessage, defaultShareTimeline } from '../../utils/share';

// ---------------------------------------------------------------------------
// 今日活动行（复用活动页 .activity 行样式）
// ---------------------------------------------------------------------------

interface TodayActivityRow {
  labelId: string;
  name: string;
  iconPath: string;
  /** 归一折线 [[x,y],...]（route_thumb，devops#827 起客户端 canvas 矢量绘制）；
   * null 表示回退 iconPath（室内活动、尚未生成、或无 GPS） */
  routeThumb: number[][] | null;
  distanceKm: string;
  duration: string;
  pace: string;
  avgHr: string;
  load: string;
}

function iconPathForSport(sportName: string | null | undefined): string {
  const n = (sportName || '').toLowerCase();
  if (n.includes('strength')) return '/assets/icons/fitness_center.svg';
  if (n.includes('run') || n.includes('treadmill') || n.includes('trail')) {
    return '/assets/icons/directions_run.svg';
  }
  return '/assets/icons/schedule.svg';
}

function displayName(a: Activity): string {
  const n = a.name && a.name.trim();
  if (n) return n;
  const s = a.sport_name && a.sport_name.trim();
  return s || '活动';
}

function toTodayActivityRow(a: Activity): TodayActivityRow {
  return {
    labelId: a.label_id,
    name: displayName(a),
    iconPath: iconPathForSport(a.sport_name),
    routeThumb: a.route_thumb ?? null,
    distanceKm: a.distance_km != null && a.distance_km > 0 ? fmtKm(a.distance_m) : '—',
    duration: fmtDurationShort(a.duration_s),
    pace: fmtPace(a.avg_pace_s_km),
    avgHr: a.avg_hr != null ? `${Math.round(a.avg_hr)}` : '—',
    // 优先展示 STRIDE 自身计算的负荷（training_dose）；缺失时回退到手表上报值。
    load: fmtDose(a.stride_training_dose ?? a.training_load),
  };
}

// ---------------------------------------------------------------------------
// 界面状态
// ---------------------------------------------------------------------------

interface PushDateSelectEvent {
  detail: { value: string };
}

interface IndexPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  /** 当前用户 uid（模块级 userId 的渲染镜像，供弹层组件 property 绑定）。 */
  uid: string;
  /** 游客态（未登录）：周历可浏览，训练数据区换登录引导 */
  guest: boolean;
  weekDays: TodayWeekDay[];
  weekSubtitle: string;
  todayYmd: string;
  selectedDate: string;
  todayLabel: string;
  workout: TodayWorkoutView | null;
  nutrition: TodayNutritionView | null;
  /** 选中日的实际活动记录（无记录时为空数组，卡片不展示） */
  todayActivities: TodayActivityRow[];
  loading: boolean;
  /** 推送日期弹层可见性（±7 天共 15 个选项，需滚动列表承载） */
  pushSheetVisible: boolean;
  pushOptions: Array<{ label: string; value: string }>;
  // —— #858 PR-E：调整追问弹窗 / 伤病弹层 ——
  /** 调整追问弹窗可见性（每天首次 onShow 且有 pending 时弹一次）。 */
  adjustDialogVisible: boolean;
  pendingAdjustment: PlanAdjustment | null;
  /** 伤病弹层可见性（每日轻问 / 调整弹窗「受伤了」进入的登记表单）。 */
  injuryDialogVisible: boolean;
  injuryDialogMode: 'enter' | 'ask';
  injuryState: PlanInjuryState | null;
  /** 弹层内请求成功后的结果文案（回填即切 result 态）。 */
  injuryResultText: string;
  /** rest + 比赛临近（≤4 周）：轻问附「按现状重排」行。 */
  raceClosingSoon: boolean;
}

interface AdjustDialogEvent {
  detail: { adjustmentId: string };
}

interface InjuryEnteredEvent {
  detail: { detail: string; verdict: 'continue' | 'reduced' | 'rest' | 'undecided' };
}

interface InjuryCheckedEvent {
  detail: { answer: 'better' | 'same' | 'worse' | 'recovered' };
}

interface InjuryDoctoredEvent {
  detail: { verdict: 'continue' | 'reduced' | 'rest' };
}

interface IndexPageHandlers {
  onShareAppMessage(res: WechatMiniprogram.Page.IShareAppMessageOption): WechatMiniprogram.Page.ICustomShareContent;
  onShareTimeline(): WechatMiniprogram.Page.ICustomTimelineContent;
  fetchPlan(): Promise<void>;
  fetchWeekSessions(anchorYmd: string): Promise<void>;
  renderDay(dateYmd: string, isToday: boolean): void;
  fetchDayActivities(dateYmd: string): Promise<void>;
  checkDailyPopups(): Promise<void>;
  loadRaceClosing(userId: string): Promise<boolean>;
  refreshInjuryState(): Promise<void>;
  onWorkoutCardTap(): void;
  /** open-type=share 按钮的 catchtap：转发由 open-type 触发，这里只拦向卡片的冒泡 */
  onShareTap(): void;
  onDayTap(e: WechatMiniprogram.TouchEvent): void;
  onContentTouchStart(e: WechatMiniprogram.TouchEvent): void;
  onContentTouchEnd(e: WechatMiniprogram.TouchEvent): void;
  shiftSelectedDay(delta: number): void;
  onCoachTap(): void;
  onWatchTap(): void;
  onMoreTap(): void;
  onTodayActivityTap(e: WechatMiniprogram.TouchEvent): void;
  onPushDateSelect(e: PushDateSelectEvent): void;
  onPushDateClose(): void;
  onDeleteWorkout(): void;
  // —— #858 PR-E：调整弹窗 / 伤病弹层事件 ——
  onAdjustClosed(): void;
  onAdjustAccepted(): void;
  onAdjustDismissed(): void;
  onAdjustInjury(e: AdjustDialogEvent): void;
  onInjuryClosed(): void;
  onInjuryEntered(e: InjuryEnteredEvent): Promise<void>;
  onInjuryChecked(e: InjuryCheckedEvent): Promise<void>;
  onInjuryDoctored(e: InjuryDoctoredEvent): Promise<void>;
  onInjuryCoach(): void;
}

// 页面实例上的非渲染状态（模块级避免与 data 串扰，同 login 页 codeTimer 模式）
let fetchedPlan: WeeklyPlanDetail | null = null;
let userId = '';
// 首帧加载完成标记（devops#698）：onShow 静默刷新跳过首帧（onLoad 刚拉过）
// 与未登录/未加载态。
let planLoaded = false;
// 当前周的统一课表行（三源投影）+ 其周起始日；renderDay 从这里取当日课次。
let weekSessions: PlanSessionRow[] = [];
let sessionsWeekStart = '';

// 内容区左右轻扫切日的触摸起点（onContentTouchStart 记录，onContentTouchEnd 判定）。
let swipeStartX = 0;
let swipeStartY = 0;

// #858 PR-E 每日弹窗检查防重入：onShow 高频触发（tab 切换），检查本身是异步
// 并发拉取，重入会导致重复弹层。
let dailyPopupChecking = false;
// 调整弹窗「受伤了」路径：伤病登记成功后要 dismiss 的调整行 id（受伤接管）。
let pendingInjuryAdjustmentId = '';

function todayLabelOf(ymd: string): string {
  return `${Number(ymd.slice(5, 7))}月${Number(ymd.slice(8))}日`;
}

function statusBarHeight(): number {
  try {
    const win = wx.getWindowInfo();
    return win.statusBarHeight || 0;
  } catch {
    const sys = wx.getSystemInfoSync();
    return sys.statusBarHeight || 0;
  }
}

// 顶部栏在 rpx 单位下的总高（状态栏高度换算成 rpx + 内容 128rpx），
// 供内容区做相同步长的 padding-top，避免其被 fixed 顶栏遮挡。
function contentPaddingTopRpx(): number {
  let statusPx = statusBarHeight();
  let windowWidth = 375;
  try {
    const win = wx.getWindowInfo();
    windowWidth = win.windowWidth || 375;
  } catch {
    const sys = wx.getSystemInfoSync();
    windowWidth = sys.windowWidth || 375;
  }
  const statusRpx = Math.round((statusPx * 750) / windowWidth);
  return statusRpx + 128 + 24;
}

Page<IndexPageData, IndexPageHandlers>({
  // 今日卡分享按钮（data-share="today"）：仅自建课发免登录落地页卡（#689 仅自建课
  // 可分享），path 同 workout-detail 的分享链路；封面暂回落页面截图（canvas 封面
  // 目前只在详情页生成）。其余入口（胶囊菜单转发等）维持品牌默认卡。
  onShareAppMessage(res) {
    const w = this.data.workout;
    if (
      res.target?.dataset?.share === 'today' &&
      userId && w && w.source === 'custom' && w.workoutId
    ) {
      return {
        title: w.title || '训练课表',
        path: `/pages/workout-share/workout-share?user=${userId}&workout=${w.workoutId}`,
      };
    }
    return defaultShareAppMessage();
  },
  onShareTimeline: defaultShareTimeline,
  data: {
    statusBarHeight: 0,
    contentPaddingTop: 232,
    uid: '',
    // 游客态（未登录）：周历可浏览，训练数据区换登录引导
    guest: false,
    weekDays: [],
    weekSubtitle: '',
    todayYmd: '',
    selectedDate: '',
    todayLabel: '',
    workout: null,
    nutrition: null,
    todayActivities: [],
    loading: true,
    pushSheetVisible: false,
    pushOptions: [],
    adjustDialogVisible: false,
    pendingAdjustment: null,
    injuryDialogVisible: false,
    injuryDialogMode: 'ask',
    injuryState: null,
    injuryResultText: '',
    raceClosingSoon: false,
  },

  onLoad() {
    const today = shanghaiToday();
    const user = userStore.getState().user;
    userId = user?.id ?? '';

    const view = buildDayView(null, [], today);
    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
      ...view,
      todayYmd: today,
      selectedDate: today,
    });

    // 先等认证流程 settle，再取 userId / 拉真实 weekly plan —— 否则首屏请求会在
    // 异步登录完成前发出（无 token / 过期 token），被数据面 401。
    userStore.waitForAuth().then(() => {
      const { user, isAuthenticated } = userStore.getState();
      if (!isAuthenticated || !user) {
        // 游客态：周历+空态卡片（无登录元素，fetchPlan 的 !userId 早退兜底）。
        this.setData({ guest: true, loading: false });
        return;
      }
      userId = user.id;
      this.setData({ uid: userId });
      this.fetchPlan();
    });
  },

  onShow() {
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) {
      tabBar.setData({ selected: 2 });
    }
    // 游客态期间完成登录，switchTab 回来：退出游客态补拉数据。
    if (this.data.guest && userStore.getState().isAuthenticated) {
      this.setData({ guest: false });
      const user = userStore.getState().user;
      userId = user?.id ?? '';
      this.setData({ uid: userId });
      this.fetchPlan();
    }
    // 静默刷新（devops#698）：教练在对话里删除/改期/保存自建课后切回本 tab，
    // 课表即时反映，无需手动下拉刷新。跳过首帧（onLoad 已拉）与未加载态。
    if (planLoaded && userId) {
      void this.fetchWeekSessions(this.data.selectedDate || shanghaiToday());
    }
    // #858 PR-E：每日首次打开的训练调整追问 / 伤病轻问（静默、失败不打扰）。
    void this.checkDailyPopups();
  },

  /**
   * #858 PR-E 每日弹窗门（onShow 触发，静默失败）：
   * 1. 登录态就绪后并发拉 pending 调整 + 伤病状态；
   * 2. 有 pending 调整且「今天没弹过」（storage 记上海日）→ 弹追问弹窗；
   * 3. 否则伤病激活且「今天没问过」→ 弹每日轻问（rest + 比赛临近附重排行）。
   * 调整弹窗优先于轻问（同屏只弹一个，轻问明天再问）。
   */
  async checkDailyPopups() {
    if (dailyPopupChecking) return;
    if (this.data.adjustDialogVisible || this.data.injuryDialogVisible) return;
    dailyPopupChecking = true;
    try {
      await userStore.waitForAuth();
      const { isAuthenticated, user } = userStore.getState();
      if (!isAuthenticated || !user) return;
      const today = shanghaiToday();
      // 两扇门都关着（今天都弹/问过）就不发请求——onShow 高频触发，别白打接口。
      const adjustGateOpen = shouldPopupToday(wx.getStorageSync(STORAGE_KEYS.LAST_ADJUST_POPUP_DAY), today);
      const injuryGateOpen = shouldPopupToday(wx.getStorageSync(STORAGE_KEYS.LAST_INJURY_ASK_DAY), today);
      if (!adjustGateOpen && !injuryGateOpen) return;

      const [pending, injury] = await Promise.all([
        adjustGateOpen
          ? getPendingAdjustment(user.id).catch((err) => {
              console.warn('[index] 拉 pending 调整失败', err);
              return null;
            })
          : Promise.resolve(null),
        injuryGateOpen
          ? getInjuryState(user.id).catch((err) => {
              console.warn('[index] 拉伤病状态失败', err);
              return null;
            })
          : Promise.resolve(null),
      ]);
      // 等待期间用户可能已离开本页；仅更新数据态，弹层交给下一次 onShow。
      const pages = getCurrentPages();
      const current = pages[pages.length - 1];
      if (!current || current.route !== 'pages/index/index') return;

      if (pending) {
        wx.setStorageSync(STORAGE_KEYS.LAST_ADJUST_POPUP_DAY, today);
        this.setData({ adjustDialogVisible: true, pendingAdjustment: pending });
        return;
      }
      if (injury) {
        // rest + 比赛临近（≤4 周）：拉当前计划算比赛周距离（无计划/失败不附行）。
        let closing = false;
        if (injury.mode === 'rest') closing = await this.loadRaceClosing(user.id);
        wx.setStorageSync(STORAGE_KEYS.LAST_INJURY_ASK_DAY, today);
        this.setData({
          injuryDialogVisible: true,
          injuryDialogMode: 'ask',
          injuryState: injury,
          injuryResultText: '',
          raceClosingSoon: closing,
        });
      }
    } finally {
      dailyPopupChecking = false;
    }
  },

  /** rest 态下算比赛周是否临近（master-plan/current 的 goal.race_date，≤4 周）。 */
  async loadRaceClosing(uid: string): Promise<boolean> {
    try {
      const envelope = await getCurrentMasterPlan(uid);
      if (!envelope || envelope.content_version !== 2) return false;
      return raceClosingWithinWeeks(envelope.plan.goal.race_date, shanghaiToday());
    } catch (err) {
      console.warn('[index] 拉当前计划算比赛临近失败', err);
      return false;
    }
  },

  /** 伤病弹层操作后的状态回读（供后续 onShow 的轻问形态判定）。 */
  async refreshInjuryState() {
    if (!userId) return;
    try {
      const injury = await getInjuryState(userId);
      this.setData({ injuryState: injury });
    } catch {
      // 静默：回读失败保留旧态
    }
  },

  async fetchPlan() {
    if (!userId) {
      this.setData({ loading: false });
      return;
    }
    // onShow 登录回切路径：补拉期间回骨架，避免 workout=null + loading=false 的假空态闪现（devops#929）
    this.setData({ loading: true });
    try {
      const plan = await getWeeklyPlan(userId, currentWeekName());
      fetchedPlan = plan;
    } catch {
      // 拉取失败（未生成计划 / 网络问题）时保持空态，由界面展示空态卡片。
    } finally {
      const today = shanghaiToday();
      this.renderDay(this.data.selectedDate || today, this.data.selectedDate === today);
      this.setData({ loading: false });
    }
    // 统一课表行（周计划+自建+手表）单独拉取；失败时今日卡片回退空态。
    await this.fetchWeekSessions(this.data.selectedDate || shanghaiToday());
    planLoaded = true;
  },

  // 拉取指定日期所在周的统一课表行，并在返回后重渲染当天卡片。
  async fetchWeekSessions(anchorYmd: string) {
    if (!userId) return;
    const weekStart = shanghaiWeekStart(anchorYmd);
    sessionsWeekStart = weekStart; // 先记录，防止快速切周时的重入循环
    // 周日 = 本周 buildWeekDays 的第 7 天（纯上海日历日运算，避免 tz 折算差一天）。
    const weekEnd = buildWeekDays(weekStart)[6].date;
    try {
      const res = await getPlanSessions(userId, weekStart, weekEnd);
      weekSessions = res.sessions ?? [];
    } catch {
      weekSessions = [];
    }
    // 快速切周时丢弃过期响应，只重渲染仍属于本周的选中日。
    if (sessionsWeekStart !== weekStart) return;
    if (this.data.selectedDate) {
      this.renderDay(this.data.selectedDate, this.data.selectedDate === this.data.todayYmd);
    }
  },

  // 渲染指定日期（上海 YYYY-MM-DD），并拉取当天的实际活动记录。
  renderDay(dateYmd: string, isToday: boolean) {
    const base = {
      selectedDate: dateYmd,
      weekDays: buildWeekDays(dateYmd),
      weekSubtitle: weekSubtitle(shanghaiWeekStart(dateYmd)),
      todayLabel: todayLabelOf(dateYmd),
    };
    if (shanghaiWeekStart(dateYmd) !== sessionsWeekStart) {
      // 切到了尚未拉取的周：先用空行渲染，拉回后 fetchWeekSessions 会重渲染。
      const view = buildDayView(fetchedPlan, [], dateYmd);
      this.setData({ ...base, workout: view.workout, nutrition: view.nutrition, todayActivities: [] });
      this.fetchWeekSessions(dateYmd);
      return;
    }
    const view = buildDayView(fetchedPlan, weekSessions, dateYmd);
    this.setData({
      ...base,
      workout: view.workout,
      nutrition: view.nutrition,
      todayActivities: [],
    });
    this.fetchDayActivities(dateYmd);
  },

  // 拉取指定日（上海 YYYY-MM-DD）的实际活动记录；无记录则空数组（卡片不展示）。
  async fetchDayActivities(dateYmd: string) {
    if (!userId) return;
    try {
      const res = await getActivities(userId, { dateFrom: dateYmd, dateTo: dateYmd, limit: 20 });
      // 防止用户快速切换日期后写入过期数据。
      if (this.data.selectedDate !== dateYmd) return;
      this.setData({ todayActivities: res.activities.map(toTodayActivityRow) });
    } catch {
      // 拉取失败时保持空态，由页面不展示「今日活动」卡片。
      if (this.data.selectedDate === dateYmd) this.setData({ todayActivities: [] });
    }
  },

  // --- 交互 ---

  // 卡片整体点击 → 课表详情（分段结构/配速要求）。内层手表/更多/教练按钮
  // 已 catchtap，不会冒泡到这里。
  onWorkoutCardTap() {
    const { workout } = this.data;
    if (!workout || !workout.hasStructure) return;
    wx.navigateTo({
      url: `/pages/workout-detail/workout-detail?date=${workout.date}&workoutId=${encodeURIComponent(workout.workoutId)}&title=${encodeURIComponent(workout.title)}`,
    });
  },

  onDayTap(e: WechatMiniprogram.TouchEvent) {
    const date = e.currentTarget.dataset.date as string;
    if (!date || date === this.data.selectedDate) return;
    this.renderDay(date, date === this.data.todayYmd);
  },

  onContentTouchStart(e: WechatMiniprogram.TouchEvent) {
    const t = e.touches[0];
    if (!t) return;
    swipeStartX = t.clientX;
    swipeStartY = t.clientY;
  },

  // 横向轻扫切日：位移够长且横向显著盖过纵向（不干扰页面上下滚动），无时间门限，
  // 慢拖也算。左滑（dx<0）→ 前一天，右滑（dx>0）→ 后一天。
  onContentTouchEnd(e: WechatMiniprogram.TouchEvent) {
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - swipeStartX;
    const dy = t.clientY - swipeStartY;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 2) return;
    this.shiftSelectedDay(dx < 0 ? -1 : 1);
  },

  shiftSelectedDay(delta: number) {
    const next = shanghaiShiftDays(this.data.selectedDate || shanghaiToday(), delta);
    if (next === this.data.selectedDate) return;
    this.renderDay(next, next === this.data.todayYmd);
  },

  onCoachTap() {
    const { workout } = this.data;
    if (!workout || !workout.date) {
      wx.showToast({ title: '今日暂无训练安排', icon: 'none' });
      return;
    }
    // 把当前计划 session 作为权威 target 交给教练对话，让 coach 聚焦这次训练。
    // switchTab 不能带 query，改经 storage 交接（教练页 onShow 消费）。
    const d = workout.date;
    const label = `${workout.title} · ${Number(d.slice(5, 7))}月${Number(d.slice(8))}日`;
    if (workout.sessionIndex != null) {
      setPendingCoachContext({
        target: { kind: 'session', date: workout.date, session_index: workout.sessionIndex },
        label,
      });
    }
    wx.switchTab({ url: '/pages/coach/coach' });
  },

  // open-type=share 的 tap 仍会走 catchtap：转发由 open-type 触发，这里只为
  // 拦住向 workout-card bindtap 的冒泡（否则分享的同时会跳去课表详情）。
  onShareTap() {},

  onWatchTap() {
    const { workout } = this.data;
    if (!workout || !workout.hasSpec) {
      // weekly / custom 源可推送；watch 源本就来自手表，不回推。
      wx.showToast({ title: workout?.source === 'custom' ? '自建课暂不支持推送' : '该训练暂不支持推送', icon: 'none' });
      return;
    }
    if (!userId) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }

    // 打开推送日期选择弹层（±7 天共 15 个选项，用组件承载，见 components/push-date-sheet）
    this.setData({
      pushOptions: buildPushDateOptions(workout.date),
      pushSheetVisible: true,
    });
  },

  onMoreTap() {
    const { workout } = this.data;
    if (workout?.deletable && workout.workoutId) {
      wx.showActionSheet({
        itemList: ['删除'],
        itemColor: theme.danger,
        success: (res) => {
          if (res.tapIndex === 0) this.onDeleteWorkout();
        },
      });
      return;
    }
    wx.showToast({ title: '暂无更多操作', icon: 'none' });
  },

  onTodayActivityTap(e: WechatMiniprogram.TouchEvent) {
    const labelId = e.currentTarget.dataset.id as string;
    if (!labelId) return;
    wx.navigateTo({
      url: `/pages/activity-detail/activity-detail?labelId=${encodeURIComponent(labelId)}`,
    });
  },

  async onPushDateSelect(e: PushDateSelectEvent) {
    const targetDate = e.detail.value;
    const { workout } = this.data;
    this.setData({ pushSheetVisible: false });
    if (!workout || !targetDate) return;
    if (workout.source !== 'custom' && workout.sessionIndex == null) return;

    wx.showLoading({ title: '推送中...', mask: true });
    try {
      if (workout.source === 'custom') {
        // 自建课：卡片同款推送端点（±7 天窗口由服务端校验）。
        await pushCustomWorkout(workout.workoutId);
      } else if (workout.sessionIndex != null) {
        await pushPlannedSession(userId, workout.date, workout.sessionIndex, targetDate);
      }
      // 重新拉取本周统一课表并重渲染当前日期。
      await this.fetchWeekSessions(this.data.selectedDate);
      wx.showToast({ title: '推送成功', icon: 'success' });
    } catch (err: any) {
      const msg = err?.detail || err?.message || '推送失败';
      wx.showToast({ title: msg.length > 15 ? '推送失败' : msg, icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  onPushDateClose() {
    this.setData({ pushSheetVisible: false });
  },

  // 删除自建课：确认后软删（服务端归档），再重拉本周统一课表。
  onDeleteWorkout() {
    const { workout } = this.data;
    if (!workout || !workout.deletable || !workout.workoutId) return;
    wx.showModal({
      title: '删除自建课',
      content: `确定删除「${workout.title}」吗？`,
      confirmText: '删除',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await deleteCustomWorkout(userId, workout.workoutId);
          await this.fetchWeekSessions(this.data.selectedDate);
          wx.showToast({ title: '已删除', icon: 'success' });
        } catch {
          wx.showToast({ title: '删除失败', icon: 'none' });
        }
      },
    });
  },

  // --- #858 PR-E：调整追问弹窗事件 ---

  // 用户直接关闭（未决策）：pending 行保留，收成训练计划页提示条。
  onAdjustClosed() {
    this.setData({ adjustDialogVisible: false });
  },

  // 同意应用成功：toast 已由组件出，这里刷新本周课表（accept 覆盖当前+未来周）。
  onAdjustAccepted() {
    this.setData({ adjustDialogVisible: false, pendingAdjustment: null });
    if (planLoaded && userId) {
      void this.fetchPlan();
    }
  },

  // 保持原计划：事件已关（同一偏差周不再问）。
  onAdjustDismissed() {
    this.setData({ adjustDialogVisible: false, pendingAdjustment: null });
  },

  // 受伤路径：关调整弹窗 → 开伤病登记；登记成功后 dismiss 该调整行（受伤接管）。
  onAdjustInjury(e: AdjustDialogEvent) {
    pendingInjuryAdjustmentId = e.detail.adjustmentId || '';
    this.setData({
      adjustDialogVisible: false,
      injuryDialogVisible: true,
      injuryDialogMode: 'enter',
      injuryResultText: '',
    });
  },

  // --- #858 PR-E：伤病弹层事件 ---

  onInjuryClosed() {
    this.setData({ injuryDialogVisible: false, injuryResultText: '' });
  },

  // 登记四选一（enter / 加重后重判共用）：enter → 差异化结果文案；
  // 若来自调整弹窗受伤路径，同时 dismiss 该调整行（伤病接管）。
  async onInjuryEntered(e: InjuryEnteredEvent) {
    if (!userId) return;
    const { detail, verdict } = e.detail;
    try {
      const res = await enterInjury(userId, detail, verdict);
      // 登记完成即算当天问过（reduced/rest 之后的每日轻问从明天开始）。
      wx.setStorageSync(STORAGE_KEYS.LAST_INJURY_ASK_DAY, shanghaiToday());
      if (pendingInjuryAdjustmentId) {
        const adjustmentId = pendingInjuryAdjustmentId;
        pendingInjuryAdjustmentId = '';
        dismissAdjustment(userId, adjustmentId).catch((err) => {
          console.warn('[index] 受伤接管 dismiss 调整行失败', err);
        });
        this.setData({ pendingAdjustment: null });
      }
      this.setData({ injuryResultText: enterResultText(verdict, res.closed) });
      await this.refreshInjuryState();
    } catch (err) {
      console.error('[index] 伤病登记失败', err);
      wx.showToast({ title: '提交失败，请重试', icon: 'none' });
      this.setData({ injuryDialogVisible: false });
    }
  },

  // 每日轻问四键：recovered 关模式文案 / worse 转重判（明天问句变四选一）。
  async onInjuryChecked(e: InjuryCheckedEvent) {
    if (!userId) return;
    try {
      const res = await checkinInjury(userId, e.detail.answer);
      this.setData({
        injuryResultText: checkinResultText(e.detail.answer, res.closed ? null : res.injury),
      });
      await this.refreshInjuryState();
    } catch (err) {
      console.error('[index] 伤病轻问提交失败', err);
      wx.showToast({ title: '提交失败，请重试', icon: 'none' });
      this.setData({ injuryDialogVisible: false });
    }
  },

  // 医生结论三键（pending_doctor 态）。
  async onInjuryDoctored(e: InjuryDoctoredEvent) {
    if (!userId) return;
    try {
      const res = await answerInjuryDoctor(userId, e.detail.verdict);
      this.setData({ injuryResultText: doctorResultText(e.detail.verdict, res.closed) });
      await this.refreshInjuryState();
    } catch (err) {
      console.error('[index] 医生结论提交失败', err);
      wx.showToast({ title: '提交失败，请重试', icon: 'none' });
      this.setData({ injuryDialogVisible: false });
    }
  },

  // 「找教练聊聊」：关弹层跳教练 tab。
  onInjuryCoach() {
    this.setData({ injuryDialogVisible: false, injuryResultText: '' });
    wx.switchTab({ url: '/pages/coach/coach' });
  },
});
