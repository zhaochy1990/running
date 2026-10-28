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
  buildPushDateOptions,
  buildWeekDays,
  shanghaiToday,
  shanghaiWeekStart,
  weekSubtitle,
} from '../../utils/date';
import { fmtDose, fmtDurationShort, fmtKm, fmtPace } from '../../utils/format';
import { theme } from '../../utils/theme';
import { userStore } from '../../store/index';
import type { Activity } from '../../types/activity';
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
  /** 路线缩略图公开地址；室内活动/未生成/加载失败时为空串，回退 iconPath */
  thumbUrl: string;
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
    thumbUrl: a.thumb_url || '',
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
}

interface IndexPageHandlers {
  onShareAppMessage(res: WechatMiniprogram.Page.IShareAppMessageOption): WechatMiniprogram.Page.ICustomShareContent;
  onShareTimeline(): WechatMiniprogram.Page.ICustomTimelineContent;
  fetchPlan(): Promise<void>;
  fetchWeekSessions(anchorYmd: string): Promise<void>;
  renderDay(dateYmd: string, isToday: boolean): void;
  fetchDayActivities(dateYmd: string): Promise<void>;
  onMenuTap(): void;
  onWorkoutCardTap(): void;
  /** open-type=share 按钮的 catchtap：转发由 open-type 触发，这里只拦向卡片的冒泡 */
  onShareTap(): void;
  onDayTap(e: WechatMiniprogram.TouchEvent): void;
  onCoachTap(): void;
  onWatchTap(): void;
  onMoreTap(): void;
  onTodayActivityTap(e: WechatMiniprogram.TouchEvent): void;
  onThumbError(e: WechatMiniprogram.CustomEvent): void;
  onPushDateSelect(e: PushDateSelectEvent): void;
  onPushDateClose(): void;
  onDeleteWorkout(): void;
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
      tabBar.setData({ selected: 2 });
    }
    // 静默刷新（devops#698）：教练在对话里删除/改期/保存自建课后切回本 tab，
    // 课表即时反映，无需手动下拉刷新。跳过首帧（onLoad 已拉）与未加载态。
    if (planLoaded && userId) {
      void this.fetchWeekSessions(this.data.selectedDate || shanghaiToday());
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

  onMenuTap() {
    wx.showToast({ title: '暂未开放', icon: 'none' });
  },

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

  // 缩略图加载失败（网络、合法域名未配置、对象被清理）时，把该行回退到运动图标，
  // 而不是留一个空白圆槽。按 labelId 定位，不依赖 wx:for 的层级索引。
  onThumbError(e: WechatMiniprogram.CustomEvent) {
    const labelId = e.currentTarget.dataset.id as string;
    if (!labelId) return;
    this.setData({
      todayActivities: this.data.todayActivities.map((r) =>
        r.labelId === labelId && r.thumbUrl ? { ...r, thumbUrl: '' } : r,
      ),
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
});
