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

interface PushDateSelectEvent {
  detail: { value: string };
}

interface PlanPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  loading: boolean;
  todayYmd: string;
  weekTitle: string;
  weekSubtitle: string;
  days: PlanDayRowView[];
  hasPlan: boolean;
  /** 推送日期弹层可见性（±7 天共 15 个选项，需滚动列表承载） */
  pushSheetVisible: boolean;
  pushOptions: Array<{ label: string; value: string }>;
}

interface PlanPageHandlers {
  fetchPlan(): Promise<void>;
  render(): void;
  onMenuTap(): void;
  onDayTap(e: WechatMiniprogram.TouchEvent): void;
  onPushSession(e: WechatMiniprogram.TouchEvent): void;
  onPushDateSelect(e: PushDateSelectEvent): void;
  onPushDateClose(): void;
}

let fetchedPlan: WeeklyPlanDetail | null = null;
let userId = '';
// 当前待推送的 session（由 onPushSession 记录，onPushDateSelect 消费）
let pendingPushDate = '';
let pendingPushIndex = -1;

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
    pushSheetVisible: false,
    pushOptions: [],
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

  onPushSession(e: WechatMiniprogram.TouchEvent) {
    const date = e.currentTarget.dataset.date as string;
    const index = e.currentTarget.dataset.index as number;
    if (!date || index == null || !userId) {
      wx.showToast({ title: '操作失败', icon: 'none' });
      return;
    }

    // 打开推送日期选择弹层（±7 天共 15 个选项，用组件承载，见 components/push-date-sheet）
    pendingPushDate = date;
    pendingPushIndex = index;
    this.setData({
      pushOptions: buildPushDateOptions(date),
      pushSheetVisible: true,
    });
  },

  async onPushDateSelect(e: PushDateSelectEvent) {
    const targetDate = e.detail.value;
    this.setData({ pushSheetVisible: false });
    if (!targetDate || !pendingPushDate || pendingPushIndex < 0) return;

    wx.showLoading({ title: '推送中...', mask: true });
    try {
      const result = await pushPlannedSession(userId, pendingPushDate, pendingPushIndex, targetDate);
      updateSessionScheduledId(pendingPushDate, pendingPushIndex, result.scheduled_workout_id);
      this.render();
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
