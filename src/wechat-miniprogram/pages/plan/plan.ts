import { buildPlanWeekView, currentWeekName, getWeeklyPlan } from '../../services/plan';
import { buildWeekDays, shanghaiToday, shanghaiWeekStart, weekSubtitle } from '../../utils/date';
import { userStore } from '../../store/index';
import type { PlanDayRowView, PlanSessionRowView, PlanWeekView, WeeklyPlanDetail } from '../../types/plan';

interface PlanPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  loading: boolean;
  todayYmd: string;
  weekTitle: string;
  weekSubtitle: string;
  days: PlanDayRowView[];
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

function demoSession(
  kind: PlanSessionRowView['kind'],
  title: string,
  distanceKm: string,
  duration: string,
): PlanSessionRowView {
  let iconPath = '/assets/icons/schedule.svg';
  if (kind === 'run') iconPath = '/assets/icons/directions_run.svg';
  else if (kind === 'strength') iconPath = '/assets/icons/fitness_center.svg';
  return {
    sessionIndex: 0,
    kind,
    title,
    note: '',
    distanceKm,
    duration,
    isRest: kind === 'rest',
    iconPath,
  };
}

function buildDemoWeek(anchorYmd: string): PlanWeekView {
  const weekStart = shanghaiWeekStart(anchorYmd);
  const days = buildWeekDays(anchorYmd);
  const weekDays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  // 每行一个示意训练（对应 design/today.html 所在周的示例）。
  const demoByIndex: Array<PlanSessionRowView> = [
    demoSession('strength', '力量训练', '', '45:00'),
    demoSession('run', '有氧跑', '10.0', '00:52:00'),
    demoSession('run', '恢复跑', '6.0', '00:36:00'),
    demoSession('run', '渐加速跑', '10.71', '00:51:21'),
    demoSession('rest', '休息', '', ''),
    demoSession('run', '长距离跑', '18.0', '01:35:00'),
    demoSession('rest', '休息', '', ''),
  ];

  return {
    weekTitle: `${weekStart.slice(5)} ~ ${days[6].date.slice(5)}`,
    days: days.map((w, i) => ({
      date: w.date,
      weekdayLabel: weekDays[i],
      dayNumber: w.dayNumber,
      isToday: w.isToday,
      sessions: demoByIndex[i].isRest ? [] : [demoByIndex[i]],
      summary: demoByIndex[i].isRest
        ? '休息'
        : demoByIndex[i].kind === 'strength'
          ? '力量'
          : demoByIndex[i].distanceKm
            ? `${demoByIndex[i].distanceKm}km`
            : '训练',
    })),
  };
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
  },

  onLoad() {
    const today = shanghaiToday();
    const user = userStore.getState().user;
    userId = user?.id ?? '';
    fetchedPlan = null;

    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
      todayYmd: today,
    });

    this.fetchPlan();
  },

  async fetchPlan() {
    if (!userId) {
      const today = shanghaiToday();
      this.setData({ ...buildDemoWeek(today), loading: false });
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
    const view = fetchedPlan
      ? buildPlanWeekView(fetchedPlan, today)
      : buildDemoWeek(today);
    this.setData({
      weekTitle: view.weekTitle,
      weekSubtitle: weekSubtitle(weekStart),
      days: view.days,
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
