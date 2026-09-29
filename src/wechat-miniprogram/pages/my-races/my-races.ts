// 我的比赛页 —— 展示 race detection 自动识别的半马 / 全马参赛经历。
//
// 数据来自 GET /api/{user}/races（services/races）：同步流水线确认的比赛，
// 明细（名称/距离/用时/配速）join 自 activities。点击一行进入对应活动详情。
import { getMyRaces, type RaceItem } from '../../services/races';
import { shanghaiDateFromIso } from '../../utils/date';
import { userStore } from '../../store/index';

interface RaceRow {
  labelId: string;
  name: string;
  /** 后端 distance_band → 中文档位标签 */
  bandLabel: string;
  /** wxss class 后缀：marathon / half / other */
  bandClass: string;
  /** 上海 YYYY-MM-DD */
  dateLabel: string;
  /** 一位小数公里，如 42.2 */
  distanceKm: string;
  /** 预格式化成绩（后端 duration_fmt） */
  duration: string;
  /** 预格式化配速（后端 pace_fmt），空串隐藏 */
  pace: string;
  avgHr: string;
  ascent: string;
}

interface MyRacesPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  loading: boolean;
  error: string;
  rows: RaceRow[];
  summary: string;
}

interface MyRacesPageHandlers {
  onLoad(): void;
  onShow(): void;
  fetchRaces(): Promise<void>;
  onRaceTap(e: WechatMiniprogram.TouchEvent): void;
  onBack(): void;
}

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

function bandLabel(band: RaceItem['distance_band']): string {
  if (band === 'marathon') return '全马';
  if (band === 'half_marathon') return '半马';
  return '比赛';
}

function bandClass(band: RaceItem['distance_band']): string {
  if (band === 'marathon') return 'marathon';
  if (band === 'half_marathon') return 'half';
  return 'other';
}

function toRow(race: RaceItem): RaceRow {
  return {
    labelId: race.label_id,
    name: race.name || bandLabel(race.distance_band),
    bandLabel: bandLabel(race.distance_band),
    bandClass: bandClass(race.distance_band),
    dateLabel: shanghaiDateFromIso(race.date) || race.date,
    distanceKm: race.distance_km.toFixed(1),
    duration: race.duration_fmt,
    pace: race.pace_fmt && race.pace_fmt !== '—' ? race.pace_fmt : '',
    avgHr: race.avg_hr != null ? String(race.avg_hr) : '',
    ascent: race.ascent_m != null ? String(Math.round(race.ascent_m)) : '',
  };
}

function buildSummary(rows: RaceRow[]): string {
  const marathon = rows.filter((r) => r.bandClass === 'marathon').length;
  const half = rows.filter((r) => r.bandClass === 'half').length;
  const parts = [`共 ${rows.length} 场`];
  if (marathon > 0) parts.push(`全马 ${marathon}`);
  if (half > 0) parts.push(`半马 ${half}`);
  return parts.join(' · ');
}

Page<MyRacesPageData, MyRacesPageHandlers>({
  data: {
    statusBarHeight: 0,
    contentPaddingTop: 232,
    loading: true,
    error: '',
    rows: [],
    summary: '',
  },

  onLoad() {
    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
    });
  },

  onShow() {
    void this.fetchRaces();
  },

  async fetchRaces() {
    const userId = userStore.getState().user?.id;
    if (!userId) {
      this.setData({ loading: false, error: '请先登录' });
      return;
    }
    this.setData({ loading: true, error: '' });
    try {
      const res = await getMyRaces(userId);
      const rows = res.races.map(toRow);
      this.setData({ loading: false, rows, summary: buildSummary(rows) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败，请稍后重试';
      this.setData({ loading: false, error: msg });
    }
  },

  onRaceTap(e: WechatMiniprogram.TouchEvent) {
    const labelId = e.currentTarget.dataset.id as string;
    if (!labelId) return;
    wx.navigateTo({
      url: `/pages/activity-detail/activity-detail?labelId=${encodeURIComponent(labelId)}`,
    });
  },

  onBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/profile' }) });
  },
});
