import { getActivityDetail } from '../../services/activities';
import { fmtDurationShort, fmtKm, fmtHms, fmtDose } from '../../utils/format';
import { shanghaiDateFromIso, shanghaiTimeFromIso } from '../../utils/date';
import { userStore } from '../../store/index';
import type {
  Activity,
  ActivityDetailResponse,
  ActivityStrideTrainingLoad,
  Lap,
  Segment,
  Zone,
} from '../../types/activity';

// ---------------------------------------------------------------------------
// 视图模型
// ---------------------------------------------------------------------------

interface Metric {
  label: string;
  value: string;
  unit?: string;
  /** 用于主指标上色（配速/心率等），空则用默认色 */
  color?: string;
}

interface ZoneBar {
  key: string;
  label: string; // 区间文字，如「< 130」/「130 - 140」
  percent: number; // 0-100
  duration: string;
}

interface LapRow {
  index: string;
  distanceKm: string;
  pace: string;
  hr: string;
  duration: string;
}

interface ExerciseGroup {
  key: string;
  name: string;
  sets: number;
  duration: string;
  avgHr: string;
}

interface LoadItem {
  label: string;
  value: string;
}

interface WeatherItem {
  label: string;
  value: string;
}

interface HeaderView {
  sportLabel: string;
  name: string;
  dateLabel: string;
  trainTypeLabel: string;
  feelEmoji: string;
}

interface StrideLoadView {
  included: boolean;
  items: LoadItem[];
  reasons: string[];
  sessionClass: string;
}

interface ActivityDetailPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  loading: boolean;
  notFound: boolean;
  isStrength: boolean;
  header: HeaderView;
  metrics: Metric[];
  secondary: Metric[];
  strideLoad: StrideLoadView | null;
  hasZones: boolean;
  hrZones: ZoneBar[];
  paceZones: ZoneBar[];
  laps: LapRow[];
  segments: ExerciseGroup[];
  hasSegments: boolean;
  sportNote: string;
  hasCommentary: boolean;
  commentary: string;
  weather: WeatherItem[];
}

interface ActivityDetailPageHandlers {
  fetch(): Promise<void>;
  onBack(): void;
}

const FEEL_EMOJIS = ['', '😄', '🙂', '😐', '😞', '😫'];

const SPORT_CN: Record<string, string> = {
  Run: '跑步',
  'Indoor Run': '室内跑',
  'Trail Run': '越野跑',
  'Track Run': '田径场跑',
  Treadmill: '跑步机',
  'Strength Training': '力量训练',
  Strength: '力量训练',
  Walk: '步行',
  Hike: '徒步',
  Bike: '骑行',
  'Swim (Pool)': '泳池游泳',
  'Swim (Open Water)': '开放水域',
};

const TRAIN_TYPE_CN: Record<string, string> = {
  Base: '基础',
  'Aerobic Endurance': '有氧耐力',
  Threshold: '乳酸阈',
  Interval: '间歇',
  'VO2 Max': '最大摄氧',
  Anaerobic: '无氧',
  Sprint: '冲刺',
  Recovery: '恢复',
};

const METRIC_COLORS = {
  run: '#00e676',
  duration: '#0097a7',
  pace: '#00e676',
  hr: '#ff5252',
  calories: '#ffb300',
};

let userId = '';
let labelId = '';

// ---------------------------------------------------------------------------
// 纯格式化 helpers
// ---------------------------------------------------------------------------

function intStr(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '—' : `${Math.round(value)}`;
}

function decimalStr(value: number | null | undefined, digits = 1): string {
  return value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits);
}

function sportNameCN(name: string | null | undefined): string {
  return SPORT_CN[name || ''] || name || '活动';
}

function trainTypeCN(type: string | null | undefined): string {
  if (!type) return '';
  return TRAIN_TYPE_CN[type] || type;
}

