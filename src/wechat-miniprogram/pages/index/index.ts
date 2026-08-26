import { buildDayView, currentWeekName, getWeeklyPlan } from '../../services/plan';
import {
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
} from '../../types/plan';

// ---------------------------------------------------------------------------
// 界面状态
// ---------------------------------------------------------------------------

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
}

interface IndexPageHandlers {
  fetchPlan(): Promise<void>;
  renderDay(dateYmd: string, isToday: boolean): void;
  onMenuTap(): void;
  onDayTap(e: WechatMiniprogram.TouchEvent): void;
  onCoachTap(): void;
  onWatchTap(): void;
  onMoreTap(): void;
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
    wx.showToast({ title: '暂未开放', icon: 'none' });
  },

  onMoreTap() {
    wx.showToast({ title: '暂未开放', icon: 'none' });
  },
});

