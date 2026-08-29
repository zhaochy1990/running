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

interface Summary {
  count: number;
  km: string;
  duration: string;
}

interface ActivitiesPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  loading: boolean;
  summary: Summary;
  rows: ActivityRow[];
}

interface ActivitiesPageHandlers {
  fetch(): Promise<void>;
  onMenuTap(): void;
  onRefresh(): void;
  onActivityTap(e: WechatMiniprogram.TouchEvent): void;
}

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
    load: fmtDose(a.training_load),
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

Page<ActivitiesPageData, ActivitiesPageHandlers>({
  data: {
    statusBarHeight: 0,
    contentPaddingTop: 232,
    loading: true,
    summary: { count: 0, km: '—', duration: '—' },
    rows: [],
  },

  onLoad() {
    const user = userStore.getState().user;
    userId = user?.id ?? '';
    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
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
      const res = await getActivities(userId, { limit: 20 });
      const monthKey = shanghaiToday().slice(0, 7);
      this.setData({
        rows: res.activities.map(toRow),
        summary: summaryFrom(res, monthKey),
        loading: false,
      });
    } catch {
      // 拉取失败时保持空态，由界面展示空态卡片。
      this.setData({ loading: false });
    }
  },

  onMenuTap() {
    wx.showToast({ title: '暂未开放', icon: 'none' });
  },

  onRefresh() {
    this.setData({ loading: true });
    this.fetch();
  },

  onActivityTap(e: WechatMiniprogram.TouchEvent) {
    const labelId = e.currentTarget.dataset.id as string;
    if (!labelId) return;
    wx.navigateTo({
      url: `/pages/activity-detail/activity-detail?labelId=${encodeURIComponent(labelId)}`,
    });
  },
});
