import { getActivityDetail } from '../../services/activities';
import { fmtDurationShort, fmtKm, fmtHms, fmtPaceQuote, fmtPaceQuoteParts } from '../../utils/format';
import { shanghaiDateFromIso, shanghaiTimeFromIso } from '../../utils/date';
import { wgs84ToGcj02 } from '../../utils/coord';
import { lapPaceMarks } from '../../utils/lapRows';
import { userStore } from '../../store/index';
import type {
  Activity,
  ActivityDetailResponse,
  Segment,
  Zone,
  TimeseriesPoint,
  Pause,
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
  duration: string;
  distanceKm: string;
  /** 平均配速拆成分钟 / `'SS"` 两段，便于按 `'` 对齐 */
  paceMin: string;
  paceSec: string;
  /** 配速走向（与上一圈比较）→ /assets/icons/trend_{{trend}}.svg：'' | 'up' | 'down' */
  paceTrend: string;
  /** 心率走向（与上一圈比较）：'' | 'up' | 'down' */
  hrTrend: string;
  /** 整行高亮：'' | 'lap-row--fastest' | 'lap-row--slowest' */
  rowClass: string;
  /** 圈数徽标 */
  tag: string;
  tagClass: string;
  hr: string;
  cadence: string;
}

interface ExerciseGroup {
  key: string;
  name: string;
  sets: number;
  duration: string;
  avgHr: string;
}

interface WeatherItem {
  key: string;
  icon: string;
  value: string;
}

// —— 轨迹地图（原生 <map>，腾讯瓦片）——
type MapColoring = 'none' | 'hr' | 'pace';

interface MapPoint {
  latitude: number;
  longitude: number;
  pace: number | null; // s/km，lower = faster
  hr: number | null;
}

interface MapPolyline {
  points: Array<{ latitude: number; longitude: number }>;
  color: string;
  width: number;
}

// 起终点 + 圈号都用原生 <map> 的 marker 画（iconPath 必须是图片，不吃 svg）：
// 起终点直接拿图标 png 当图标，圈号靠 label（1×1 透明 png 占位）。
interface MapMarker {
  id: number;
  latitude: number;
  longitude: number;
  iconPath: string;
  width: number;
  height: number;
  anchor: { x: number; y: number };
  label?: {
    content: string;
    color: string;
    fontSize: number;
    bgColor: string;
    borderColor: string;
    borderWidth: number;
    borderRadius: number;
    padding: number;
    anchorX: number;
    anchorY: number;
    textAlign: 'center';
  };
  zIndex: number;
}

interface HeaderView {
  sportLabel: string;
  name: string;
  dateLabel: string;
  trainTypeLabel: string;
  feelEmoji: string;
}

interface ActivityDetailPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  loading: boolean;
  notFound: boolean;
  isStrength: boolean;
  header: HeaderView;
  metrics: Metric[];
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
  // —— 轨迹地图 ——
  hasMap: boolean;
  mapLatitude: number;
  mapLongitude: number;
  mapPolylines: MapPolyline[];
  mapMarkers: MapMarker[];
  mapFitPoints: Array<{ latitude: number; longitude: number }>;
  mapColoring: MapColoring;
}

interface ActivityDetailPageHandlers {
  fetch(): Promise<void>;
  onBack(): void;
  onColoringChange(e: { currentTarget: { dataset: { coloring: MapColoring } } }): void;
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
};

let userId = '';
let labelId = '';

// —— 轨迹地图常量 / 状态 ——
const MAP_GREEN = '#00a85a';
const MAP_AMBER = '#e68a00';
const MAP_RED = '#d32f2f';
const MAX_MAP_PTS = 600; // 抽稀后点上限
const MAP_CHUNK = 8; // 每段 bin 成多长（条）

// 按 pause 分段的 GCJ 轨迹点（模块级缓存，供着色切换时重建）。
let mapSegments: MapPoint[][] = [];

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

