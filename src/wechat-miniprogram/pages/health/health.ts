import { getStrideTrainingLoad } from '../../services/health';
import { fmtDose } from '../../utils/format';
import { userStore } from '../../store/index';
import type { StrideTrainingLoadRecord } from '../../types/health';

interface HealthStat {
  value: string;
  label: string;
  sub?: string;
}

interface HealthPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  loading: boolean;
  formZone: string;
  formColor: string;
  heroText: string;
  heroSub: string;
  stats: HealthStat[];
  trend: number[]; // 近 14 天 form 值，用于迷你柱状图
  hasData: boolean;
}

interface HealthPageHandlers {
  fetch(): Promise<void>;
  render(): void;
  onMenuTap(): void;
  onReadinessTap(): void;
}

let current: StrideTrainingLoadRecord | null = null;
let userId = '';
let loaded = false;

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

function classifyForm(ratio: number | null): { zone: string; color: string; text: string } {
  if (ratio == null || !Number.isFinite(ratio)) {
    return { zone: '待评估', color: '#9C9C9D', text: '数据不足，正在积累训练样本' };
  }
  if (ratio < 0.75) return { zone: '减量过多', color: '#55B3FF', text: '负荷偏低，注意保持训练连贯性' };
  if (ratio < 0.9) return { zone: '比赛就绪', color: '#5FC992', text: '恢复充分，身体状态处于比赛窗口' };
  if (ratio <= 1.1) return { zone: '维持期', color: '#FFB3AF', text: '急性≈慢性，体能维持平衡' };
  if (ratio <= 1.25) return { zone: '提升期', color: '#FF8A3D', text: '急性>慢性，正在驱动体能进步' };
  return { zone: '过度负荷', color: '#FF5252', text: '负荷偏高，注意监控疲劳与恢复' };
}

function heroTitleFor(record: StrideTrainingLoadRecord): { text: string; sub: string } {
  if (record.readiness_gate === 'ready') return { text: '今天状态良好', sub: '可按计划完成训练' };
  if (record.readiness_gate === 'caution') return { text: '今天需要谨慎', sub: '建议降低强度或增加恢复' };
  return { text: '状态待观察', sub: '继续跟踪身体信号' };
}

function demoData(): { stats: HealthStat[]; trend: number[]; formZone: string; formColor: string; heroText: string; heroSub: string } {
  // 示意：慢性 70 / 急性 75 / form 5（ratio≈1.07 → 维持期）
  const cf = classifyForm(75 / 70);
  return {
    stats: [
      { value: '70', label: '慢性负荷' },
      { value: '75', label: '急性负荷' },
      { value: '+5', label: 'form' },
      { value: '62', label: '静息心率' },
    ],
    trend: [6, 8, 5, 10, 7, 4, 9, 6, 3, 5, 8, 4, 7, 5],
    formZone: cf.zone,
    formColor: cf.color,
    heroText: '今天状态良好',
    heroSub: '可按计划完成训练',
  };
}

function buildFromRecord(record: StrideTrainingLoadRecord | null): {
  stats: HealthStat[];
  trend: number[];
  formZone: string;
  formColor: string;
  heroText: string;
  heroSub: string;
} {
  if (!record) return demoData();
  const ratio = record.load_ratio;
  const cf = classifyForm(ratio);
  const hero = heroTitleFor(record);
  return {
    stats: [
      { value: record.chronic_load != null ? fmtDose(record.chronic_load) : '—', label: '慢性负荷' },
      { value: record.acute_load != null ? fmtDose(record.acute_load) : '—', label: '急性负荷' },
      { value: record.form != null ? `${record.form > 0 ? '+' : ''}${Math.round(record.form)}` : '—', label: 'form' },
      { value: cf.zone, label: '状态', sub: cf.text },
    ],
    trend: [],
    formZone: cf.zone,
    formColor: cf.color,
    heroText: hero.text,
    heroSub: hero.sub,
  };
}

Page<HealthPageData, HealthPageHandlers>({
  data: {
    statusBarHeight: 0,
    contentPaddingTop: 232,
    loading: true,
    formZone: '维持期',
    formColor: '#FFB3AF',
    heroText: '今天状态良好',
    heroSub: '可按计划完成训练',
    stats: [],
    trend: [],
    hasData: false,
  },

  onLoad() {
    const user = userStore.getState().user;
    userId = user?.id ?? '';
    current = null;
    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
    });
    this.fetch();
  },

  async fetch() {
    if (!userId) {
      const demo = demoData();
      this.setData({ ...demo, loading: false, hasData: true });
      return;
    }
    try {
      const res = await getStrideTrainingLoad(userId, 30);
      current = res.current;
      loaded = true;
    } catch {
      loaded = false;
    } finally {
      this.render();
    }
  },

  render() {
    const v = buildFromRecord(current);
    this.setData({
      ...v,
      hasData: loaded,
      loading: false,
    });
  },

  onMenuTap() {
    wx.showToast({ title: '暂未开放', icon: 'none' });
  },

  onReadinessTap() {
    // 健康趋势详情页未实现，先占位。
    wx.showToast({ title: '趋势详情建设中', icon: 'none' });
  },
});
