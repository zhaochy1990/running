import { getActivities } from '../../services/activities';
import { fmtDurationShort, fmtKm, fmtPace, fmtDose } from '../../utils/format';
import { userStore } from '../../store/index';
import type { Activity } from '../../types/activity';

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

function iconForSport(sportName: string): string {
  const n = sportName.toLowerCase();
  if (n.includes('strength')) return '/assets/icons/fitness_center.svg';
  if (n.includes('run') || n.includes('treadmill') || n.includes('trail')) {
    return '/assets/icons/directions_run.svg';
  }
  return '/assets/icons/schedule.svg';
}

function toRow(a: Activity): ActivityRow {
  return {
    labelId: a.label_id,
    name: a.name || a.sport_name,
    date: `${Number(a.date.slice(5, 7))}月${Number(a.date.slice(8))}日`,
    iconPath: iconForSport(a.sport_name),
    distanceKm: a.distance_km > 0 ? fmtKm(a.distance_m) : '—',
    duration: fmtDurationShort(a.duration_s),
    pace: fmtPace(a.avg_pace_s_km),
    avgHr: a.avg_hr != null ? `${Math.round(a.avg_hr)}` : '—',
    load: a.training_load != null ? fmtDose(a.training_load) : '—',
  };
}

function summaryFrom(activities: Activity[]): Summary {
  const total = activities.reduce(
    (acc, a) => ({
      km: acc.km + a.distance_m / 1000,
      dur: acc.dur + a.duration_s,
    }),
    { km: 0, dur: 0 },
  );
  return {
    count: activities.length,
    km: total.km > 0 ? total.km.toFixed(1) : '—',
    duration: total.dur > 0 ? fmtDurationShort(total.dur) : '—',
  };
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
      tabBar.setData({ selected: 2 });
    }
  },

  async fetch() {
    if (!userId) {
      this.setData({ loading: false });
      return;
    }
    try {
      const res = await getActivities(userId, { limit: 20 });
      this.setData({
        rows: res.activities.map(toRow),
        summary: summaryFrom(res.activities),
        loading: false,
      });
    } catch {
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

  onActivityTap() {
    // 活动详情页（pages/activity-detail）尚未实现，先占位。
    wx.showToast({ title: '详情页建设中', icon: 'none' });
  },
});
