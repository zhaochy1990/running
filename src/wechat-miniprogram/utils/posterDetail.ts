/**
 * 详情长图海报（devops#946，Epic #601 P4）——1080×auto 六节图表的 canvas 实现，
 * 版式复刻 stride 仓 POC（prototypes/activity-share-poster/gen-set.mjs detailPage）：
 *
 *   01 总览数据（八格：距离/时长/平均配速/平均心率/最大心率/步频/步幅/爬升）
 *   02 轨迹（腾讯静态图代理，缺图降级矢量占位——与概览卡共用 drawMapLayer）
 *   03 配速曲线（快=高，显示窗 3:30–7:00/km，均值虚线）
 *   04 心率曲线（面积图 + Z5 阈值虚线）
 *   05 心率区间分布横条（生产用 activity_zones；%最大心率法仅为兜底）
 *   06 每公里配速全量表（2 列全量行数，最快高亮；与概览卡表头同源派生）
 *
 * 缺数据的节整卡跳过、序号顺延；高度自适应（layout 纯函数算总高）。
 * 颜色全走 utils/posterThemes.ts 九色系（devops#947 单源，绘制函数零散落
 * hex；唯一例外 ON_ACCENT——POC 九套主题最快行白字的既定口径）。
 *
 * 渲染（Playwright fullPage 的 mp 等价）：单超长 canvas 在 iOS 4096px/边与
 * 16.7M px² 面积上限内容易爆（34km ≈ 3600 逻辑高 × dpr2 = 7200 物理高），
 * 故走「多段 canvas 纵向拼接」：每段 ≤ DETAIL_SEGMENT_H 逻辑高按 dpr=2 绘制
 * 导出（段内 2160×≤3800 物理，与 #944 已实证的 9:16 画布同量级），再在
 * dpr=1 的整幅画布上 1:1 合成导出 1080×H（合成画布 ≤ DETAIL_MAX_HEIGHT
 * < 4096px/边）。超长课（超马级，H > DETAIL_MAX_HEIGHT）按节边界切成多张
 * 全宽图（planDetailParts），随图集逐张预览/保存。
 *
 * 布局 / 派生 / 分段规划全是纯函数，`utils/posterDetail.check.mts` 自检进 CI；
 * canvas 绘制函数保持薄（几何决策都在纯函数里）。
 */
import type { ActivityDetailResponse, Segment, TimeseriesPoint, Zone } from '../types/activity';
import type { PosterTheme } from './posterThemes';
import { fmtDurationShort, fmtHms, fmtPaceQuote } from './format';
import {
  card,
  drawBrand,
  drawFooterSignatureAt,
  drawMapLayer,
  drawTitle,
  pacedKmSplits,
  resampleSeries,
  roundRect,
  z5Threshold,
  type PosterCtx,
  type PosterImage,
  type PosterRect,
} from './poster';
import type { TrackPoint } from './posterMap';

/** 最快行 / 编号徽标上的文字色：POC 九套主题的既定口径（numGrad/accent 上
 * 恒白字，gen-set.mjs krow fastest 同款），不随主题表走。 */
const ON_ACCENT = '#ffffff';

/** 长图画布宽（与概览卡一致）。 */
export const DETAIL_WIDTH = 1080;

/** 单段绘制窗口的逻辑高上限（dpr=2 → 段画布 2160×≤3800 物理，与 #944
 * 已实证的 9:16 概览画布 2160×3840 同量级，不押注更大的画布上限）。 */
export const DETAIL_SEGMENT_H = 1900;

/** 单张长图的总高上限：dpr=1 合成画布 ≤ 4096px/边的经典 iOS canvas 限制
 * 内留余量。34km ≈ 3600、全马 ≈ 3800 都单张；更长按节边界分张。 */
export const DETAIL_MAX_HEIGHT = 4000;

/** 曲线重采样点数上限（卡内宽 ~900px，再多看不出差别）。 */
const MAX_CURVE_POINTS = 240;

/** 配速曲线显示窗（s/km）：3:30–7:00，窗外值夹到窗边（POC 同款）。 */
export const PACE_WINDOW = { lo: 210, hi: 420 } as const;

/** 配速曲线纵向网格线（s/km → 4:00 / 5:00 / 6:00，POC 同款）。 */
const PACE_GRID = [240, 300, 360] as const;

// ---------------------------------------------------------------------------
// 数据派生（纯函数）
// ---------------------------------------------------------------------------

/** 曲线采样点：x 为横轴（km 或 min），v 为纵轴值。 */
export interface DetailCurvePoint {
  x: number;
  v: number;
}

/** 横轴口径：km = timeseries.distance（米）累计；t = 起点起分钟数（无 dist 通道时）。 */
export type CurveXBasis = 'km' | 't';

export interface DetailPaceCurve {
  points: DetailCurvePoint[];
  xBasis: CurveXBasis;
  /** 横轴最大值（km 或 min）。 */
  xMax: number;
  /** 均值虚线（s/km）；无官方均值时取通道均值。 */
  avgSec: number | null;
}

export interface DetailHrCurve {
  points: DetailCurvePoint[];
  xBasis: CurveXBasis;
  xMax: number;
  /** Z5 阈值（bpm，activity_zones 最高档下界）；无区间数据 null。 */
  z5: number | null;
  avgHr: number | null;
  maxHr: number | null;
}

