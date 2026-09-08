import { getActivities } from '../../services/activities';
import { fmtDurationShort, fmtKm, fmtPace, fmtDose } from '../../utils/format';
import { shanghaiToday, shanghaiWeekdayLabel } from '../../utils/date';
import { userStore } from '../../store/index';
import type { Activity, ActivitiesListResponse } from '../../types/activity';

interface ActivityRow {
  labelId: string;
  name: string;
  date: string; // 用于显示的日期（已转上海）
  iconPath: string;
  distanceKm: string;
  duration: string;
  pace: string;
  avgHr: string;
  load: string;
}

/** 一组可折叠的月份：头部展示该月汇总，展开后展示活动列表。 */
interface MonthGroup {
  monthKey: string; // YYYY-MM
  label: string; // 如「2026年3月」
  expanded: boolean;
  count: string;
  km: string;
  duration: string;
  rows: ActivityRow[];
}

interface Summary {
  count: number;
  km: string;
  duration: string;
}

interface ActivitiesPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  loading: boolean;
  /** 本月（上海）YYYY-MM，默认展开该月份 */
  currentMonth: string;
  /** 按月份折叠的分组列表（月份倒序） */
  monthGroups: MonthGroup[];
  /** 完全没有活动记录时的空态标题 */
  emptyTitle: string;
  /** 后端总记录数 */
  total: number;
  /** 已加载记录数 */
  loadedCount: number;
  /** 是否还有更早的记录可加载 */
  hasMore: boolean;
  /** 正在加载更早记录 */
  loadingMore: boolean;
}

interface ActivitiesPageHandlers {
  fetch(): Promise<void>;
  onMenuTap(): void;
  onActivityTap(e: WechatMiniprogram.TouchEvent): void;
  onMonthHeaderTap(e: WechatMiniprogram.TouchEvent): void;
  onLoadMore(): void;
  onPullDownRefresh(): void;
}

let userId = '';

// 每次拉取的活动条数（分页步长）。
const PAGE_SIZE = 100;

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

// 活动图标：sport_name 可为 null/undefined（后端对个别活动返回 null），必须兜底，
// 否则 null.toLowerCase() 会抛错，导致 res.activities.map(toRow) 整体中断、
// setData 不执行，页面停留在空态（「拿到了数据却不渲染」的根因）。
function iconPathForSport(sportName: string | null | undefined): string {
  const n = (sportName || '').toLowerCase();
  if (n.includes('strength')) return '/assets/icons/fitness_center.svg';
  if (n.includes('run') || n.includes('treadmill') || n.includes('trail')) {
    return '/assets/icons/directions_run.svg';
  }
  return '/assets/icons/schedule.svg';
}

// 展示名：name 缺失时回退到 sport_name；两者都缺失给「活动」占位（避免空行）。
function displayName(a: Activity): string {
  const n = a.name && a.name.trim();
  if (n) return n;
  const s = a.sport_name && a.sport_name.trim();
  return s || '活动';
}

// 「2026-08-28」/「2026-08-28T08:30:00+08:00」→「8月28日 周三」；缺失/非法时兜底返回原串或空串，绝不抛错。
function formatDateLabel(ymd: string | null | undefined): string {
  if (!ymd) return '';
  const datePart = String(ymd).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return datePart;
  const m = Number(datePart.slice(5, 7));
  const d = Number(datePart.slice(8));
  const weekday = shanghaiWeekdayLabel(datePart);
  return weekday ? `${m}月${d}日 ${weekday}` : `${m}月${d}日`;
}

