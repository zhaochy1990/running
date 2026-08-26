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

function demoRows(): { rows: ActivityRow[]; summary: Summary } {
  const activities: Activity[] = [
    { label_id: 'a1', name: '晨跑 · 节奏', sport_name: 'Run', sport_type: 2, date: '2026-08-26', distance_m: 8200, distance_km: 8.2, duration_s: 2525, duration_fmt: '0:42:05', avg_pace_s_km: 308, pace_fmt: '5:08/km', avg_hr: 152, max_hr: 168, avg_cadence: null, calories_kcal: null, training_load: 52.1, vo2max: null, train_type: 'Threshold' },
    { label_id: 'a2', name: '渐加速跑', sport_name: 'Run', sport_type: 2, date: '2026-08-25', distance_m: 10710, distance_km: 10.71, duration_s: 3081, duration_fmt: '0:51:21', avg_pace_s_km: 288, pace_fmt: '4:48/km', avg_hr: 160, max_hr: 175, avg_cadence: null, calories_kcal: null, training_load: 68.3, vo2max: null, train_type: 'Interval' },
    { label_id: 'a3', name: '恢复跑', sport_name: 'Run', sport_type: 2, date: '2026-08-24', distance_m: 5500, distance_km: 5.5, duration_s: 2040, duration_fmt: '0:34:00', avg_pace_s_km: 371, pace_fmt: '6:11/km', avg_hr: 132, max_hr: 145, avg_cadence: null, calories_kcal: null, training_load: 24.6, vo2max: null, train_type: 'Recovery' },
    { label_id: 'a4', name: '力量训练', sport_name: 'Strength Training', sport_type: 5, date: '2026-08-24', distance_m: 0, distance_km: 0, duration_s: 2700, duration_fmt: '0:45:00', avg_pace_s_km: null, pace_fmt: '', avg_hr: null, max_hr: null, avg_cadence: null, calories_kcal: null, training_load: 18.2, vo2max: null, train_type: null },
  ];
  return {
    rows: activities.map(toRow),
    summary: summaryFrom(activities),
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
    const demo = demoRows();
    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
      rows: demo.rows,
      summary: demo.summary,
    });
    this.fetch();
  },

  async fetch() {
    if (!userId) {
      this.setData({ loading: false });
      return;
    }
    try {
      const res = await getActivities(userId, { limit: 20 });
      const rows = res.activities.map(toRow);
      this.setData({
        rows: rows.length ? rows : this.data.rows,
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