function feelEmoji(feelType: number | null | undefined): string {
  if (feelType == null) return '';
  return FEEL_EMOJIS[feelType] || '';
}

function dateLabelOf(iso: string | null | undefined): string {
  const d = shanghaiDateFromIso(iso);
  if (!d) return '';
  const m = Number(d.slice(5, 7));
  const day = Number(d.slice(8));
  const dateCN = `${m}月${day}日`;
  const t = shanghaiTimeFromIso(iso);
  return t ? `${dateCN} ${t}` : dateCN;
}

function metric(label: string, value: string, unit?: string, color?: string): Metric {
  return { label, value, unit, color };
}

function isStrengthActivity(a: Activity): boolean {
  return a.sport_type === 402 || a.sport_type === 800;
}

// ---------------------------------------------------------------------------
// 主/次指标
// ---------------------------------------------------------------------------

function buildMetrics(a: Activity, isStrength: boolean): { metrics: Metric[]; secondary: Metric[] } {
  const metrics: Metric[] = [];
  const secondary: Metric[] = [];

  if (!isStrength) {
    metrics.push(metric('距离', a.distance_km > 0 ? `${a.distance_km}` : '—', 'km', METRIC_COLORS.run));
    metrics.push(metric('平均配速', a.pace_fmt || '—', undefined, METRIC_COLORS.pace));
  }
  metrics.push(metric('时长', a.duration_fmt || fmtHms(a.duration_s), undefined, METRIC_COLORS.duration));
  metrics.push(metric('平均心率', intStr(a.avg_hr), 'bpm', METRIC_COLORS.hr));
  metrics.push(metric('最大心率', intStr(a.max_hr), 'bpm', METRIC_COLORS.hr));
  metrics.push(metric('卡路里', intStr(a.calories_kcal), 'kcal', METRIC_COLORS.calories));

  if (!isStrength) {
    secondary.push(metric('步频', `${intStr(a.avg_cadence)}`, 'spm'));
    secondary.push(metric('累计爬升', `${intStr(a.ascent_m)}`, 'm'));
  }
  secondary.push(metric('手表负荷', decimalStr(a.training_load, 0)));
  if (!isStrength) secondary.push(metric('最大摄氧量', decimalStr(a.vo2max)));
  secondary.push(metric('有氧效果', decimalStr(a.aerobic_effect)));
  secondary.push(metric('无氧效果', decimalStr(a.anaerobic_effect)));

  return { metrics, secondary };
}

// ---------------------------------------------------------------------------
// 区间 / 分段
// ---------------------------------------------------------------------------

