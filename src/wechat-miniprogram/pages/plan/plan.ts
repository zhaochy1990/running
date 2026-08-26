import { buildPlanWeekView, currentWeekName, getWeeklyPlan } from '../../services/plan';
import { shanghaiToday, shanghaiWeekStart, weekSubtitle } from '../../utils/date';
import { userStore } from '../../store/index';
import type { PlanDayRowView, WeeklyPlanDetail } from '../../types/plan';

interface PlanPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  loading: boolean;
  todayYmd: string;
  weekTitle: string;
  weekSubtitle: string;
  days: PlanDayRowView[];
  hasPlan: boolean;
}

interface PlanPageHandlers {
  fetchPlan(): Promise<void>;
  render(): void;
  onMenuTap(): void;
  onDayTap(e: WechatMiniprogram.TouchEvent): void;
}

let fetchedPlan: WeeklyPlanDetail | null = null;
let userId = '';

function statusBarHeight(): number {
  try {
    return wx.getWindowInfo().statusBarHeight || 0;
  } catch {
    return wx.getSystemInfoSync().statusBarHeight || 0;
  }
}

function contentPaddingTopRpx(): number {
  let statusPx = statusBarHeight();
  let width = 375;
  try {
    const win = wx.getWindowInfo();
    statusPx = win.statusBarHeight;
    width = win.windowWidth || 375;
  } catch {
    const sys = wx.getSystemInfoSync();
    statusPx = sys.statusBarHeight;
    width = sys.windowWidth || 375;
  }
  return Math.round((statusPx * 750) / width) + 128 + 24;
}

Page<PlanPageData, PlanPageHandlers>({
  data: {
    statusBarHeight: 0,
    contentPaddingTop: 232,
    loading: true,
    todayYmd: '',
    weekTitle: '',
    weekSubtitle: '',
    days: [],
    hasPlan: false,
  },

  onLoad() {
    const today = shanghaiToday();
    fetchedPlan = null;

    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
      todayYmd: today,
    });

    // 先等认证流程 settle 再拉真实课表，避免首屏请求在登录完成前发出被 401。
    userStore.waitForAuth().then(() => {
      const { user, isAuthenticated } = userStore.getState();
      if (!isAuthenticated || !user) return;
      userId = user.id;
      this.fetchPlan();
    });
  },

  onShow() {
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) {
      tabBar.setData({ selected: 1 });
    }
  },

  async fetchPlan() {
    if (!userId) {
      fetchedPlan = null;
      this.render();
      return;
    }
    try {
      const plan = await getWeeklyPlan(userId, currentWeekName());
      fetchedPlan = plan;
    } catch {
      fetchedPlan = null;
    } finally {
      this.render();
    }
  },

  render() {
    const today = shanghaiToday();
    const weekStart = shanghaiWeekStart(today);
    const view = buildPlanWeekView(fetchedPlan, today);
    this.setData({
      weekTitle: view.weekTitle,
      weekSubtitle: weekSubtitle(weekStart),
      days: view.days,
      hasPlan: !!fetchedPlan,
      loading: false,
    });
  },

  onMenuTap() {
    wx.showToast({ title: '暂未开放', icon: 'none' });
  },

  onDayTap() {
    // 计划页点击某天暂不跳转，仅示意（后续可跳计划详情/日历）。
  },
});
