import { getActivityDetail } from '../../services/activities';
import { fmtDurationShort, fmtKm, fmtHms, fmtPaceQuote, fmtPaceQuoteParts } from '../../utils/format';
import { shanghaiDateFromIso, shanghaiTimeFromIso } from '../../utils/date';
import { wgs84ToGcj02 } from '../../utils/coord';
import {
  buildHrSeries,
  buildPaceSeries,
  downsample,
  zoneBands,
  zoneColor,
  CURVE_FALLBACK_COLOR,
  type CurveChartSpec,
  type CurvePoint,
  type ZoneBand,
} from '../../utils/curve';
import { createCurveChart, hrChartSpec, paceChartSpec, type CurveChart } from '../../utils/curveChart';
import { toUChartsTouchEvent } from '../../utils/ucharts';
import { lapPaceMarks } from '../../utils/lapRows';
import { userStore } from '../../store/index';
import { currentRouteForRedirect, openLogin } from '../../utils/authGate';
import type {
  Activity,
  ActivityDetailResponse,
  Segment,
  Zone,
  TimeseriesPoint,
  Pause,
} from '../../types/activity';
import { defaultShareAppMessage, defaultShareTimeline } from '../../utils/share';
import { saveImageToAlbum } from '../../utils/saveImage';
import { gradient3 } from '../../utils/posterGradient';
import {
  buildPosterModel,
  drawPoster,
  POSTER_HEIGHT,
  POSTER_PLATFORMS,
  POSTER_WIDTH,
  posterMapRequestSize,
  type PosterAspect,
  type PosterImage,
  type PosterModel,
} from '../../utils/poster';
import {
  isPosterThemeKey,
  loadPosterThemeKey,
  posterTheme,
  posterThemeDots,
  savePosterThemeKey,
  type PosterThemeDot,
} from '../../utils/posterThemes';
import { buildStaticMapRequest, fetchPosterMapImage } from '../../utils/posterMap';
import {
  buildDetailPosterModel,
  detailLayout,
  detailMapRequestSize,
  DETAIL_WIDTH,
  drawDetailPosterSlice,
  planDetailParts,
  planDetailSlices,
  type DetailPosterModel,
} from '../../utils/posterDetail';

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
  /** 区间条颜色（与曲线同一档配色） */
  color: string;
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
  /** 心率走向（与上一圈比较）→ /assets/icons/trend_hr_{{hrTrend}}.svg，涨红 / 降绿：'' | 'up' | 'down' */
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
  /** 栈深>1 顶栏显示返回箭头；=1（冷开分享卡直达）显示回主页的小房子 */
  canBack: boolean;
  contentPaddingTop: number;
  loading: boolean;
  notFound: boolean;
  isStrength: boolean;
  header: HeaderView;
  metrics: Metric[];
  hrZones: ZoneBar[];
  paceZones: ZoneBar[];
  /** 区间卡片里的走势曲线是否需要渲染 */
  hasHrCurve: boolean;
  hasPaceCurve: boolean;
  laps: LapRow[];
  segments: ExerciseGroup[];
  hasSegments: boolean;
  sportNote: string;
  feelNote: string;
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
  // —— 海报弹层（devops#947 九色系选择器）——
  /** 弹层可见 */
  posterSheetVisible: boolean;
  /** 当前主题 key（utils/posterThemes.ts 九色系之一） */
  posterThemeKey: string;
  /** 当前主题中文名（标题行展示） */
  posterThemeLabel: string;
  /** 色卡圆点（横滑选择器数据，选中态由 posterThemeKey 在 wxml 比较） */
  posterThemeDots: PosterThemeDot[];
  /** 当前比例（平台矩阵 devops#948：小红书 3:4 / 抖音 9:16 / 朋友圈 4:5 / 通用 1:1） */
  posterAspect: PosterAspect;
  /** 平台矩阵（utils/poster.ts 单源；比例选择按钮渲染数据） */
  posterPlatforms: typeof POSTER_PLATFORMS;
  /** 预览图临时路径；'' = 渲染中占位 */
  posterPreviewPath: string;
  /** 详情长图模式（devops#946）：弹层比例行最右的「详情长图」开关，true 时
   * 预览/保存走六节长图管线（超长课可能是多张）。 */
  posterLongImage: boolean;
  /** 当前预览的全部图（长图多张时 >1；预览大图/保存逐张用）。 */
  posterPreviewPaths: string[];
}