export interface DetailZoneRow {
  /** 如 `Z1 <130` / `Z2 130-150` / `Z5 ≥165`。 */
  label: string;
  /** 0-1（该区间时长占比）。 */
  pct: number;
  durS: number;
}

export interface DetailKmTableRow {
  ordinal: number;
  paceText: string;
  /** 5-95 百分位归一的着色深浅 0-1（快=1）。 */
  tint: number;
  fastest: boolean;
}

export interface DetailPosterModel {
  title: string;
  sportLabel: string;
  trainTypeLabel: string;
  isPlanned: boolean;
  dateCapsule: string;
  dateFull: string;
  /** 八格总览（恒 8 项，缺失值 '—'）。 */
  stats: Array<{ label: string; value: string; unit?: string }>;
  paceCurve: DetailPaceCurve | null;
  hrCurve: DetailHrCurve | null;
  zones: { rows: DetailZoneRow[]; source: 'zones' | 'pctMax' } | null;
  table: { rows: DetailKmTableRow[]; header: string; perKm: boolean } | null;
}

/** pause 外的扁平采样（模型派生中间形状）：t 秒 / dist 米 / hr / pace s/km。 */
interface FlatSample {
  t: number;
  dist: number | null;
  hr: number | null;
  pace: number | null;
}

/** timeseries → pause 外扁平序列（与 buildMapSegments 同一 pause 规则；
 * pause 期间的心率不计入区间兜底、跨 pause 的配速推导会被切断）。 */
function flattenOutsidePauses(points: TimeseriesPoint[], pauses: Array<{ start: number; end: number }>): FlatSample[] {
  const windows = [...pauses].sort((a, b) => a.start - b.start);
  const out: FlatSample[] = [];
  let t0: number | null = null;
  let pw = 0;
  for (const p of points) {
    if (p.timestamp == null) continue;
    if (t0 == null) t0 = p.timestamp;
    const t = (p.timestamp - t0) / 100; // 厘秒 → 秒
    while (pw < windows.length && windows[pw].end < p.timestamp) pw++;
    if (pw < windows.length && windows[pw].start <= p.timestamp && p.timestamp <= windows[pw].end) continue;
    out.push({
      t,
      dist: p.distance,
      hr: p.heart_rate != null && p.heart_rate > 0 ? p.heart_rate : null,
      // 通道配速先入列（s/km；speed 是 m/s 不混用），缺口由 derivePace 补。
      pace: p.adjusted_pace != null && p.adjusted_pace > 0 && p.adjusted_pace < 1200 ? p.adjusted_pace : null,
    });
  }
  return out;
}

/** 配速推导兜底（POC build-data.mjs 同款）：无 pace 通道时用 ±8 点窗口的
 * dist/ts 增量（dd>5m 防抖、结果限 60-1500 s/km 防离谱）。 */
function derivePace(flat: FlatSample[]): void {
  const raw = flat.map((p) => (p.pace != null && p.pace > 0 && p.pace < 1200 ? p.pace : null));
  const hasChannel = raw.some((v) => v != null);
  for (let i = 0; i < flat.length; i++) {
    if (hasChannel && raw[i] != null) {
      flat[i].pace = raw[i];
      continue;
    }
    const a = flat[Math.max(0, i - 8)];
    const b = flat[Math.min(flat.length - 1, i + 8)];
    const dd = a.dist != null && b.dist != null ? b.dist - a.dist : 0;
    const dt = b.t - a.t;
    if (dd <= 5 || dt <= 0) continue;
    const pace = (dt / dd) * 1000;
    if (pace > 60 && pace < 1500) flat[i].pace = pace;
  }
}

/** 横轴值：km 优先（dist 通道），否则 t（分钟）。返回 null = 该点无横轴。 */
function xAxis(s: FlatSample, basis: CurveXBasis, dist0: number): number | null {
  if (basis === 'km') {
    if (s.dist == null) return null;
    return Math.max(0, (s.dist - dist0) / 1000);
  }
  return s.t / 60;
}

/** 每公里配速全量表：与概览卡配速条同源（pacedKmSplits 单源），全量行、
 * 2 列排布在版式侧；行底色按 5-95 百分位归一的 tint，最快行高亮。
 * perKm = 全部 autoKm 分段（否则间歇组口径，标题/单位换「分段/段」）。 */
export function buildKmTable(segments: Segment[]): { rows: DetailKmTableRow[]; header: string; perKm: boolean } | null {
  const { splits, fastestIdx } = pacedKmSplits(segments);
  if (splits.length < 2) return null;

  const secs = splits.map((s) => s.secPerKm);
  const sorted = [...secs].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.05)];
  const hi = sorted[Math.floor(sorted.length * 0.95)];
  const rows = splits.map((s, i) => ({
    ordinal: s.ordinal,
    paceText: fmtPaceQuote(s.secPerKm),
    tint: Math.max(0, Math.min(1, (hi - s.secPerKm) / (hi - lo || 1))),
    fastest: i === fastestIdx,
  }));

  const perKm = splits.every((s) => s.lapType === 'autoKm');
  const unit = perKm ? '公里' : '段';
  const header =
    fastestIdx >= 0
      ? `最快 ${fmtPaceQuote(splits[fastestIdx].secPerKm)}/km · 第 ${splits[fastestIdx].ordinal} ${unit}`
      : `${fmtPaceQuote(secs[0])}/km`;
  return { rows, header, perKm };
}