function toRow(a: Activity): ActivityRow {
  return {
    labelId: a.label_id,
    name: displayName(a),
    date: formatDateLabel(a.date),
    iconPath: iconPathForSport(a.sport_name),
    distanceKm: a.distance_km != null && a.distance_km > 0 ? fmtKm(a.distance_m) : '—',
    duration: fmtDurationShort(a.duration_s),
    pace: fmtPace(a.avg_pace_s_km),
    avgHr: a.avg_hr != null ? `${Math.round(a.avg_hr)}` : '—',
    // 优先展示 STRIDE 自身计算的负荷（training_dose）；缺失时回退到手表上报值。
    load: fmtDose(a.stride_training_dose ?? a.training_load),
  };
}

function summarizeActivities(activities: Activity[]): Summary {
  const total = activities.reduce(
    (acc, a) => ({
      km: acc.km + (a.distance_m ?? 0) / 1000,
      dur: acc.dur + (a.duration_s ?? 0),
    }),
    { km: 0, dur: 0 },
  );
  return {
    count: activities.length,
    km: total.km > 0 ? total.km.toFixed(1) : '—',
    duration: total.dur > 0 ? fmtDurationShort(total.dur) : '—',
  };
}

// 优先用后端每月聚合（整月统计，不只本页）；后端未返回时回退到本页当月的活动。
function summaryFrom(res: ActivitiesListResponse, monthKey: string): Summary {
  const monthSummary = res.monthly_summaries?.[monthKey];
  if (monthSummary) {
    return {
      count: monthSummary.activity_count,
      km: monthSummary.total_run_km > 0 ? monthSummary.total_run_km.toFixed(1) : '—',
      duration: monthSummary.duration_s > 0 ? fmtDurationShort(monthSummary.duration_s) : '—',
    };
  }
  const monthActivities = res.activities.filter((a) => (a.date || '').slice(0, 7) === monthKey);
  return summarizeActivities(monthActivities);
}

// 「2026-03」→「2026年3月」；非法输入原样返回，绝不抛错。
function monthLabel(monthKey: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) return monthKey;
  return `${m[1]}年${Number(m[2])}月`;
}

// 把一页活动按上海月份分组（倒序），默认本月展开。月份汇总优先用后端整月统计。
function buildMonthGroups(res: ActivitiesListResponse, currentMonth: string): MonthGroup[] {
  const byMonth = new Map<string, Activity[]>();
  for (const a of res.activities) {
    const key = (a.date || '').slice(0, 7);
    if (!key) continue;
    const arr = byMonth.get(key);
    if (arr) {
      arr.push(a);
    } else {
      byMonth.set(key, [a]);
    }
  }

  return Array.from(byMonth.keys())
    .sort()
    .reverse()
    .map((monthKey) => {
      const acts = byMonth.get(monthKey)!;
      const s = summaryFrom(res, monthKey);
      return {
        monthKey,
        label: monthLabel(monthKey),
        expanded: monthKey === currentMonth,
        count: String(s.count),
        km: s.km,
        duration: s.duration,
        rows: acts.map(toRow),
      };
    });
}

// 把下一页（更早）活动合并进已有分组：先建的月份组按倒序排在后面，
// 已有组追加行、新月份新增组（折叠）。月份汇总优先用后端整月统计（幂等），缺失时用本页该月活动兜底。
function mergeMonthGroups(existing: MonthGroup[], res: ActivitiesListResponse): MonthGroup[] {
  const groups = existing.map((g) => ({ ...g, rows: [...g.rows] }));
  const byMonth = new Map<string, MonthGroup>();
  for (const g of groups) byMonth.set(g.monthKey, g);

  for (const a of res.activities) {
    const monthKey = (a.date || '').slice(0, 7);
    if (!monthKey) continue;
    let g = byMonth.get(monthKey);
    if (!g) {
      g = {
        monthKey,
        label: monthLabel(monthKey),
        expanded: false,
        count: '0',
        km: '—',
        duration: '—',
        rows: [],
      };
      byMonth.set(monthKey, g);
      groups.push(g);
    }
    g.rows.push(toRow(a));
  }

  const summaries = res.monthly_summaries ?? {};
  for (const g of groups) {
    const ms = summaries[g.monthKey];
    if (ms) {
      g.count = String(ms.activity_count);
      g.km = ms.total_run_km > 0 ? ms.total_run_km.toFixed(1) : '—';
      g.duration = ms.duration_s > 0 ? fmtDurationShort(ms.duration_s) : '—';
    } else {
      const acts = res.activities.filter((a) => (a.date || '').slice(0, 7) === g.monthKey);
      if (acts.length) {
        const s = summarizeActivities(acts);
        g.count = String(s.count);
        g.km = s.km;
        g.duration = s.duration;
      }
    }
  }
  return groups;
}