interface ActivityDetailPageHandlers {
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent;
  onShareTimeline(): WechatMiniprogram.Page.ICustomTimelineContent;
  fetch(): Promise<void>;
  drawCurves(): void;
  onHrCurveTouch(e: unknown): void;
  onPaceCurveTouch(e: unknown): void;
  onBack(): void;
  onColoringChange(e: { currentTarget: { dataset: { coloring: MapColoring } } }): void;
  /** 分享海报出口（devops#947）：打开海报弹层（九色系圆点横滑 + 平台矩阵 + 预览/保存）。 */
  onSharePoster(): void;
  /** 关海报弹层。 */
  onPosterClose(): void;
  /** 点色卡圆点：切主题 + 持久化 + 重渲预览。 */
  onPosterThemeTap(e: { currentTarget: { dataset: { key: string } } }): void;
  /** 切平台比例（devops#948 四比例矩阵）重渲预览。 */
  onPosterAspectTap(e: { currentTarget: { dataset: { aspect: PosterAspect } } }): void;
  /** 切详情长图模式（devops#946 六节图表长图）重渲预览。 */
  onPosterLongImageTap(): void;
  /** 预览大图（全屏 previewImage，长按可转发/保存）。 */
  onPosterPreviewTap(): void;
  /** 保存当前预览图到相册。 */
  onPosterSaveTap(): void;
  /** 弹层内拦截滚动穿透（mask touchmove 空处理）。 */
  noop(): void;
  /** 离屏画海报并导出 tempFilePath，失败返回 null（已 toast）。 */
  renderPoster(aspect: PosterAspect, themeKey: string): Promise<string | null>;
  /** 离屏画详情长图（分段绘制 + 纵向拼接，超长按节边界分多张），失败 null。 */
  renderDetailPoster(themeKey: string): Promise<string[] | null>;
  /** 按当前弹层选择渲染预览（最新胜出排队：渲染中再点只是替换待渲组合）。 */
  renderPosterPreview(): void;
  /** 保存海报到相册（utils/saveImage 权限引导收口），按结果 toast。 */
  savePoster(path: string): Promise<void>;
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
const MAX_MAP_PTS = 600; // 抽稀后点上限
const MAP_CHUNK = 8; // 每段 bin 成多长（条）

// 按 pause 分段的 GCJ 轨迹点（模块级缓存，供着色切换时重建；每次
// buildView 无条件重置，力量训练置空，跨活动不残留）。
let mapSegments: MapPoint[][] = [];

// 海报数据模型（devops#944）：buildView 时一次派生，renderPoster 只读。
let posterModel: PosterModel | null = null;

// 详情长图模型（devops#946）：同 buildView 一次派生。
let posterDetailModel: DetailPosterModel | null = null;

// —— 曲线（区间卡片里的心率 / 配速走势，uCharts 渲染）——

// 采集到的序列 / 档位 / 图表实例（模块级，不过 setData）。
let hrSeries: CurvePoint[] = [];
let paceSeries: CurvePoint[] = [];
let hrBands: ZoneBand[] = [];
let paceBands: ZoneBand[] = [];
let hrChart: CurveChart | null = null;
let paceChart: CurveChart | null = null;
let hrSpec: CurveChartSpec | null = null;
let paceSpec: CurveChartSpec | null = null;

// 海报绘制进行中（弹层内连点圆点/比例的并发防抖，模块级即可）。
let posterBusy = false;

// 静态图代理结果缓存（同活动同比例的临时文件路径；主题切换不换地图，
// 免每次重渲都打一遍代理）。buildView 时随活动重置。
let posterMapCache: { labelId: string; aspect: PosterAspect | 'detail'; path: string } | null = null;

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
    // z.range_min 要显式判空：上面的 slow 是三元派生的字符串，TS 不会据此收窄
    // z.range_min（对比 formatHrRange 直接用早退收窄的 min）。
    if (z2?.range_min != null && z.range_min != null && Math.round(z2.range_min) === Math.round(z.range_min)) return `> ${slow}`;
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
    color: CURVE_FALLBACK_COLOR,
  };
}