/** 心率区间标签：开放边界约定（首档 `< 下界`、末档 `≥ 下界`、中间闭区间），
 * 按排序位次（rank）编号 Z1..Zn，与 zone_index 0/1 起点无关。 */
function hrZoneLabel(rank: number, total: number, min: number | null, max: number | null, nextMin: number | null): string {
  const z = `Z${rank + 1}`;
  const mi = min != null ? Math.round(min) : null;
  const ma = max != null ? Math.round(max) : null;
  if (mi == null && ma == null) return z;
  if (rank === 0) {
    if (mi == null) return `${z} <${ma}`;
    if (nextMin != null && Math.round(nextMin) === mi) return `${z} <${mi}`;
    return ma != null ? `${z} ${mi}-${ma}` : `${z} <${mi}`;
  }
  if (rank === total - 1) return mi == null ? `${z} ≥${ma}` : `${z} ≥${mi}`;
  if (mi == null || ma == null) return z;
  return `${z} ${mi}-${ma}`;
}

/** 心率区间分布：生产用 activity_zones（percent 或 duration_s 派生占比）；
 * 无校准区间时兜底 %最大心率五分法（POC 口径：<60/60-70/70-80/80-90/≥90%max，
 * 时长按 timeseries 相邻点 ts 增量累计）。两路都无数据 → null。 */
export function buildZoneRows(
  zones: Zone[],
  flat: Array<{ t: number; hr: number | null }>,
  maxHr: number | null,
): { rows: DetailZoneRow[]; source: 'zones' | 'pctMax' } | null {
  const hrZones = zones.filter((z) => z.zone_type === 'heartRate').sort((a, b) => a.zone_index - b.zone_index);
  if (hrZones.length >= 2) {
    const anyPct = hrZones.some((z) => z.percent != null && z.percent > 0);
    const totalDur = hrZones.reduce((s, z) => s + (z.duration_s ?? 0), 0);
    const rows = hrZones.map((z, i) => {
      const pct = anyPct
        ? (z.percent ?? 0) / 100
        : totalDur > 0 && z.duration_s != null
          ? z.duration_s / totalDur
          : 0;
      return {
        label: hrZoneLabel(i, hrZones.length, z.range_min, z.range_max, hrZones[i + 1]?.range_min ?? null),
        pct: Math.max(0, Math.min(1, pct)),
        durS: z.duration_s ?? 0,
      };
    });
    if (rows.some((r) => r.pct > 0)) return { rows, source: 'zones' };
  }

  // 兜底：%最大心率五分法（POC zones5 口径：<60/60-70/70-80/80-90/≥90%max）。
  if (maxHr == null || maxHr <= 0 || flat.length < 2) return null;
  const b = [0.6, 0.7, 0.8, 0.9].map((f) => Math.round(f * maxHr));
  const sec = [0, 0, 0, 0, 0];
  for (let i = 0; i + 1 < flat.length; i++) {
    const hr = flat[i].hr;
    if (hr == null) continue;
    const idx = hr >= b[3] ? 4 : hr >= b[2] ? 3 : hr >= b[1] ? 2 : hr >= b[0] ? 1 : 0;
    sec[idx] += flat[i + 1].t - flat[i].t;
  }
  const total = sec.reduce((x, y) => x + y, 0);
  if (total <= 0) return null;
  const rows = sec.map((s, i) => ({
    label: i === 0 ? `Z1 <${b[0]}` : i === 4 ? `Z5 ≥${b[3]}` : `Z${i + 1} ${b[i - 1]}-${b[i]}`,
    pct: s / total,
    durS: Math.round(s),
  }));
  return { rows, source: 'pctMax' };
}

