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

// 默认数据源取不到时按设计稿渲染的占位内容（design/today.html 示例数据）。
const DEMO_WORKOUT: TodayWorkoutView = {
  title: '渐加速跑',
  sessionKind: 'run',
  iconPath: '/assets/icons/directions_run.svg',
  isRunning: true,
  intensityBars: [
    { pct: 40, dim: true },
    { pct: 60, dim: false },
    { pct: 70, dim: false },
    { pct: 80, dim: false },
    { pct: 90, dim: false },
    { pct: 90, dim: false },
    { pct: 90, dim: false },
    { pct: 90, dim: false },
  ],
  stats: [
    { value: '10.71', label: '距离(公里)' },
    { value: '00:51:21', label: '总时长' },
    { value: '30.8', label: '训练负荷' },
  ],
  coachNote:
    '本节课重点在于维持间歇段的配速稳定性，心率控制在 Z4 区间。若感不适可适当延长恢复时间。',
  note: '',
};

const DEMO_NUTRITION: TodayNutritionView = {
  targetsTop: [
    { value: '3100', label: '目标热量(kcal)' },
    { value: '360', label: '碳水(g)' },
    { value: '145', label: '蛋白质(g)' },
  ],
  targetsBottom: [
    { value: '85', label: '脂肪(g)' },
    { value: '3200', label: '饮水(ml)' },
  ],
  meals: [
    {
      name: '早餐：全麦贝果鸡蛋',
      timeHint: '07:00',
      detail: '全麦贝果1个、鸡蛋2个、牛油果半颗、牛奶200ml',
      kcal: '700 kcal',
    },
    {
      name: '午餐：米饭鸡胸蔬菜',
      timeHint: '12:30',
      detail: '米饭200g、鸡胸肉150g、胡萝卜、豆角',
      kcal: '900 kcal',
    },
    {
      name: '跑前加餐：香蕉面包',
      timeHint: '跑前60分钟',
      detail: '香蕉1根、全麦面包1片、果酱少量',
      kcal: '400 kcal',
    },
    {
      name: '晚餐：三文鱼红薯蔬菜',
      timeHint: '18:30',
      detail: '三文鱼170g、红薯250g、芦笋、叶菜',
      kcal: '1100 kcal',
    },
  ],
  note: '质量训练日保证训练前能量，训练后补充蛋白质与碳水。',
};

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
    workout: DEMO_WORKOUT,
    nutrition: DEMO_NUTRITION,
    loading: true,
  },

  onLoad() {
    const today = shanghaiToday();
    const weekStart = shanghaiWeekStart(today);
    const user = userStore.getState().user;
    userId = user?.id ?? '';

    const view = buildDemoView(today, weekStart);
    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
      ...view,
    });

    this.fetchPlan();
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
      // 拉取失败（未生成计划 / 网络问题）时保留设计稿占位内容。
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
        workout: isToday ? DEMO_WORKOUT : null,
        nutrition: isToday ? DEMO_NUTRITION : null,
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

function buildDemoView(
  today: string,
  weekStart: string,
): {
  weekDays: TodayWeekDay[];
  weekSubtitle: string;
  todayYmd: string;
  selectedDate: string;
  todayLabel: string;
  workout: TodayWorkoutView | null;
  nutrition: TodayNutritionView | null;
} {
  return {
    weekDays: buildWeekDays(today),
    weekSubtitle: weekSubtitle(weekStart),
    todayYmd: today,
    selectedDate: today,
    todayLabel: todayLabelOf(today),
    workout: DEMO_WORKOUT,
    nutrition: DEMO_NUTRITION,
  };
}