// 手表配速区间单位是 ms/km，曲线是 s/km，比色前先换算（非 ms/km 单位不动）。
function paceZoneToSeconds(z: Zone): Zone {
  if (z.range_unit !== 'ms/km' && z.range_unit !== 'pace') return z;
  const toSec = (v: number | null) => (v == null ? null : v / 1000);
  return { ...z, range_min: toSec(z.range_min), range_max: toSec(z.range_max) };
}

function buildZones(zones: Zone[]): {
  hrZones: ZoneBar[];
  paceZones: ZoneBar[];
  hrBands: ZoneBand[];
  paceBands: ZoneBand[];
} {
  // 手表上报区间本身就是完整分区（含开放边界的最快/最慢区），每个 zone_index 一行，
  // 开放边由 formatHRRange/formatPaceRange 处理；配速只对高驰（ms/km）或 STRIDE（pace）做 7→6 归一化合并阈值区。
  const hr = zones.filter((z) => z.zone_type === 'heartRate');
  const paceRaw = zones.filter((z) => z.zone_type === 'pace');
  const isCorosPace = paceRaw.length > 0 && paceRaw.every((z) => z.range_unit === 'ms/km' || z.range_unit === 'pace');
  const pace = isCorosPace ? normalizePaceZones(paceRaw) : paceRaw;
  const colorize = (list: Zone[], peers: Zone[]): ZoneBar[] =>
    list.map((z, i) => ({ ...toZoneBar(z, peers), color: zoneColor(i) }));
  const hrZones = colorize(hr, hr);
  const paceZones = colorize(pace, pace);
  return {
    hrZones,
    paceZones,
    hrBands: zoneBands(hr),
    paceBands: zoneBands(pace.map(paceZoneToSeconds)),
  };
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
// 走势曲线：抽稀后的序列交给 uCharts 渲染（配置见 utils/curveChart.ts）
// ---------------------------------------------------------------------------

function pixelRatio(): number {
  try {
    return wx.getWindowInfo().pixelRatio || 2;
  } catch {
    return 2;
  }
}

// ---------------------------------------------------------------------------
// 组装视图
// ---------------------------------------------------------------------------

function buildView(detail: ActivityDetailResponse): Partial<ActivityDetailPageData> {
  const a = detail.activity;
  const isStrength = isStrengthActivity(a);
  const metrics = buildMetrics(a, isStrength);
  const { hrZones, paceZones, hrBands: hrBandList, paceBands: paceBandList } = buildZones(detail.zones || []);
  hrSeries = downsample(buildHrSeries(detail.timeseries || []));
  paceSeries = downsample(buildPaceSeries(detail.timeseries || []));
  hrBands = hrBandList;
  paceBands = paceBandList;

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
  const feelNote = a.feel_note || '';

  // 轨迹地图：力量训练无 GPS，不渲染；默认按配速着色。
  let mapView: ReturnType<typeof computeMapView> = {
    hasMap: false,
    mapLatitude: 0,
    mapLongitude: 0,
    mapPolylines: [],
    mapFitPoints: [],
  };
  let mapMarkers: MapMarker[] = [];
  // 每次构建视图无条件重置模块级轨迹缓存：力量训练（无 GPS）置空，
  // 否则同会话切活动时残留上一条跑步的轨迹，泄漏进力量海报（E2E 缺陷）。
  mapSegments = isStrength ? [] : buildMapSegments(detail.timeseries || [], detail.activity.pauses);
  if (!isStrength) {
    mapView = computeMapView('pace');
    if (mapView.hasMap) {
      // 起终点排数组最前：marker 的 icon 恒在 label 之下，圈号会压在图标上。
      mapMarkers = [...buildEndpointMarkers(), ...buildLapMarkers(detail.segments || [], detail.timeseries || [])];
    }
  }

  const header = {
    sportLabel: sportNameCN(a.sport_name),
    name: (a.name && a.name.trim()) || sportNameCN(a.sport_name),
    dateLabel: dateLabelOf(a.date),
    trainTypeLabel: trainTypeCN(a.train_type),
    feelEmoji: feelEmoji(a.feel_type),
  };
  posterModel = buildPosterModel(detail, header, a.date);
  posterDetailModel = buildDetailPosterModel(detail, header, a.date);
  // 换活动即换轨迹：静态图缓存随模型一起失效。
  posterMapCache = null;

  return {
    isStrength,
    header,
    metrics,
    hrZones,
    paceZones,
    hasHrCurve: hrSeries.length > 1,
    hasPaceCurve: paceSeries.length > 1,
    laps,
    segments,
    hasSegments,
    sportNote,
    feelNote,
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
  onShareAppMessage: defaultShareAppMessage,
  onShareTimeline: defaultShareTimeline,
  data: {
    statusBarHeight: 0,
    canBack: false,
    contentPaddingTop: 232,
    loading: true,
    notFound: false,
    isStrength: false,
    header: { sportLabel: '', name: '', dateLabel: '', trainTypeLabel: '', feelEmoji: '' },
    metrics: [],
    hrZones: [],
    paceZones: [],
    hasHrCurve: false,
    hasPaceCurve: false,
    laps: [],
    segments: [],
    hasSegments: false,
    sportNote: '',
    feelNote: '',
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
    posterSheetVisible: false,
    posterThemeKey: 'sunrise',
    posterThemeLabel: '晨光',
    posterThemeDots: posterThemeDots(),
    posterAspect: '3:4',
    posterPlatforms: POSTER_PLATFORMS,
    posterPreviewPath: '',
    posterLongImage: false,
    posterPreviewPaths: [],
  },

  onLoad(options: Record<string, string | undefined>) {
    userId = userStore.getState().user?.id ?? '';
    labelId = options.labelId || '';

    this.setData({
      statusBarHeight: statusBarHeight(),
      canBack: getCurrentPages().length > 1,
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
        // 游客/会话失效兜底：可返回的登录引导（登录页可跳过，审核合规）。
        openLogin(currentRouteForRedirect());
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
      this.setData(
        {
          ...buildView(detail),
          loading: false,
          notFound: false,
        },
        // canvas 节点要等 view 层渲染出来才拿得到
        () => wx.nextTick(() => this.drawCurves()),
      );
    } catch {
      // 详情不存在（404）或网络失败都归到「未找到」空态。
      this.setData({ loading: false, notFound: true });
    }
  },

  /** 用 uCharts 画区间卡片里的心率 / 配速折线。 */
  drawCurves() {
    hrSpec = hrChartSpec(hrSeries, hrBands);
    paceSpec = paceChartSpec(paceSeries, paceBands);
    const targets: Array<{ spec: CurveChartSpec; store: (c: CurveChart) => void }> = [
      {
        spec: hrSpec,
        store: (c) => {
          hrChart = c;
        },
      },
      {
        spec: paceSpec,
        store: (c) => {
          paceChart = c;
        },
      },
    ];
    for (const { spec, store } of targets) {
      if (spec.series.length < 2) continue;
      wx.createSelectorQuery()
        .in(this)
        .select(spec.id)
        .fields({ node: true, size: true }, (res) => {
          if (!res || !res.node || !res.width || !res.height) return;
          store(createCurveChart(spec, res.node, res.width, res.height, pixelRatio()));
        })
        .exec();
    }
  },

  onHrCurveTouch(e: WechatMiniprogram.TouchEvent) {
    if (hrChart && hrSpec) hrChart.showToolTip(toUChartsTouchEvent(e), { formatter: (item, time) => hrSpec!.tooltip(item.data, time) });
  },

  onPaceCurveTouch(e: WechatMiniprogram.TouchEvent) {
    if (paceChart && paceSpec) paceChart.showToolTip(toUChartsTouchEvent(e), { formatter: (item, time) => paceSpec!.tooltip(item.data, time) });
  },

  onBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/coach/coach' }) });
  },

  onColoringChange(e: { currentTarget: { dataset: { coloring: MapColoring } } }) {
    const coloring = e.currentTarget.dataset.coloring;
    if (coloring === this.data.mapColoring) return;
    const view = computeMapView(coloring);
    this.setData({ mapColoring: coloring, ...view });
  },

  /** 分享海报出口（devops#947，Epic #601 P5）：打开海报弹层——九色系色卡
   * 圆点横滑选择器（选择持久化 storage）+ 平台矩阵（devops#948 四比例）
   * + 预览大图 / 保存相册。首渲用持久化主题；地图层走腾讯静态图代理，
   * 缺 key / 网络失败自动降级矢量占位，其余节正常出图。 */
  onSharePoster() {
    if (this.data.loading || this.data.notFound) return;
    const themeKey = loadPosterThemeKey();
    this.setData({
      posterSheetVisible: true,
      posterThemeKey: themeKey,
      posterThemeLabel: posterTheme(themeKey).label,
      posterPreviewPath: '',
      posterLongImage: false,
      posterPreviewPaths: [],
    });
    this.renderPosterPreview();
  },

  onPosterClose() {
    this.setData({ posterSheetVisible: false });
  },

  onPosterThemeTap(e: { currentTarget: { dataset: { key: string } } }) {
    const key = e.currentTarget.dataset.key;
    if (!isPosterThemeKey(key) || key === this.data.posterThemeKey) return;
    this.setData({ posterThemeKey: key, posterThemeLabel: posterTheme(key).label });
    savePosterThemeKey(key); // 偏好持久化（下次任何活动出图直接用）
    this.renderPosterPreview();
  },

  onPosterAspectTap(e: { currentTarget: { dataset: { aspect: PosterAspect } } }) {
    const aspect = e.currentTarget.dataset.aspect;
    if (!POSTER_PLATFORMS.some((p) => p.aspect === aspect)) return;
    if (aspect === this.data.posterAspect && !this.data.posterLongImage) return;
    this.setData({ posterAspect: aspect, posterLongImage: false, posterPreviewPath: '' });
    this.renderPosterPreview();
  },

  onPosterLongImageTap() {
    if (this.data.posterLongImage) return;
    this.setData({ posterLongImage: true, posterPreviewPath: '' });
    this.renderPosterPreview();
  },

  onPosterPreviewTap() {
    const paths = this.data.posterPreviewPaths;
    if (paths.length) wx.previewImage({ urls: paths.slice() });
  },

  onPosterSaveTap() {
    const paths = this.data.posterPreviewPaths;
    // 长图多张（超长课分张）逐张保存，串行避免相册权限弹窗并发。
    if (paths.length) {
      void paths.reduce(
        (p, item) => p.then(() => this.savePoster(item)),
        Promise.resolve(),
      );
    }
  },

  noop() {
    // mask touchmove 占位：拦滚动穿透，无行为。
  },

  /** 渲染当前弹层选择的预览图；渲染中再点选择不丢——完成后比对 data，
   * 组合已变就再渲一轮（最新胜出，无排队状态）。 */
  renderPosterPreview() {
    if (posterBusy) return; // 进行中：完成后与本函数收尾的比对负责补渲最新组合
    const aspect = this.data.posterAspect;
    const themeKey = this.data.posterThemeKey;
    const longImage = this.data.posterLongImage;
    const settle = () => {
      // 渲染期间又切了选择：data 已是最新组合，再渲一轮即为所见。
      if (this.data.posterSheetVisible && (this.data.posterAspect !== aspect || this.data.posterThemeKey !== themeKey || this.data.posterLongImage !== longImage)) {
        this.renderPosterPreview();
      }
    };
    if (longImage) {
      void this.renderDetailPoster(themeKey).then((paths) => {
        if (paths && paths.length && this.data.posterSheetVisible) {
          this.setData({ posterPreviewPath: paths[0], posterPreviewPaths: paths });
        }
        settle();
      });
      return;
    }
    void this.renderPoster(aspect, themeKey).then((path) => {
      if (path && this.data.posterSheetVisible) {
        this.setData({ posterPreviewPath: path, posterPreviewPaths: [path] });
      }
      settle();
    });
  },

  /** 离屏 canvas 画定稿版式概览海报（utils/poster.ts drawPoster）→ 导出临时图。
   * 地图层：有轨迹时先经后端静态图代理拉真图（fetchPosterMapImage，同活动
   * 同比例结果缓存，主题切换不重打代理），失败 resolve(null) → drawPoster
   * 内部降级矢量占位（不挡其余节出图）。 */
  renderPoster(aspect: PosterAspect, themeKey: string): Promise<string | null> {
    posterBusy = true;
    return new Promise((resolve) => {
      wx.createSelectorQuery()
        .in(this as never)
        .select('#poster-canvas')
        .fields({ node: true }, async (res) => {
          const canvas = res?.node;
          if (!canvas || !posterModel) {
            posterBusy = false;
            wx.showToast({ title: '海报生成失败', icon: 'none' });
            resolve(null);
            return;
          }
          try {
            // 地图层真图：代理任何失败（含 503 未配 key）→ null 降级占位。
            let mapImage: PosterImage | null = null;
            const size = posterMapRequestSize(aspect);
            // 门控按总轨迹点数（与 computeMapView 的 <20 口径一致）：曾误用
            // pause 段数（真实活动典型 1~8 段），代理自然路径永不触发。
            const trackPoints = mapSegments.reduce((n, seg) => n + seg.length, 0);
            const mapReq = trackPoints >= 20 ? buildStaticMapRequest(mapSegments, size.width, size.height) : null;
            if (mapReq) {
              let path = posterMapCache && posterMapCache.labelId === labelId && posterMapCache.aspect === aspect ? posterMapCache.path : null;
              if (!path) {
                path = await fetchPosterMapImage(mapReq);
                if (path) posterMapCache = { labelId, aspect, path };
              }
              if (path) mapImage = (await loadCanvasImage(canvas, path)) as PosterImage | null;
            }
            const width = POSTER_WIDTH;
            const height = POSTER_HEIGHT[aspect];
            const dpr = 2;
            canvas.width = width * dpr;
            canvas.height = height * dpr;
            const ctx = canvas.getContext('2d');
            ctx.scale(dpr, dpr);
            drawPoster(ctx, aspect, posterModel, {
              mapImage,
              track: mapSegments.length ? mapSegments : null,
              userName: userStore.getState().user?.name || '',
              themeKey,
            });
            wx.canvasToTempFilePath({
              canvas,
              // 导出精确逻辑尺寸：canvas 物理像素是 dpr=2 的 2160 宽，不传
              // dest* 会导出 2160×2880/2160×3840；票面验收口径 1080×1440/1920。
              destWidth: width,
              destHeight: height,
              success: (out) => resolve(out.tempFilePath),
              fail: () => {
                wx.showToast({ title: '海报生成失败', icon: 'none' });
                resolve(null);
              },
            });
          } catch (err) {
            console.error('[poster] 绘制异常', err);
            wx.showToast({ title: '海报生成失败', icon: 'none' });
            resolve(null);
          } finally {
            posterBusy = false;
          }
        })
        .exec();
    });
  },

  /** 详情长图（devops#946，Epic #601 P4）：1080×auto 六节图表。单超长 canvas
   * 在 iOS 画布上限内容易爆，走「多段 canvas 纵向拼接」：每段 dpr=2 绘制导出
   * （utils/posterDetail.drawDetailPosterSlice），再在 dpr=1 整幅画布 1:1 合成
   * 导出 1080×H；超长课（>DETAIL_MAX_HEIGHT）按节边界分多张，逐张返回。 */
  renderDetailPoster(themeKey: string): Promise<string[] | null> {
    if (posterBusy || !posterDetailModel) return Promise.resolve(null);
    posterBusy = true;
    return new Promise((resolve) => {
      wx.createSelectorQuery()
        .in(this as never)
        .select('#poster-canvas')
        .fields({ node: true }, async (res) => {
          const canvas = res?.node;
          if (!canvas || !posterDetailModel) {
            posterBusy = false;
            wx.showToast({ title: '长图生成失败', icon: 'none' });
            resolve(null);
            return;
          }
          try {
            const model = posterDetailModel;
            const t = posterTheme(themeKey);
            const trackPoints = mapSegments.reduce((n, seg) => n + seg.length, 0);
            const layout = detailLayout({
              hasMap: trackPoints >= 20,
              hasPace: model.paceCurve != null,
              hasHr: model.hrCurve != null,
              zoneRows: model.zones?.rows.length ?? 0,
              tableRows: model.table?.rows.length ?? 0,
              tablePerKm: model.table?.perKm ?? true,
            });

            // 地图层真图（与概览卡同管线，缓存键 'detail'）：任何失败 → null 降级矢量占位。
            let mapImage: PosterImage | null = null;
            if (trackPoints >= 20) {
              const size = detailMapRequestSize(layout);
              const mapReq = buildStaticMapRequest(mapSegments, size.width, size.height);
              if (mapReq) {
                let path = posterMapCache && posterMapCache.labelId === labelId && posterMapCache.aspect === 'detail' ? posterMapCache.path : null;
                if (!path) {
                  path = await fetchPosterMapImage(mapReq);
                  if (path) posterMapCache = { labelId, aspect: 'detail', path };
                }
                if (path) mapImage = (await loadCanvasImage(canvas, path)) as PosterImage | null;
              }
            }

            const ctx2d = (): DetailCanvasCtx => canvas.getContext('2d') as unknown as DetailCanvasCtx;
            const out: string[] = [];
            for (const part of planDetailParts(layout)) {
              // 每段：dpr=2 画布对准 [part.y+sl.y, +sl.h) 绝对逻辑坐标，导出 1080 宽。
              const slices: Array<{ y: number; h: number; path: string }> = [];
              for (const sl of planDetailSlices(part.h)) {
                canvas.width = DETAIL_WIDTH * 2;
                canvas.height = sl.h * 2;
                const ctx = ctx2d();
                ctx.setTransform(2, 0, 0, 2, 0, -(part.y + sl.y) * 2);
                drawDetailPosterSlice(ctx, t, { y: part.y + sl.y, h: sl.h }, layout, model, {
                  mapImage,
                  track: mapSegments.length ? mapSegments : null,
                  userName: userStore.getState().user?.name || '',
                });
                slices.push({ y: sl.y, h: sl.h, path: await canvasToTempFile(canvas, DETAIL_WIDTH, sl.h) });
              }
              if (slices.length === 1) {
                out.push(slices[0].path); // 单段即成品（段导出已 1080 宽）
                continue;
              }
              // 合成：dpr=1 整幅画布把各段 1:1 贴回，导出 1080×part.h。
              canvas.width = DETAIL_WIDTH;
              canvas.height = part.h;
              const actx = ctx2d();
              actx.setTransform(1, 0, 0, 1, 0, 0); // 合成走恒等变换（1:1 贴回）
              for (const sl of slices) {
                const img = await loadCanvasImage(canvas, sl.path);
                actx.drawImage(img as PosterImage, 0, sl.y, DETAIL_WIDTH, sl.h);
              }
              out.push(await canvasToTempFile(canvas, DETAIL_WIDTH, part.h));
            }
            resolve(out);
          } catch (err) {
            console.error('[poster-detail] 绘制异常', err);
            wx.showToast({ title: '长图生成失败', icon: 'none' });
            resolve(null);
          } finally {
            posterBusy = false;
          }
        })
        .exec();
    });
  },

  async savePoster(path: string) {
    const result = await saveImageToAlbum(path);
    if (result === 'saved') {
      wx.showToast({ title: '已保存到相册', icon: 'success' });
    } else if (result === 'failed') {
      wx.showToast({ title: '保存失败，请重试', icon: 'none' });
    }
    // cancelled：用户主动放弃（系统弹窗拒绝 / 未去设置开启），静默不打扰。
  },
});

// ---------------------------------------------------------------------------
// 海报绘制本体见 utils/poster.ts（devops#944 定稿版式）与 utils/posterMap.ts
// （地图层代理与降级）。此处只保留 canvas 图片加载这一页侧胶水。
// ---------------------------------------------------------------------------

/** 长图绘制的 canvas 上下文：PosterCtx 结构 + 页侧变换用的 setTransform。 */
type DetailCanvasCtx = Parameters<typeof drawDetailPosterSlice>[0] & {
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
};

/** wx.canvasToTempFilePath promisify（详情长图分段导出/合成导出共用）。 */
function canvasToTempFile(canvas: WechatMiniprogram.Canvas, destWidth: number, destHeight: number): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({
      canvas,
      destWidth,
      destHeight,
      success: (out) => resolve(out.tempFilePath),
      fail: (err) => reject(err),
    });
  });
}

/** canvas 2d 的 createImage 加载临时文件；失败 resolve(null)（地图层降级）。 */
function loadCanvasImage(canvas: unknown, src: string): Promise<unknown> {
  return new Promise((resolve) => {
    const c = canvas as { createImage?: () => { src: string; onload: (() => void) | null; onerror: (() => void) | null } };
    if (!c || typeof c.createImage !== 'function') {
      resolve(null);
      return;
    }
    const img = c.createImage();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