/** 详情 → 长图模型。header 由页面传（SPORT_CN 等映射单源在页面）。 */
export function buildDetailPosterModel(
  detail: ActivityDetailResponse,
  header: { name: string; sportLabel: string; trainTypeLabel: string; dateLabel: string },
  dateIso: string,
): DetailPosterModel {
  const a = detail.activity;

  const ymd = (dateIso || '').slice(0, 10);
  const [, mm, dd] = ymd.split('-');
  const monthDay = mm && dd ? `${Number(mm)}月${Number(dd)}日` : '';
  const dateFull = ymd ? `${ymd.slice(0, 4)}年${monthDay}` : '';

  const flat = flattenOutsidePauses(
    detail.timeseries || [],
    (a.pauses || []).filter((p) => p.start_ts != null && p.end_ts != null).map((p) => ({ start: p.start_ts as number, end: p.end_ts as number })),
  );
  derivePace(flat);
  const hasDist = flat.filter((s) => s.dist != null).length >= 2;
  const basis: CurveXBasis = hasDist ? 'km' : 't';
  const dist0 = basis === 'km' ? (flat.find((s) => s.dist != null)?.dist as number) : 0;

  const toCurve = (pick: (s: FlatSample) => number | null): DetailCurvePoint[] => {
    const pts: DetailCurvePoint[] = [];
    for (const s of flat) {
      const v = pick(s);
      if (v == null) continue;
      const x = xAxis(s, basis, dist0);
      if (x == null) continue;
      pts.push({ x, v });
    }
    return pts;
  };

  // 配速曲线：通道值优先、POC 推导兜底（derivePace 已填），均值用官方 avg_pace。
  const pacePts = toCurve((s) => s.pace);
  const paceCurve =
    pacePts.length >= 2
      ? {
          points: resampleSeries(pacePts.map((p) => ({ t: p.x, v: p.v })), MAX_CURVE_POINTS).map((p) => ({ x: p.t, v: p.v })),
          xBasis: basis,
          xMax: pacePts[pacePts.length - 1].x,
          avgSec: a.avg_pace_s_km != null && a.avg_pace_s_km > 0 ? a.avg_pace_s_km : pacePts.reduce((s, p) => s + p.v, 0) / pacePts.length,
        }
      : null;

  // 心率曲线：x 与配速曲线同基（视觉上上下两图可对照）。
  const hrPts = toCurve((s) => s.hr);
  const hrCurve =
    hrPts.length >= 2
      ? {
          points: resampleSeries(hrPts.map((p) => ({ t: p.x, v: p.v })), MAX_CURVE_POINTS).map((p) => ({ x: p.t, v: p.v })),
          xBasis: basis,
          xMax: hrPts[hrPts.length - 1].x,
          z5: z5Threshold(detail.zones || []),
          avgHr: a.avg_hr != null ? Math.round(a.avg_hr) : null,
          maxHr: a.max_hr != null ? Math.round(a.max_hr) : null,
        }
      : null;

  return {
    title: header.name,
    sportLabel: header.sportLabel,
    trainTypeLabel: header.trainTypeLabel,
    isPlanned: Boolean(detail.linked_scheduled_workout),
    dateCapsule: monthDay || header.dateLabel,
    dateFull,
    stats: [
      { label: '距离', value: a.distance_km > 0 ? `${a.distance_km}` : '—', unit: 'km' },
      { label: '时长', value: a.duration_fmt || fmtHms(a.duration_s) },
      { label: '平均配速', value: a.avg_pace_s_km != null && a.avg_pace_s_km > 0 ? fmtPaceQuote(a.avg_pace_s_km) : '—', unit: '/km' },
      { label: '平均心率', value: a.avg_hr != null ? `${Math.round(a.avg_hr)}` : '—', unit: 'bpm' },
      { label: '最大心率', value: a.max_hr != null ? `${Math.round(a.max_hr)}` : '—', unit: 'bpm' },
      { label: '步频', value: a.avg_cadence != null ? `${Math.round(a.avg_cadence)}` : '—', unit: 'spm' },
      { label: '步幅', value: a.avg_step_len_cm != null ? `${(a.avg_step_len_cm / 100).toFixed(2)}` : '—', unit: 'm' },
      { label: '爬升', value: a.ascent_m != null ? `${Math.round(a.ascent_m)}` : '—', unit: 'm' },
    ],
    paceCurve,
    hrCurve,
    zones: buildZoneRows(detail.zones || [], flat, a.max_hr),
    table: buildKmTable(detail.segments || []),
  };
}

// ---------------------------------------------------------------------------
// 版式（纯函数）
// ---------------------------------------------------------------------------

export type DetailSectionKind = 'stats' | 'map' | 'pace' | 'hr' | 'zones' | 'table';

export interface DetailSection {
  kind: DetailSectionKind;
  /** 两位序号（01 起，按实际存在的节顺延）。 */
  no: string;
  title: string;
  rect: PosterRect;
  /** 节内内容区（卡内缩进、去掉节头）。 */
  content: PosterRect;
}

export interface DetailLayout {
  width: number;
  height: number;
  pad: number;
  /** 正文右缘（长图无平台安全区，= width - pad；与概览卡共用绘制函数的
   * contentRight 契约对齐）。 */
  contentRight: number;
  brandY: number;
  titleY: number;
  chips: PosterRect;
  sections: DetailSection[];
  footerLineY: number;
  footerTextY: number;
}

const PAD = 48;
const GAP = 24;
const SEC_PAD = 24;
const SEC_HEAD_H = 56;
const SEC_HEAD_MARGIN = 16;
const STATS_CELL_H = 148;
const STATS_GAP = 14;
const MAP_CONTENT_H = 440;
const CURVE_CONTENT_H = 280;
const ZONE_ROW_H = 48;
const TABLE_ROW_H = 46;
const TABLE_ROW_GAP = 4;

const SECTION_TITLES: Record<DetailSectionKind, string> = {
  stats: '总览数据',
  map: '轨迹',
  pace: '配速曲线',
  hr: '心率曲线',
  zones: '心率区间分布',
  table: '每公里配速',
};

export interface DetailLayoutInput {
  hasMap: boolean;
  hasPace: boolean;
  hasHr: boolean;
  zoneRows: number;
  tableRows: number;
  /** 全 autoKm → 「每公里配速」，否则间歇组口径「分段配速」。 */
  tablePerKm: boolean;
}

