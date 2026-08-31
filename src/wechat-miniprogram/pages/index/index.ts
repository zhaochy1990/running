import {
  buildDayView,
  currentWeekName,
  getWeeklyPlan,
  pushPlannedSession,
} from '../../services/plan';
import {
  buildPushDateOptions,
  buildWeekDays,
  shanghaiToday,
  shanghaiWeekStart,
  weekSubtitle,
} from '../../utils/date';
import { userStore } from '../../store/index';
import type {
  TodayNutritionView,
  TodayWeekDay,
  TodayWorkoutView,
  WeeklyPlanDetail,
  WeeklyPlanContentStructured,
} from '../../types/plan';

// ---------------------------------------------------------------------------
// 界面状态
// ---------------------------------------------------------------------------

interface PushDateSelectEvent {
  detail: { value: string };
}

interface IndexPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  weekDays: TodayWeekDay[];
  weekSubtitle: string;
  todayYmd: string;
  selectedDate: string;
  todayLabel: string;
  workout: TodayWorkoutView | null;
  nutrition: TodayNutritionView | null;
  loading: boolean;
  /** 推送日期弹层可见性（±7 天共 15 个选项，需滚动列表承载） */
  pushSheetVisible: boolean;
  pushOptions: Array<{ label: string; value: string }>;
}

interface IndexPageHandlers {
  fetchPlan(): Promise<void>;
  renderDay(dateYmd: string, isToday: boolean): void;
  onMenuTap(): void;
  onDayTap(e: WechatMiniprogram.TouchEvent): void;
  onCoachTap(): void;
  onWatchTap(): void;
  onMoreTap(): void;
  onPushDateSelect(e: PushDateSelectEvent): void;
  onPushDateClose(): void;
}

// 页面实例上的非渲染状态（模块级避免与 data 串扰，同 login 页 codeTimer 模式）
let fetchedPlan: WeeklyPlanDetail | null = null;
let userId = '';

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
  data: {
    statusBarHeight: 0,
    contentPaddingTop: 232,
    weekDays: [],
    weekSubtitle: '',
    todayYmd: '',
    selectedDate: '',
    todayLabel: '',
    workout: null,
    nutrition: null,
    loading: true,
    pushSheetVisible: false,
    pushOptions: [],
  },

  onLoad() {
    const today = shanghaiToday();
    const user = userStore.getState().user;
    userId = user?.id ?? '';

    const view = buildDayView(null, today);
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
        // 会话失效/未绑定：正常情况下 checkAuth 会发起 reLaunch 到登录页，这里兜底，
        // 避免「token 已无效却停留在本周训练首页」的空态。
        wx.reLaunch({ url: '/pages/login/login' });
        return;
      }
      userId = user.id;
      this.fetchPlan();
    });
  },

  onShow() {
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) {
      tabBar.setData({ selected: 0 });
    }
  },

  async fetchPlan() {
    if (!userId) {
      this.setData({ loading: false });
      return;
    }
    try {
      const plan = await getWeeklyPlan(userId, currentWeekName());
      fetchedPlan = plan;
      const today = shanghaiToday();
      this.renderDay(this.data.selectedDate || today, this.data.selectedDate === today);
    } catch {
      // 拉取失败（未生成计划 / 网络问题）时保持空态，由界面展示空态卡片。
    } finally {
      this.setData({ loading: false });
    }
  },

  // 渲染指定日期（上海 YYYY-MM-DD）。
  renderDay(dateYmd: string, isToday: boolean) {
    if (!fetchedPlan) {
      this.setData({
        selectedDate: dateYmd,
        weekDays: buildWeekDays(dateYmd),
        weekSubtitle: weekSubtitle(shanghaiWeekStart(dateYmd)),
        todayLabel: todayLabelOf(dateYmd),
        workout: null,
        nutrition: null,
      });
      return;
    }

    const view = buildDayView(fetchedPlan, dateYmd);
    this.setData({
      selectedDate: dateYmd,
      weekDays: buildWeekDays(dateYmd),
      weekSubtitle: weekSubtitle(shanghaiWeekStart(dateYmd)),
      todayLabel: todayLabelOf(dateYmd),
      workout: view.workout,
      nutrition: view.nutrition,
    });
  },

  // --- 交互 ---

  onMenuTap() {
    wx.showToast({ title: '暂未开放', icon: 'none' });
  },

  onDayTap(e: WechatMiniprogram.TouchEvent) {
    const date = e.currentTarget.dataset.date as string;
    if (!date || date === this.data.selectedDate) return;
    this.renderDay(date, date === this.data.todayYmd);
  },

  onCoachTap() {
    // 跳转教练问答页（pages/coach/coach 尚未实现，先 toast 占位）
    wx.showToast({ title: '暂未开放', icon: 'none' });
  },

  onWatchTap() {
    const { workout } = this.data;
    if (!workout || !workout.hasSpec) {
      wx.showToast({ title: '该训练暂不支持推送', icon: 'none' });
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
    wx.showToast({ title: '暂未开放', icon: 'none' });
  },

  async onPushDateSelect(e: PushDateSelectEvent) {
    const targetDate = e.detail.value;
    const { workout } = this.data;
    this.setData({ pushSheetVisible: false });
    if (!workout || !targetDate) return;

    wx.showLoading({ title: '推送中...', mask: true });
    try {
      const result = await pushPlannedSession(userId, workout.date, workout.sessionIndex, targetDate);
      // 更新本地计划数据中的 scheduled_workout_id
      updateSessionScheduledId(workout.date, workout.sessionIndex, result.scheduled_workout_id);
      // 重新渲染当前日期
      this.renderDay(this.data.selectedDate, this.data.selectedDate === this.data.todayYmd);
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
});

// 更新 fetchedPlan 中指定 session 的 scheduled_workout_id，推送成功后调用
function updateSessionScheduledId(date: string, sessionIndex: number, scheduledId: number) {
  if (!fetchedPlan) return;
  const content =
    typeof fetchedPlan.content === 'object' && fetchedPlan.content !== null
      ? (fetchedPlan.content as WeeklyPlanContentStructured)
      : null;
  if (!content || !Array.isArray(content.sessions)) return;

  const session = content.sessions.find(
    (s) => s.date === date && s.session_index === sessionIndex,
  );
  if (session) {
    session.scheduled_workout_id = scheduledId;
  }
}