Page<ActivitiesPageData, ActivitiesPageHandlers>({
  data: {
    statusBarHeight: 0,
    contentPaddingTop: 232,
    loading: true,
    currentMonth: '',
    monthGroups: [],
    emptyTitle: '暂无活动记录',
    total: 0,
    loadedCount: 0,
    hasMore: false,
    loadingMore: false,
  },

  onLoad() {
    const user = userStore.getState().user;
    userId = user?.id ?? '';
    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
      currentMonth: shanghaiToday().slice(0, 7),
    });

    // 先等认证流程 settle 再拉真实活动，避免首屏请求在登录完成前发出被 401。
    userStore.waitForAuth().then(() => {
      const { user, isAuthenticated } = userStore.getState();
      if (!isAuthenticated || !user) {
        wx.reLaunch({ url: '/pages/login/login' });
        return;
      }
      userId = user.id;
      this.fetch();
    });
  },

  onShow() {
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) {
      tabBar.setData({ selected: 1 });
    }
  },

  async fetch() {
    if (!userId) {
      this.setData({ loading: false });
      return;
    }
    try {
      // 拉最近一页活动，跨月份分组展示；月份汇总由后端整月统计给出。
      const res = await getActivities(userId, { limit: PAGE_SIZE, offset: 0 });
      const monthGroups = buildMonthGroups(res, this.data.currentMonth);
      this.setData({
        monthGroups,
        total: res.total,
        loadedCount: res.activities.length,
        hasMore: res.activities.length < res.total,
        emptyTitle: '暂无活动记录',
        loading: false,
        loadingMore: false,
      });
    } catch {
      // 拉取失败时保持空态，由界面展示空态卡片。
      this.setData({ loading: false, loadingMore: false });
    }
  },

  onMenuTap() {
    wx.showToast({ title: '暂未开放', icon: 'none' });
  },

  onPullDownRefresh() {
    this.fetch().finally(() => wx.stopPullDownRefresh());
  },

  onActivityTap(e: WechatMiniprogram.TouchEvent) {
    const labelId = e.currentTarget.dataset.id as string;
    if (!labelId) return;
    wx.navigateTo({
      url: `/pages/activity-detail/activity-detail?labelId=${encodeURIComponent(labelId)}`,
    });
  },

  onMonthHeaderTap(e: WechatMiniprogram.TouchEvent) {
    const key = e.currentTarget.dataset.month as string;
    if (!key) return;
    const monthGroups = this.data.monthGroups.map((g) =>
      g.monthKey === key ? { ...g, expanded: !g.expanded } : g,
    );
    this.setData({ monthGroups });
  },

  async onLoadMore() {
    if (!userId || this.data.loadingMore || !this.data.hasMore) return;
    this.setData({ loadingMore: true });
    try {
      const res = await getActivities(userId, { limit: PAGE_SIZE, offset: this.data.loadedCount });
      const loadedCount = this.data.loadedCount + res.activities.length;
      this.setData({
        monthGroups: mergeMonthGroups(this.data.monthGroups, res),
        total: res.total,
        loadedCount,
        hasMore: loadedCount < res.total,
        loadingMore: false,
      });
    } catch {
      // 加载失败仅停止 loading 态，保留已加载内容。
      this.setData({ loadingMore: false });
    }
  },
});