/** 六节版式（缺节收拢 + 序号顺延）：header（品牌/课名/chips，与概览卡同格）
 * → 节卡（编号徽标 + 标题 + 右侧 meta）→ 页脚署名。总高自适应。 */
export function detailLayout(o: DetailLayoutInput): DetailLayout {
  const width = DETAIL_WIDTH;
  const inner = width - PAD * 2;

  const contentKinds: DetailSectionKind[] = ['stats'];
  if (o.hasMap) contentKinds.push('map');
  if (o.hasPace) contentKinds.push('pace');
  if (o.hasHr) contentKinds.push('hr');
  if (o.zoneRows > 0) contentKinds.push('zones');
  if (o.tableRows > 0) contentKinds.push('table');
  const contentH: Record<DetailSectionKind, number> = {
    stats: STATS_CELL_H * 2 + STATS_GAP,
    map: MAP_CONTENT_H,
    pace: CURVE_CONTENT_H,
    hr: CURVE_CONTENT_H,
    zones: o.zoneRows * ZONE_ROW_H,
    table: o.tableRows * TABLE_ROW_H + (o.tableRows - 1) * TABLE_ROW_GAP,
  };

  const chips: PosterRect = { x: PAD, y: 204, w: inner, h: 52 };
  let y = 272; // chips 底 + 呼吸（与概览卡同格）
  const sections: DetailSection[] = contentKinds.map((kind, i) => {
    const h = SEC_PAD + SEC_HEAD_H + SEC_HEAD_MARGIN + contentH[kind] + SEC_PAD;
    const rect: PosterRect = { x: PAD, y, w: inner, h };
    const content: PosterRect = {
      x: rect.x + SEC_PAD,
      y: rect.y + SEC_PAD + SEC_HEAD_H + SEC_HEAD_MARGIN,
      w: rect.w - SEC_PAD * 2,
      h: contentH[kind],
    };
    y += h + GAP;
    return { kind, no: String(i + 1).padStart(2, '0'), title: kind === 'table' && !o.tablePerKm ? '分段配速' : SECTION_TITLES[kind], rect, content };
  });

  const lastBottom = sections.length ? sections[sections.length - 1].rect.y + sections[sections.length - 1].rect.h : chips.y + chips.h + 28;
  const footerLineY = lastBottom + 36;
  const footerTextY = footerLineY + 48;

  return {
    width,
    height: footerTextY + 36,
    pad: PAD,
    contentRight: width - PAD,
    brandY: 76,
    titleY: 168,
    chips,
    sections,
    footerLineY,
    footerTextY,
  };
}

/** 地图节内容区（含卡内缩进，与概览卡 CARD_INSET 同口径）。 */
function detailMapImageRect(layout: DetailLayout): PosterRect | null {
  const sec = layout.sections.find((s) => s.kind === 'map');
  if (!sec) return null;
  const inset = 10;
  return { x: sec.content.x + inset, y: sec.content.y + inset, w: sec.content.w - inset * 2, h: sec.content.h - inset * 2 };
}

/** 静态图请求尺寸：显示区像素 ÷ 2（scale=2 出图），夹 API 下限 50。 */
export function detailMapRequestSize(layout: DetailLayout): { width: number; height: number } {
  const r = detailMapImageRect(layout);
  if (!r) return { width: 50, height: 50 };
  return { width: Math.max(50, Math.round(r.w / 2)), height: Math.max(50, Math.round(r.h / 2)) };
}

// ---------------------------------------------------------------------------
// 分段规划（纯函数）：多段 canvas 纵向拼接的「段」与超长分张的「张」
// ---------------------------------------------------------------------------

export interface DetailWindow {
  y: number;
  h: number;
}

/** 把 [0, height) 切成 ≤ DETAIL_SEGMENT_H 的连续绘制窗口（段间无缝、无重叠）。 */
export function planDetailSlices(height: number): DetailWindow[] {
  const out: DetailWindow[] = [];
  for (let y = 0; y < height; y += DETAIL_SEGMENT_H) out.push({ y, h: Math.min(DETAIL_SEGMENT_H, height - y) });
  return out;
}

/** 导出分张：总高 ≤ DETAIL_MAX_HEIGHT 单张；更长按节边界贪心切（每张含
 * 完整的节；header 只在首张、页脚只在末张由绘制侧按窗口自然裁掉）。
 * 单节自身超上限（超长全量表）只能独立成张——画布超限属已知边界。 */
export function planDetailParts(layout: DetailLayout): DetailWindow[] {
  if (layout.height <= DETAIL_MAX_HEIGHT) return [{ y: 0, h: layout.height }];
  const bounds = [0, ...layout.sections.map((s) => s.rect.y), layout.height];
  const parts: DetailWindow[] = [];
  let start = 0;
  for (let i = 1; i < bounds.length; i++) {
    const end = bounds[i];
    if (end - start > DETAIL_MAX_HEIGHT && bounds[i - 1] > start) {
      parts.push({ y: start, h: bounds[i - 1] - start });
      start = bounds[i - 1];
    }
  }
  parts.push({ y: start, h: layout.height - start });
  return parts;
}