function buildMetrics(a: Activity, isStrength: boolean): Metric[] {
  const metrics: Metric[] = [];

  if (!isStrength) {
    metrics.push(metric('距离', a.distance_km > 0 ? `${a.distance_km}` : '—', 'km', METRIC_COLORS.run));
    metrics.push(metric('平均配速', fmtPaceQuote(a.avg_pace_s_km), undefined, METRIC_COLORS.pace));
  }
  metrics.push(metric('平均心率', intStr(a.avg_hr), 'bpm', METRIC_COLORS.hr));
  metrics.push(metric('训练负荷', decimalStr(a.training_load, 0)));
  metrics.push(metric('时长', a.duration_fmt || fmtHms(a.duration_s), undefined, METRIC_COLORS.duration));
  metrics.push(metric('最大心率', intStr(a.max_hr), 'bpm', METRIC_COLORS.hr));
  if (!isStrength) {
    metrics.push(metric('平均步幅', stepLenM(a.avg_step_len_cm), 'm'));
    metrics.push(metric('平均步频', intStr(a.avg_cadence), 'spm'));
    metrics.push(metric('累计爬升', intStr(a.ascent_m), 'm'));
  }

  return metrics;
}

/** 步幅 cm → m（保留两位），缺失返回 '—'。 */
function stepLenM(cm: number | null | undefined): string {
  return cm == null || !Number.isFinite(cm) ? '—' : (cm / 100).toFixed(2);
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
    // 高驰 watch 区间为 ms/km；STRIDE calibration（activity_zones 表）为 pace（值仍是 ms/km），
    // 两者同为 ms/km 量级，统一按「分钟:秒/公里」转换。佳明若以 m/s 等其它单位上报则不走这里。
    if (z.range_unit === 'ms/km' || z.range_unit === 'pace') {
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
  // 开放边由 formatHRRange/formatPaceRange 处理；配速只对高驰（ms/km）或 STRIDE（pace）做 7→6 归一化合并阈值区。
  const hr = zones.filter((z) => z.zone_type === 'heartRate');
  const paceRaw = zones.filter((z) => z.zone_type === 'pace');
  const isCorosPace = paceRaw.length > 0 && paceRaw.every((z) => z.range_unit === 'ms/km' || z.range_unit === 'pace');
  const pace = isCorosPace ? normalizePaceZones(paceRaw) : paceRaw;
  const hrZones = hr.map((z) => toZoneBar(z, hr));
  const paceZones = pace.map((z) => toZoneBar(z, pace));
  return { hrZones, paceZones, hasZones: hrZones.length > 0 || paceZones.length > 0 };
}

function buildLapRows(segs: Segment[]): LapRow[] {
  const marks = lapPaceMarks(segs);
  let lapNo = 0;
  return segs.map((seg, i) => {
    const [paceMin, paceSec] = fmtPaceQuoteParts(seg.avg_pace);
    return {
      // 恢复圈不占圈号
      index: marks[i].rest ? '恢复' : `${++lapNo}`,
      duration: seg.duration_fmt || '—',
      distanceKm: seg.distance_km != null && seg.distance_km > 0 ? `${seg.distance_km.toFixed(2)}` : '—',
      paceMin,
      paceSec,
      paceTrend: marks[i].trend,
      hrTrend: marks[i].hrTrend,
      rowClass: marks[i].rowClass,
      tag: marks[i].tag,
      tagClass: marks[i].tagClass,
      hr: intStr(seg.avg_hr),
      cadence: intStr(seg.avg_cadence),
    };
  });
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
// 天气
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 轨迹地图：WGS84→GCJ02 + pause 分段 + 配速/心率 bin 着色
// ---------------------------------------------------------------------------

// 线性插值两个 hex 颜色，t ∈ [0,1]。
function lerpColor(a: string, b: string, t: number): string {
  const tt = Math.max(0, Math.min(1, t));
  const ar = parseInt(a.slice(1, 3), 16);
  const ag = parseInt(a.slice(3, 5), 16);
  const ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16);
  const bg = parseInt(b.slice(3, 5), 16);
  const bb = parseInt(b.slice(5, 7), 16);
  const r = Math.round(ar + (br - ar) * tt);
  const g = Math.round(ag + (bg - ag) * tt);
  const bl = Math.round(ab + (bb - ab) * tt);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${bl.toString(16).padStart(2, '0')}`;
}

// 3 停渐变：绿 → 橙 → 红。活动相对——同一原始 HR 值在两次活动里颜色可不同。
function gradient3(t: number): string {
  const tt = Math.max(0, Math.min(1, t));
  if (tt < 0.5) return lerpColor(MAP_GREEN, MAP_AMBER, tt * 2);
  return lerpColor(MAP_AMBER, MAP_RED, (tt - 0.5) * 2);
}

// 把 timeseries 按 pause 间隙切成 GCJ 分段。pause 与 timeseries timestamp 同为厘秒。
function buildMapSegments(timeseries: TimeseriesPoint[], pauses: Pause[] | undefined): MapPoint[][] {
  const windows = (pauses || [])
    .filter((w) => w.start_ts != null && w.end_ts != null)
    .map((w) => ({ start: w.start_ts!, end: w.end_ts! }))
    .sort((a, b) => a.start - b.start);

  const segs: MapPoint[][] = [];
  let cur: MapPoint[] = [];
  let pw = 0;
  for (const p of timeseries) {
    const ts = p.timestamp;
    if (ts == null || p.gps_lat == null || p.gps_lon == null) continue;
    while (pw < windows.length && windows[pw].end < ts) pw++;
    const inPause = pw < windows.length && windows[pw].start <= ts && ts <= windows[pw].end;
    if (inPause) {
      if (cur.length) {
        segs.push(cur);
        cur = [];
      }
      continue;
    }
    const g = wgs84ToGcj02(p.gps_lon, p.gps_lat);
    cur.push({ latitude: g.latitude, longitude: g.longitude, pace: p.adjusted_pace ?? p.speed, hr: p.heart_rate });
  }
  if (cur.length) segs.push(cur);
  return segs;
}

// 把一个 chunk 的均值 metric 映射成颜色。
function buildColoredLine(
  chunk: MapPoint[],
  coloring: MapColoring,
  paceMin: number,
  paceMax: number,
  hrMin: number,
  hrMax: number,
): MapPolyline {
  let sum = 0;
  let n = 0;
  for (const p of chunk) {
    const v = coloring === 'hr' ? p.hr : p.pace;
    if (v != null && v > 0) {
      sum += v;
      n++;
    }
  }
  const avg = n > 0 ? sum / n : null;
  let color = MAP_GREEN;
  if (avg != null) {
    if (coloring === 'hr') {
      const range = hrMax - hrMin;
      const t = range > 0 ? (avg - hrMin) / range : 0;
      color = gradient3(t);
    } else {
      // 配速：慢（大 s/km）→ 绿，快（小 s/km）→ 红（与 HR 反向）。
      const range = paceMax - paceMin;
      const t = range > 0 ? (paceMax - avg) / range : 0;
      color = gradient3(t);
    }
  }
  return { points: chunk.map((p) => ({ latitude: p.latitude, longitude: p.longitude })), color, width: 5 };
}

// 依据当前着色模式重建 polyline / 自适应视野。无有效 GPS（<20 点）时不渲染。
function computeMapView(coloring: MapColoring): {
  hasMap: boolean;
  mapLatitude: number;
  mapLongitude: number;
  mapPolylines: MapPolyline[];
  mapFitPoints: Array<{ latitude: number; longitude: number }>;
} {
  const noMap = { hasMap: false, mapLatitude: 0, mapLongitude: 0, mapPolylines: [], mapFitPoints: [] };

  let count = 0;
  let paceMin = Infinity;
  let paceMax = -Infinity;
  let hrMin = Infinity;
  let hrMax = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const seg of mapSegments) {
    for (const p of seg) {
      count++;
      if (p.pace != null && p.pace > 0) {
        if (p.pace < paceMin) paceMin = p.pace;
        if (p.pace > paceMax) paceMax = p.pace;
      }
      if (p.hr != null && p.hr > 0) {
        if (p.hr < hrMin) hrMin = p.hr;
        if (p.hr > hrMax) hrMax = p.hr;
      }
      if (p.latitude < minLat) minLat = p.latitude;
      if (p.latitude > maxLat) maxLat = p.latitude;
      if (p.longitude < minLng) minLng = p.longitude;
      if (p.longitude > maxLng) maxLng = p.longitude;
    }
  }
  if (count < 20) return noMap;

  const stride = count > MAX_MAP_PTS ? Math.ceil(count / MAX_MAP_PTS) : 1;
  const polylines: MapPolyline[] = [];
  for (const seg of mapSegments) {
    const decim = seg.filter((_, i) => i % stride === 0);
    if (decim.length < 2) continue;
    if (coloring === 'none') {
      polylines.push({ points: decim.map((p) => ({ latitude: p.latitude, longitude: p.longitude })), color: MAP_GREEN, width: 5 });
      continue;
    }
    for (let i = 0; i < decim.length; i += MAP_CHUNK) {
      const chunk = decim.slice(i, i + MAP_CHUNK);
      if (chunk.length < 2) {
        // 末尾孤立点并入上一条 polyline，避免单点线段。
        if (polylines.length) polylines[polylines.length - 1].points.push(...chunk.map((p) => ({ latitude: p.latitude, longitude: p.longitude })));
        break;
      }
      polylines.push(buildColoredLine(chunk, coloring, paceMin, paceMax, hrMin, hrMax));
    }
  }

  // 四周扩 10% 跨度（最小 ~0.0008° ≈ 90m），让轨迹在视野内居中、四周留白不贴边。
  const padLat = Math.max((maxLat - minLat) * 0.1, 0.0008);
  const padLng = Math.max((maxLng - minLng) * 0.1, 0.0008);

  return {
    hasMap: true,
    mapLatitude: (minLat + maxLat) / 2,
    mapLongitude: (minLng + maxLng) / 2,
    mapPolylines: polylines,
    mapFitPoints: [
      { latitude: minLat - padLat, longitude: minLng - padLng },
      { latitude: maxLat + padLat, longitude: maxLng + padLng },
    ],
  };
}

// 1×1 透明 png：marker 的 iconPath 必填，但视觉只需要 label。
const TRANSPARENT_ICON = '/assets/icons/map_dot.png';

// 徽标样式（深绿底 + STRIDE 绿描边 + 白字）。尺寸对齐 RQ：约占地图宽度 6%，
// anchorX/Y 取一半直径，让圆牌盖在轨迹点上。
const LAP_BADGE_LABEL = {
  color: '#ffffff',
  fontSize: 8,
  bgColor: '#0b3d24',
  borderColor: '#00e676',
  borderWidth: 1,
  borderRadius: 20,
  padding: 2,
  anchorX: -8,
  anchorY: -7,
  textAlign: 'center' as const,
};

// 起终点用图标 png（而非圆点）：起点 ▶ 绿、终点 ■ 红。
// marker 的 icon 恒在 marker 的 label 之下，所以圈号会压在起终点上——正是想要的层叠。
const START_ICON = '/assets/icons/map_start.png';
const END_ICON = '/assets/icons/map_end.png';

function buildEndpointMarkers(): MapMarker[] {
  const first = mapSegments[0];
  const last = mapSegments[mapSegments.length - 1];
  const start = first && first.length ? first[0] : null;
  const e = last && last.length ? last[last.length - 1] : null;
  const markers: MapMarker[] = [];
  const push = (id: number, p: MapPoint, iconPath: string) => {
    markers.push({
      id,
      latitude: p.latitude,
      longitude: p.longitude,
      iconPath,
      width: 20,
      height: 20,
      anchor: { x: 0.5, y: 0.5 },
      zIndex: 1,
    });
  };
  if (start) push(0, start, START_ICON);
  // 绕圈跑回起点时终点会和起点重合，不重叉。
  if (e && (!start || e.latitude !== start.latitude || e.longitude !== start.longitude)) push(-1, e, END_ICON);
  return markers;
}

// 画 RQ 风格圈号：每圈结束处一个编号徽标。
// 用「累计距离占总距离的比例」把圈边界映射到 timeseries 点，避开两处单位不一致
// （timeseries.distance 实测 cm，segment.distance_m 为 m）。恢复圈不计号、不打点。
function buildLapMarkers(segments: Segment[], timeseries: TimeseriesPoint[]): MapMarker[] {
  const pts: Array<{ d: number; lat: number; lon: number }> = [];
  for (const p of timeseries) {
    if (p.distance == null || p.gps_lat == null || p.gps_lon == null) continue;
    pts.push({ d: p.distance, lat: p.gps_lat, lon: p.gps_lon });
  }
  if (pts.length < 2) return [];
  const totalTs = pts[pts.length - 1].d - pts[0].d;
  const totalLap = segments.reduce((s, x) => s + (x.distance_m ?? 0), 0);
  if (totalTs <= 0 || totalLap <= 0) return [];

  const marks = lapPaceMarks(segments);
  const markers: MapMarker[] = [];
  let cum = 0;
  let lapNo = 0;
  let cursor = 0;
  for (let i = 0; i < segments.length; i++) {
    cum += segments[i].distance_m ?? 0;
    if (marks[i].rest) continue;
    lapNo += 1;
    const target = pts[0].d + (cum / totalLap) * totalTs;
    while (cursor < pts.length - 1 && pts[cursor].d < target) cursor++;
    const g = wgs84ToGcj02(pts[cursor].lon, pts[cursor].lat);
    markers.push({
      id: lapNo,
      latitude: g.latitude,
      longitude: g.longitude,
      iconPath: TRANSPARENT_ICON,
      width: 1,
      height: 1,
      anchor: { x: 0.5, y: 0.5 },
      label: { ...LAP_BADGE_LABEL, content: `${lapNo}` },
      zIndex: 100 + lapNo,
    });
  }
  return markers;
}

function buildWeather(a: Activity): WeatherItem[] {
  const out: WeatherItem[] = [];
  if (a.temperature != null) {
    let value = `${a.temperature}°C`;
    if (a.feels_like != null && a.feels_like !== a.temperature) {
      value += `（体感 ${a.feels_like}°）`;
    }
    out.push({ key: 'temp', icon: '/assets/icons/device_thermostat.svg', value });
  }
  if (a.humidity != null) {
    out.push({ key: 'humidity', icon: '/assets/icons/water_drop.svg', value: `${a.humidity}%` });
  }
  if (a.wind_speed != null && a.wind_speed > 0) {
    out.push({ key: 'wind', icon: '/assets/icons/air.svg', value: `${a.wind_speed} km/h` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 组装视图
// ---------------------------------------------------------------------------

function buildView(detail: ActivityDetailResponse): Partial<ActivityDetailPageData> {
  const a = detail.activity;
  const isStrength = isStrengthActivity(a);
  const metrics = buildMetrics(a, isStrength);
  const { hrZones, paceZones, hasZones } = buildZones(detail.zones || []);

  let laps: LapRow[] = [];
  let segments: ExerciseGroup[] = [];
  let hasSegments = false;
  if (isStrength) {
    segments = buildStrengthSegments(detail.segments || []);
    hasSegments = segments.length > 0;
  } else {
    // v1 只展示圈速表；圈速即后端 `segments`（type2 手表圈/间歇组，回落 autoKm）。
    laps = buildLapRows(detail.segments || []);
    hasSegments = laps.length > 0;
  }

  const sportNote = a.sport_note || '';

  // 轨迹地图：力量训练无 GPS，不渲染；默认按配速着色。
  let mapView: ReturnType<typeof computeMapView> = {
    hasMap: false,
    mapLatitude: 0,
    mapLongitude: 0,
    mapPolylines: [],
    mapFitPoints: [],
  };
  let mapMarkers: MapMarker[] = [];
  if (!isStrength) {
    mapSegments = buildMapSegments(detail.timeseries || [], detail.activity.pauses);
    mapView = computeMapView('pace');
    if (mapView.hasMap) {
      // 起终点排数组最前：marker 的 icon 恒在 label 之下，圈号会压在图标上。
      mapMarkers = [...buildEndpointMarkers(), ...buildLapMarkers(detail.segments || [], detail.timeseries || [])];
    }
  }

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
    ...mapView,
    mapMarkers,
    mapColoring: 'pace',
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
  return Math.round((statusPx * 750) / width) + 128 + 8;
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
    hasMap: false,
    mapLatitude: 0,
    mapLongitude: 0,
    mapPolylines: [],
    mapMarkers: [],
    mapFitPoints: [],
    mapColoring: 'pace',
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
      const detail = await getActivityDetail(userId, labelId, { includeTimeseries: true });
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

  onColoringChange(e: { currentTarget: { dataset: { coloring: MapColoring } } }) {
    const coloring = e.currentTarget.dataset.coloring;
    if (coloring === this.data.mapColoring) return;
    const view = computeMapView(coloring);
    this.setData({ mapColoring: coloring, ...view });
  },
});
