import {
  buildPlanWeekView,
  currentWeekName,
  getWeeklyPlan,
  pushPlannedSession,
} from '../../services/plan';
import { buildPushDateOptions, shanghaiToday, shanghaiWeekStart, weekSubtitle } from '../../utils/date';
import { userStore } from '../../store/index';
import type {
  PlanDayRowView,
  WeeklyPlanContentStructured,
  WeeklyPlanDetail,
} from '../../types/plan';

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
      if (!isAuthenticated || !user) {
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

  async onPushSession(e: WechatMiniprogram.TouchEvent) {
    const date = e.currentTarget.dataset.date as string;
    const index = e.currentTarget.dataset.index as number;
    if (!date || index == null || !userId) {
      wx.showToast({ title: '操作失败', icon: 'none' });
      return;
    }

    const options = buildPushDateOptions(date);
    const labels = options.map((o) => o.label);

    const res = await new Promise<WechatMiniprogram.ShowActionSheetSuccessCallbackResult>((resolve, reject) => {
      wx.showActionSheet({
        itemList: labels,
        success: resolve,
        fail: reject,
      });
    }).catch(() => null);

    if (!res) return; // 用户取消

    const targetDate = options[res.tapIndex].value;

    wx.showLoading({ title: '推送中...', mask: true });
    try {
      const result = await pushPlannedSession(userId, date, index, targetDate);
      updateSessionScheduledId(date, index, result.scheduled_workout_id);
      this.render();
      wx.showToast({ title: '推送成功', icon: 'success' });
    } catch (err: any) {
      const msg = err?.detail || err?.message || '推送失败';
      wx.showToast({ title: msg.length > 15 ? '推送失败' : msg, icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },
});

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