// ---------------------------------------------------------------------------
// 绘制（薄壳：几何/文案决策在上面的纯函数里；颜色全走 PosterTheme）
// ---------------------------------------------------------------------------

/** 秒 → `M:SS`（曲线轴刻度）。 */
function fmtMss(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 横轴刻度（km 或 min）：目标 4-6 根、含 0 与端点附近。 */
function xTicks(xMax: number, basis: CurveXBasis): number[] {
  if (basis === 'km') {
    const step = xMax >= 20 ? 5 : xMax >= 8 ? 2 : 1;
    const out: number[] = [];
    for (let v = 0; v <= Math.floor(xMax + 1e-9); v += step) out.push(v);
    return out;
  }
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120];
  const step = candidates.find((c) => xMax / c <= 6) ?? 120;
  const out: number[] = [];
  for (let v = 0; v <= xMax + 1e-9; v += step) out.push(v);
  return out;
}

/** 横轴刻度文案：km 不带单位（POC 同款数字）；min 带「分」。 */
function xTickLabel(v: number, basis: CurveXBasis): string {
  return basis === 'km' ? `${Math.round(v)}` : `${Math.round(v)}分`;
}

/** 半透明填充（globalAlpha 走位，兼容 hex/rgba 两种 token 格式）。 */
function fillAlpha(ctx: PosterCtx, color: string, alpha: number): void {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 1;
}

/** 节头：渐变编号徽标 + 标题 + 右侧 meta。 */
function drawSectionHead(ctx: PosterCtx, t: PosterTheme, sec: DetailSection, meta: string): void {
  const badge: PosterRect = { x: sec.rect.x + SEC_PAD, y: sec.rect.y + SEC_PAD + 6, w: 64, h: 40 };
  const grad = ctx.createLinearGradient(badge.x, 0, badge.x + badge.w, 0);
  grad.addColorStop(0, t.accent);
  grad.addColorStop(1, t.accentDeep);
  roundRect(ctx, badge, 10);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.fillStyle = ON_ACCENT;
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText(sec.no, badge.x + 13, badge.y + 29);

  ctx.fillStyle = t.cardInk;
  ctx.font = 'bold 32px sans-serif';
  ctx.fillText(sec.title, badge.x + badge.w + 18, badge.y + 31);

  if (meta) {
    ctx.fillStyle = t.cardSub;
    ctx.font = '24px sans-serif';
    const w = ctx.measureText(meta).width;
    ctx.fillText(meta, sec.rect.x + sec.rect.w - SEC_PAD - w, badge.y + 30);
  }
}

/** 01 总览数据：八格 4×2（值 + 单位 + 标签）。 */
function drawStats(ctx: PosterCtx, t: PosterTheme, sec: DetailSection, model: DetailPosterModel): void {
  const cols = 4;
  const gap = STATS_GAP;
  const cellW = (sec.content.w - gap * (cols - 1)) / cols;
  model.stats.slice(0, 8).forEach((m, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const r: PosterRect = { x: sec.content.x + col * (cellW + gap), y: sec.content.y + row * (STATS_CELL_H + gap), w: cellW, h: STATS_CELL_H };
    roundRect(ctx, r, 16);
    ctx.fillStyle = t.bgSunken;
    ctx.fill();
    ctx.fillStyle = t.cardInk;
    ctx.font = 'bold 44px sans-serif';
    ctx.fillText(m.value, r.x + 22, r.y + 66);
    if (m.unit) {
      const vw = ctx.measureText(m.value).width;
      ctx.fillStyle = t.cardSub;
      ctx.font = '22px sans-serif';
      ctx.fillText(m.unit, r.x + 26 + vw, r.y + 66);
    }
    ctx.fillStyle = t.cardSub;
    ctx.font = '24px sans-serif';
    ctx.fillText(m.label, r.x + 22, r.y + 114);
  });
}

/** 03 配速曲线：快=高、固定显示窗、均值虚线。 */
function drawPaceCurve(ctx: PosterCtx, t: PosterTheme, sec: DetailSection, curve: DetailPaceCurve): void {
  const r = sec.content;
  const padL = 76;
  const padR = 16;
  const padT = 26;
  const padB = 40;
  const plotW = r.w - padL - padR;
  const plotH = r.h - padT - padB;
  const { lo, hi } = PACE_WINDOW;
  const x = (v: number): number => r.x + padL + (Math.min(v, curve.xMax) / (curve.xMax || 1)) * plotW;
  const y = (pace: number): number => {
    const c = Math.max(lo, Math.min(hi, pace));
    return r.y + padT + (1 - (hi - c) / (hi - lo)) * plotH; // 快（小 s/km）→ 高
  };

  ctx.font = '22px sans-serif';
  for (const g of PACE_GRID) {
    const gy = y(g);
    ctx.strokeStyle = t.hairline;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(r.x + padL, gy);
    ctx.lineTo(r.x + r.w - padR, gy);
    ctx.stroke();
    ctx.fillStyle = t.cardSub;
    ctx.fillText(fmtMss(g), r.x + padL - 14, gy + 8);
  }
  ctx.textAlign = 'center';
  for (const tick of xTicks(curve.xMax, curve.xBasis)) ctx.fillText(xTickLabel(tick, curve.xBasis), x(tick), r.y + r.h - 12);
  ctx.textAlign = 'left';

  if (curve.avgSec != null) {
    const ay = y(curve.avgSec);
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([12, 10]);
    ctx.strokeStyle = t.accent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(r.x + padL, ay);
    ctx.lineTo(r.x + r.w - padR, ay);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.fillStyle = t.accent;
    ctx.font = 'bold 24px sans-serif';
    const label = `均值 ${fmtPaceQuote(curve.avgSec)}`;
    const w = ctx.measureText(label).width;
    ctx.fillText(label, r.x + r.w - padR - w, ay - 12);
  }

  ctx.strokeStyle = t.accent;
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  curve.points.forEach((p, i) => (i === 0 ? ctx.moveTo(x(p.x), y(p.v)) : ctx.lineTo(x(p.x), y(p.v))));
  ctx.stroke();
}