// ms/km → 分钟:秒（如 340000 → 5:40）。非法/缺失返回 ''。
function fmtPaceBound(msPerKm: number | null | undefined): string {
  if (msPerKm == null || !Number.isFinite(msPerKm) || msPerKm <= 0) return '';
  const s = Math.round(msPerKm / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// 心率区间标签：range_min=低边、range_max=高边（bpm）。
// 采用 STRIDE/Web 的开放边界约定：最低恢复区（zone_index 1）若与区间2共享下界，
// 视为开放恢复区 `< min`；最高区开放高边 `≥ min`。
function formatHRRange(z: Zone, peers: Zone[]): string {
  const min = z.range_min != null ? Math.round(z.range_min) : null;
  const max = z.range_max != null ? Math.round(z.range_max) : null;
  if (min == null && max == null) return '';
  if (min == null) return `< ${max}`;
  if (max == null) return `≥ ${min}`;
  const maxIdx = Math.max(...peers.map((x) => x.zone_index));
  if (z.zone_index === 1) {
    const z2 = peers.find((x) => x.zone_index === 2);
    if (z2?.range_min != null && Math.round(z2.range_min) === min) return `< ${min}`;
  }
  if (z.zone_index === maxIdx) return `≥ ${min}`;
  return `${min} - ${max}`;
}

// 配速区间标签：range_min=较慢边（更大 ms/km）、range_max=较快边（更小 ms/km）。
// 与 Web（range_min=较快）相反，故开放边取反且都基于 range_min（快慢区的入场边界）：
//   最低恢复区（zone_index1 共享慢边）→ `> 慢边`；最高区 → `< 慢边`。
function formatPaceRange(z: Zone, peers: Zone[]): string {
  const slow = z.range_min != null ? fmtPaceBound(z.range_min) : null;
  const fast = z.range_max != null ? fmtPaceBound(z.range_max) : null;
  if (slow == null && fast == null) return '';
  if (slow == null) return `< ${fast}`;
  if (fast == null) return `> ${slow}`;
  const maxIdx = Math.max(...peers.map((x) => x.zone_index));
  if (z.zone_index === 1) {
    const z2 = peers.find((x) => x.zone_index === 2);
    if (z2?.range_min != null && Math.round(z2.range_min) === Math.round(z.range_min)) return `> ${slow}`;
  }
  if (z.zone_index === maxIdx) return `< ${slow}`;
  return `${slow} - ${fast}`;
}

// COROS 配速区间默认上报 7 个（在 100% 阈值配速处多拆一档），而 COROS App 显示 6 个：
// 把 Z4 (94-100%) 与 Z5 (100-102%) 合并成一档「乳酸阈区」，再重编号 Z6→Z5、Z7→Z6。
// 仅当确实含 z4-z7 的 7 区间布局才合并，否则原样返回。
// 注意边界方向：range_min=较慢边（更大 ms/km）、range_max=较快边（更小 ms/km）。
function normalizePaceZones(zones: Zone[]): Zone[] {
  if (zones.length < 7) return zones;
  const byIdx = new Map(zones.map((z) => [z.zone_index, z]));
  const z4 = byIdx.get(4);
  const z5 = byIdx.get(5);
  const z6 = byIdx.get(6);
  const z7 = byIdx.get(7);
  if (!z4 || !z5 || !z6 || !z7) return zones;
  const merged: Zone = {
    zone_type: 'pace',
    zone_index: 4,
    range_min: z4.range_min, // 较慢边（更大 ms/km）
    range_max: z5.range_max, // 较快边（更小 ms/km）
    range_unit: 'ms/km',
    duration_s: (z4.duration_s ?? 0) + (z5.duration_s ?? 0),
    percent: (z4.percent ?? 0) + (z5.percent ?? 0),
  };
  return [byIdx.get(1)!, byIdx.get(2)!, byIdx.get(3)!, merged, { ...z6, zone_index: 5 }, { ...z7, zone_index: 6 }];
}

function formatZoneRange(z: Zone, peers: Zone[]): string {
  if (z.zone_type === 'pace') {
    if (z.range_unit === 'ms/km') {
      // 高驰（COROS）配速以 ms/km 表达，转成「分钟:秒/公里」；
      // 佳明等其他表不落此单位，不套用 COROS 换算。
      const r = formatPaceRange(z, peers);
      return r ? `${r}/km` : `Z${z.zone_index + 1}`;
    }
    return rawPaceRange(z);
  }
  const r = formatHRRange(z, peers);
  return r ? `${r} bpm` : `Z${z.zone_index + 1}`;
}

// 非高驰配速区间（单位非 ms/km，如未来佳明 m/s）的兜底展示：原始值 + 单位。
function rawPaceRange(z: Zone): string {
  const unit = z.range_unit ? ` ${z.range_unit}` : '';
  const lo = z.range_min != null ? `${z.range_min}` : '';
  const hi = z.range_max != null ? `${z.range_max}` : '';
  if (lo && hi) return `${lo} - ${hi}${unit}`;
  if (lo) return `< ${lo}${unit}`;
  if (hi) return `> ${hi}${unit}`;
  return `Z${z.zone_index + 1}`;
}

function toZoneBar(z: Zone, peers: Zone[]): ZoneBar {
  const percent = z.percent != null ? Math.max(0, Math.min(100, z.percent)) : 0;
  return {
    key: `${z.zone_type}-${z.zone_index}`,
    label: formatZoneRange(z, peers),
    percent,
    duration: z.duration_s != null && z.duration_s > 0 ? fmtDurationShort(z.duration_s) : '—',
  };
}

function buildZones(zones: Zone[]): { hrZones: ZoneBar[]; paceZones: ZoneBar[]; hasZones: boolean } {
  // 手表上报区间本身就是完整分区（含开放边界的最快/最慢区），每个 zone_index 一行，
  // 开放边由 formatHRRange/formatPaceRange 处理；配速只对高驰（ms/km）做 7→6 归一化合并阈值区。
  const hr = zones.filter((z) => z.zone_type === 'heartRate');
  const paceRaw = zones.filter((z) => z.zone_type === 'pace');
  const isCorosPace = paceRaw.length > 0 && paceRaw.every((z) => z.range_unit === 'ms/km');
  const pace = isCorosPace ? normalizePaceZones(paceRaw) : paceRaw;
  const hrZones = hr.map((z) => toZoneBar(z, hr));
  const paceZones = pace.map((z) => toZoneBar(z, pace));
  return { hrZones, paceZones, hasZones: hrZones.length > 0 || paceZones.length > 0 };
}

function toLapRow(lap: Lap, index: number): LapRow {
  return {
    index: `${index + 1}`,
    distanceKm: lap.distance_km != null && lap.distance_km > 0 ? `${lap.distance_km.toFixed(2)}` : '—',
    pace: lap.pace_fmt || '—',
    hr: intStr(lap.avg_hr),
    duration: lap.duration_fmt || '—',
  };
}

function isRestSegment(seg: Segment): boolean {
  return seg.seg_name === '休息' || seg.mode === 15 || seg.mode === 16 || seg.mode === 17;
}

interface GroupAcc {
  name: string;
  sets: number;
  durationS: number;
  hrSum: number;
  hrCount: number;
}

function buildStrengthSegments(segments: Segment[]): ExerciseGroup[] {
  const groups: GroupAcc[] = [];
  let current: GroupAcc | null = null;

  for (const seg of segments) {
    if (isRestSegment(seg)) continue;
    const name = seg.seg_name || '训练';
    if (current && current.name === name) {
      current.sets += 1;
      current.durationS += seg.duration_s ?? 0;
      if (seg.avg_hr != null) {
        current.hrSum += seg.avg_hr;
        current.hrCount += 1;
      }
    } else {
      current = {
        name,
        sets: 1,
        durationS: seg.duration_s ?? 0,
        hrSum: seg.avg_hr ?? 0,
        hrCount: seg.avg_hr != null ? 1 : 0,
      };
      groups.push(current);
    }
  }

  return groups.map((g, i) => ({
    key: `${i}`,
    name: g.name,
    sets: g.sets,
    duration: g.durationS > 0 ? fmtDurationShort(g.durationS) : '—',
    avgHr: g.hrCount > 0 ? `${Math.round(g.hrSum / g.hrCount)}` : '—',
  }));
}

// ---------------------------------------------------------------------------
// STRIDE 客观负荷 / 天气
// ---------------------------------------------------------------------------

function buildStrideLoad(load: ActivityStrideTrainingLoad | null | undefined): StrideLoadView | null {
  if (!load) return null;
  const items: LoadItem[] = [
    { label: '训练剂量', value: fmtDose(load.training_dose) },
    { label: 'Cardio TSS', value: fmtDose(load.cardio_tss) },
    { label: 'External TSS', value: fmtDose(load.external_tss) },
    { label: '高强度加成', value: fmtDose(load.high_intensity_tss) },
    { label: '机械负荷', value: fmtDose(load.mechanical_load) },
    { label: '置信度', value: load.load_confidence || '—' },
    { label: '分类', value: load.session_class || '—' },
  ];
  return {
    included: !load.excluded_from_pmc,
    items,
    reasons: load.reasons.length > 0 ? load.reasons : ['无触发'],
    sessionClass: load.session_class || '—',
  };
}

function buildWeather(a: Activity): WeatherItem[] {
  const out: WeatherItem[] = [];
  if (a.temperature != null) {
    let value = `${a.temperature}°C`;
    if (a.feels_like != null && a.feels_like !== a.temperature) {
      value += `（体感 ${a.feels_like}°C）`;
    }
    out.push({ label: '温度', value });
  }
  if (a.humidity != null) out.push({ label: '湿度', value: `${a.humidity}%` });
  if (a.wind_speed != null && a.wind_speed > 0) {
    out.push({ label: '风速', value: `${a.wind_speed} km/h` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 组装视图
// ---------------------------------------------------------------------------

function buildView(detail: ActivityDetailResponse): Partial<ActivityDetailPageData> {
  const a = detail.activity;
  const isStrength = isStrengthActivity(a);
  const { metrics, secondary } = buildMetrics(a, isStrength);
  const { hrZones, paceZones, hasZones } = buildZones(detail.zones || []);

  let laps: LapRow[] = [];
  let segments: ExerciseGroup[] = [];
  let hasSegments = false;
  if (isStrength) {
    segments = buildStrengthSegments(detail.segments || []);
    hasSegments = segments.length > 0;
  } else {
    // v1 只展示自动公里圈速表；type2 分段合并到圈速的可预览阶段再补。
    laps = (detail.laps || []).map((lap, i) => toLapRow(lap, i));
    hasSegments = laps.length > 0;
  }

  const strideLoad = buildStrideLoad(detail.stride_training_load);
  const sportNote = a.sport_note || '';

  return {
    isStrength,
    header: {
      sportLabel: sportNameCN(a.sport_name),
      name: (a.name && a.name.trim()) || sportNameCN(a.sport_name),
      dateLabel: dateLabelOf(a.date),
      trainTypeLabel: trainTypeCN(a.train_type),
      feelEmoji: feelEmoji(a.feel_type),
    },
    metrics,
    secondary,
    strideLoad,
    hasZones,
    hrZones,
    paceZones,
    laps,
    segments,
    hasSegments,
    sportNote,
    hasCommentary: Boolean(a.commentary && a.commentary.trim()),
    commentary: a.commentary || '',
    weather: buildWeather(a),
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

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

Page<ActivityDetailPageData, ActivityDetailPageHandlers>({
  data: {
    statusBarHeight: 0,
    contentPaddingTop: 232,
    loading: true,
    notFound: false,
    isStrength: false,
    header: { sportLabel: '', name: '', dateLabel: '', trainTypeLabel: '', feelEmoji: '' },
    metrics: [],
    secondary: [],
    strideLoad: null,
    hasZones: false,
    hrZones: [],
    paceZones: [],
    laps: [],
    segments: [],
    hasSegments: false,
    sportNote: '',
    hasCommentary: false,
    commentary: '',
    weather: [],
  },

  onLoad(options: Record<string, string | undefined>) {
    userId = userStore.getState().user?.id ?? '';
    labelId = options.labelId || '';

    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
    });

    if (!labelId) {
      this.setData({ loading: false, notFound: true });
      return;
    }

    // 先等认证流程 settle 再拉详情，避免首屏请求在登录完成前发出被 401。
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

  async fetch() {
    if (!userId || !labelId) {
      this.setData({ loading: false, notFound: true });
      return;
    }
    try {
      const detail = await getActivityDetail(userId, labelId);
      this.setData({
        ...buildView(detail),
        loading: false,
        notFound: false,
      });
    } catch {
      // 详情不存在（404）或网络失败都归到「未找到」空态。
      this.setData({ loading: false, notFound: true });
    }
  },

  onBack() {
    wx.navigateBack();
  },
});