/** 04 心率曲线：面积 + 曲线 + Z5 阈值虚线。 */
function drawHrCurve(ctx: PosterCtx, t: PosterTheme, sec: DetailSection, curve: DetailHrCurve): void {
  const r = sec.content;
  const padL = 76;
  const padR = 16;
  const padT = 26;
  const padB = 40;
  const plotW = r.w - padL - padR;
  const plotH = r.h - padT - padB;

  let vMin = Infinity;
  let vMax = -Infinity;
  for (const p of curve.points) {
    if (p.v < vMin) vMin = p.v;
    if (p.v > vMax) vMax = p.v;
  }
  if (curve.z5 != null) {
    vMin = Math.min(vMin, curve.z5);
    vMax = Math.max(vMax, curve.z5);
  }
  vMin = Math.floor(vMin / 10) * 10;
  vMax = Math.ceil(vMax / 10) * 10;
  if (vMax - vMin < 30) vMax = vMin + 30;

  const x = (v: number): number => r.x + padL + (Math.min(v, curve.xMax) / (curve.xMax || 1)) * plotW;
  const y = (v: number): number => r.y + padT + (1 - (v - vMin) / (vMax - vMin)) * plotH;

  ctx.font = '22px sans-serif';
  for (let g = vMin; g <= vMax; g += 20) {
    const gy = y(g);
    ctx.strokeStyle = t.hairline;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(r.x + padL, gy);
    ctx.lineTo(r.x + r.w - padR, gy);
    ctx.stroke();
    ctx.fillStyle = t.cardSub;
    ctx.fillText(`${g}`, r.x + padL - 14, gy + 8);
  }
  ctx.textAlign = 'center';
  for (const tick of xTicks(curve.xMax, curve.xBasis)) ctx.fillText(xTickLabel(tick, curve.xBasis), x(tick), r.y + r.h - 12);
  ctx.textAlign = 'left';

  // 面积填充。
  ctx.beginPath();
  ctx.moveTo(x(curve.points[0].x), r.y + padT + plotH);
  for (const p of curve.points) ctx.lineTo(x(p.x), y(p.v));
  ctx.lineTo(x(curve.points[curve.points.length - 1].x), r.y + padT + plotH);
  ctx.closePath();
  fillAlpha(ctx, t.accent, 0.12);

  ctx.strokeStyle = t.accent;
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  curve.points.forEach((p, i) => (i === 0 ? ctx.moveTo(x(p.x), y(p.v)) : ctx.lineTo(x(p.x), y(p.v))));
  ctx.stroke();

  if (curve.z5 != null && curve.z5 >= vMin && curve.z5 <= vMax) {
    const zy = y(curve.z5);
    ctx.setLineDash([12, 10]);
    ctx.strokeStyle = t.danger;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(r.x + padL, zy);
    ctx.lineTo(r.x + r.w - padR, zy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = t.danger;
    ctx.font = 'bold 24px sans-serif';
    const label = `Z5 ${curve.z5}`;
    const w = ctx.measureText(label).width;
    ctx.fillText(label, r.x + r.w - padR - w, zy - 12);
  }
}

/** 05 心率区间分布：标签 / 轨道条 / 占比·时长。 */
function drawZoneBars(ctx: PosterCtx, t: PosterTheme, sec: DetailSection, rows: DetailZoneRow[]): void {
  const labelW = 170;
  const valW = 210;
  const trackX = sec.content.x + labelW + 16;
  const trackW = sec.content.w - labelW - valW - 32;
  const maxPct = Math.max(...rows.map((z) => z.pct), 0.01);
  rows.forEach((z, i) => {
    const cy = sec.content.y + i * ZONE_ROW_H + ZONE_ROW_H / 2;
    ctx.fillStyle = t.cardSub;
    ctx.font = '24px sans-serif';
    ctx.fillText(z.label, sec.content.x, cy + 9);

    const track: PosterRect = { x: trackX, y: cy - 11, w: trackW, h: 22 };
    roundRect(ctx, track, 11);
    ctx.fillStyle = t.bgSunken;
    ctx.fill();
    const bw = Math.max(8, (z.pct / maxPct) * trackW);
    const fill: PosterRect = { x: trackX, y: cy - 11, w: bw, h: 22 };
    roundRect(ctx, fill, 11);
    fillAlpha(ctx, t.accent, Math.min(0.92, 0.28 + i * 0.16));

    const val = `${Math.round(z.pct * 100)}% · ${fmtDurationShort(z.durS)}`;
    const w = ctx.measureText(val).width;
    ctx.fillStyle = t.cardInk;
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText(val, sec.content.x + sec.content.w - w, cy + 9);
  });
}

/** 06 每公里配速全量表：2 列全量行，底色按 tint，最快行实色高亮 + 角标。 */
function drawKmTable(ctx: PosterCtx, t: PosterTheme, sec: DetailSection, rows: DetailKmTableRow[]): void {
  const half = Math.ceil(rows.length / 2);
  const colW = (sec.content.w - 16) / 2;
  const drawCol = (from: number, to: number, cx: number): void => {
    for (let i = from; i < to; i++) {
      const row = rows[i];
      const y = sec.content.y + (i - from) * (TABLE_ROW_H + TABLE_ROW_GAP);
      const r: PosterRect = { x: cx, y, w: colW, h: TABLE_ROW_H };
      roundRect(ctx, r, 10);
      if (row.fastest) {
        ctx.fillStyle = t.accent;
      } else {
        ctx.globalAlpha = 0.05 + row.tint * 0.22;
        ctx.fillStyle = t.accent;
        ctx.globalAlpha = 1;
      }
      ctx.fill();
      ctx.fillStyle = row.fastest ? ON_ACCENT : t.cardSub;
      ctx.font = '22px sans-serif';
      ctx.fillText(`${row.ordinal}`, r.x + 18, y + 31);
      ctx.fillStyle = row.fastest ? ON_ACCENT : t.cardInk;
      ctx.font = 'bold 28px sans-serif';
      ctx.fillText(row.paceText, r.x + 64, y + 32);
      if (row.fastest) {
        ctx.font = 'bold 20px sans-serif';
        const w = ctx.measureText('最快').width;
        ctx.fillText('最快', r.x + r.w - w - 16, y + 31);
      }
    }
  };
  drawCol(0, half, sec.content.x);
  drawCol(half, rows.length, sec.content.x + colW + 16);
}

/** 节 meta 文案（右侧小字）。 */
function sectionMeta(kind: DetailSectionKind, model: DetailPosterModel): string {
  switch (kind) {
    case 'pace':
      return '3:30 – 7:00 /km · 快=高';
    case 'hr': {
      const parts: string[] = [];
      if (model.hrCurve?.avgHr != null) parts.push(`均值 ${model.hrCurve.avgHr}`);
      if (model.hrCurve?.maxHr != null) parts.push(`最大 ${model.hrCurve.maxHr}`);
      return parts.join(' · ');
    }
    case 'zones':
      return model.zones?.source === 'pctMax' ? '%最大心率法' : '校准区间';
    case 'table':
      return model.table?.header ?? '';
    default:
      return '';
  }
}

/**
 * 长图绘制入口（单窗口）：调用方把 canvas 变换对准绝对逻辑坐标（页面侧
 * setTransform(dpr,0,0,dpr,0,-win.y*dpr)），本函数按 win 窗口画底色切片并
 * 绘制与窗口相交的节（窗外内容被画布自然裁掉；不相交的节整节跳过省功耗）。
 * 同一 (layout, model, t) 逐窗口调用，拼接结果与「一张超长画布」逐像素一致。
 */
export function drawDetailPosterSlice(
  ctx: PosterCtx,
  t: PosterTheme,
  win: DetailWindow,
  layout: DetailLayout,
  model: DetailPosterModel,
  o: { mapImage: PosterImage | null; track: TrackPoint[][] | null; userName: string },
): void {
  // 主题底渐变切片（posterThemes bgStops 单源），只填窗口条。
  const bg = ctx.createLinearGradient(0, 0, 0, layout.height);
  for (const [offset, color] of t.bgStops) bg.addColorStop(offset, color);
  ctx.fillStyle = bg;
  ctx.fillRect(0, win.y, layout.width, win.h);

  drawBrand(ctx, t, layout, model);
  drawTitle(ctx, t, layout, model);

  for (const sec of layout.sections) {
    if (sec.rect.y >= win.y + win.h || sec.rect.y + sec.rect.h <= win.y) continue;
    card(ctx, t, sec.rect);
    drawSectionHead(ctx, t, sec, sectionMeta(sec.kind, model));
    switch (sec.kind) {
      case 'stats':
        drawStats(ctx, t, sec, model);
        break;
      case 'map': {
        const r = detailMapImageRect(layout);
        if (r) drawMapLayer(ctx, t, r, o.mapImage, o.track);
        break;
      }
      case 'pace':
        if (model.paceCurve) drawPaceCurve(ctx, t, sec, model.paceCurve);
        break;
      case 'hr':
        if (model.hrCurve) drawHrCurve(ctx, t, sec, model.hrCurve);
        break;
      case 'zones':
        if (model.zones) drawZoneBars(ctx, t, sec, model.zones.rows);
        break;
      case 'table':
        if (model.table) drawKmTable(ctx, t, sec, model.table.rows);
        break;
    }
  }

  drawFooterSignatureAt(ctx, t, layout, o.userName, model.dateFull);
}
