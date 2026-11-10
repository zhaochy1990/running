// posterDetail.ts 自检：`node --import ./utils/ts-resolve-hooks.mjs utils/posterDetail.check.mts`。
// 覆盖版式几何（六节顺延 / 无重叠 / 页脚净空 / 34km 高度预算 / 缺节收拢）、
// 分段与分张规划（连续无缝 / 上限 / 节边界切张）、全量表派生（恢复圈剔除 /
// 最快高亮 / 表头同源 / tint 单调）、心率区间两路（activity_zones 与 %max
// 兜底数学）、配速曲线派生（通道优先 / dist+ts 推导兜底 / 显示窗常量）。
// canvas 绘制函数不在此断言（node 无 wx）。
import {
  buildDetailPosterModel,
  buildKmTable,
  buildZoneRows,
  detailLayout,
  detailMapRequestSize,
  drawDetailPosterSlice,
  DETAIL_MAX_HEIGHT,
  DETAIL_SEGMENT_H,
  DETAIL_WIDTH,
  PACE_WINDOW,
  planDetailParts,
  planDetailSlices,
  type DetailLayoutInput,
} from './posterDetail.ts';
import { buildPaceBars, pacedKmSplits } from './poster.ts';
import type { ActivityDetailResponse, Segment, TimeseriesPoint, Zone } from '../types/activity.ts';

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

// ── 版式：六节顺延 / 节序无重叠 / 页脚净空 / 高度自适应 ──
{
  const full: DetailLayoutInput = { hasMap: true, hasPace: true, hasHr: true, zoneRows: 5, tableRows: 17, tablePerKm: true };
  const layout = detailLayout(full);
  eq(layout.width, DETAIL_WIDTH, 'width 1080');
  eq(layout.sections.map((s) => `${s.no} ${s.kind}`), ['01 stats', '02 map', '03 pace', '04 hr', '05 zones', '06 table'], 'six sections in ticket order');
  eq(layout.sections.map((s) => s.title), ['总览数据', '轨迹', '配速曲线', '心率曲线', '心率区间分布', '每公里配速'], 'titles');
  for (let i = 1; i < layout.sections.length; i++) {
    const prev = layout.sections[i - 1].rect;
    const cur = layout.sections[i].rect;
    if (cur.y < prev.y + prev.h + 16) throw new Error(`section ${i} overlaps previous`);
  }
  const lastBottom = layout.sections[layout.sections.length - 1].rect.y + layout.sections[layout.sections.length - 1].rect.h;
  if (lastBottom >= layout.footerLineY) throw new Error('content overlaps footer line');
  // 34km 长课验收口径：单张内完整渲染（含 17 行全量表 + 双曲线）。
  if (layout.height > DETAIL_MAX_HEIGHT) throw new Error(`34km long-run layout ${layout.height} must fit single image`);
  if (layout.height < 3000 || layout.height > 3900) throw new Error(`34km height ${layout.height} out of expected band`);
  // 每节内容区在卡内、宽度一致。
  for (const s of layout.sections) {
    if (s.content.x < s.rect.x || s.content.w >= s.rect.w) throw new Error(`${s.kind} content outside card`);
  }

  // 缺节收拢：跑步机（无 GPS）→ 无 02 轨迹，序号顺延。
  const treadmill = detailLayout({ ...full, hasMap: false });
  eq(treadmill.sections.map((s) => `${s.no} ${s.kind}`), ['01 stats', '02 pace', '03 hr', '04 zones', '05 table'], 'no-map renumber');

  // 最小形态：只有八格总览。
  const minimal = detailLayout({ hasMap: false, hasPace: false, hasHr: false, zoneRows: 0, tableRows: 0, tablePerKm: true });
  eq(minimal.sections.map((s) => s.kind), ['stats'], 'stats-only');
  if (minimal.height >= full_heightOf(full)) throw new Error('minimal must be shorter');

  // 间歇组口径 → 表标题换「分段配速」。
  eq(detailLayout({ ...full, tablePerKm: false }).sections.find((s) => s.kind === 'table')?.title, '分段配速', 'interval table title');

  // 地图请求尺寸 = 显示区 ÷ 2（scale=2），≥ API 下限。
  const size = detailMapRequestSize(layout);
  const imgRect = layout.sections.find((s) => s.kind === 'map');
  if (!imgRect) throw new Error('map section missing');
  if (Math.abs(size.width * 2 - (imgRect.content.w - 20)) > 2) throw new Error('map request width mismatch');
  if (size.width < 50 || size.height < 50) throw new Error('map size below API floor');
  eq(detailMapRequestSize(minimal), { width: 50, height: 50 }, 'no map → floor');
}
function full_heightOf(o: DetailLayoutInput): number {
  return detailLayout(o).height;
}

// ── 分段规划：连续无缝 / 每段 ≤ 上限；分张：超高分张且切在节边界 ──
{
  for (const h of [100, DETAIL_SEGMENT_H, DETAIL_SEGMENT_H + 1, 3 * DETAIL_SEGMENT_H + 123]) {
    const slices = planDetailSlices(h);
    let cursor = 0;
    for (const s of slices) {
      if (s.y !== cursor) throw new Error(`slices not contiguous at ${s.y}`);
      if (s.h <= 0 || s.h > DETAIL_SEGMENT_H) throw new Error(`slice h ${s.h} out of band`);
      cursor = s.y + s.h;
    }
    if (cursor !== h) throw new Error(`slices cover ${cursor} of ${h}`);
  }

  // 正常 34km：单张。
  const normal = detailLayout({ hasMap: true, hasPace: true, hasHr: true, zoneRows: 5, tableRows: 17, tablePerKm: true });
  eq(planDetailParts(normal), [{ y: 0, h: normal.height }], 'fits single part');

  // 超马级（80 行全量表）→ 多张，每张 ≤ 上限（单节超限除外）、切在节顶。
  const ultra = detailLayout({ hasMap: true, hasPace: true, hasHr: true, zoneRows: 5, tableRows: 80, tablePerKm: true });
  if (ultra.height <= DETAIL_MAX_HEIGHT) throw new Error('ultra fixture must exceed cap');
  const parts = planDetailParts(ultra);
  if (parts.length < 2) throw new Error('ultra must split');
  const tops = new Set(ultra.sections.map((s) => s.rect.y));
  let cursor = 0;
  for (const p of parts) {
    if (p.y !== cursor) throw new Error(`parts not contiguous at ${p.y}`);
    const single = ultra.sections.some((s) => s.rect.y === p.y && s.rect.h > DETAIL_MAX_HEIGHT);
    if (!single && p.h > DETAIL_MAX_HEIGHT) throw new Error(`part ${p.h} exceeds cap`);
    if (p.y > 0 && !tops.has(p.y)) throw new Error(`part cut at ${p.y} not on section boundary`);
    cursor = p.y + p.h;
  }
  if (cursor !== ultra.height) throw new Error('parts do not cover full height');
}

// ── pacedKmSplits / buildKmTable：与概览卡同源、全量行、最快高亮 ──
{
  const seg = (avgPace: number | null, name = '训练', mode: number | null = 0, lapType = 'autoKm'): Segment => ({
    lap_index: 0,
    lap_type: lapType,
    distance_m: 1000,
    distance_km: 1,
    duration_s: 300,
    duration_fmt: '05:00',
    avg_pace: avgPace,
    pace_fmt: '',
    adjusted_pace: avgPace,
    avg_hr: 150,
    max_hr: 170,
    avg_cadence: 180,
    avg_power: null,
    ascent_m: null,
    descent_m: null,
    seg_name: name,
    mode,
  });

  const segments = [seg(300), seg(280), seg(320), seg(null), seg(290, '休息', 3), seg(240), seg(300)];
  const { splits, fastestIdx } = pacedKmSplits(segments);
  eq(splits.length, 5, 'rest & pace-less dropped');
  eq(splits.map((s) => s.ordinal), [1, 2, 3, 4, 5], 'ordinals compact');
  eq(fastestIdx, 3, 'fastest is 240s (4th kept)');

  // 同源：表头与概览卡配速条表头同派生（最快配速 + 公里序号一致）。
  const bars = buildPaceBars(segments);
  const table = buildKmTable(segments);
  if (!bars || !table) throw new Error('both derivations should build');
  eq(table.rows.length, 5, 'full table keeps all rows');
  eq(table.rows.find((r) => r.fastest)?.ordinal, 4, 'fastest row ordinal');
  if (!table.header.includes(`4'00"`)) throw new Error(`table header pace: ${table.header}`);
  if (!bars.header.includes(`4'00"`) || !bars.header.includes('第 4 公里')) throw new Error(`bars header: ${bars.header}`);
  if (!table.header.includes('第 4 公里')) throw new Error(`table header ordinal: ${table.header}`);
  eq(table.perKm, true, 'autoKm table is per-km');

  // tint：最快行取最大 tint（快=深）。
  const fastestTint = table.rows.find((r) => r.fastest)?.tint;
  if (fastestTint !== Math.max(...table.rows.map((r) => r.tint))) throw new Error('fastest row must carry max tint');

  // 全同配速：无最快（与概览卡口径一致）。
  const flat = buildKmTable([seg(300), seg(300), seg(300)]);
  if (flat && flat.rows.some((r) => r.fastest)) throw new Error('equal paces: no fastest');
  eq(buildKmTable([seg(300)]), null, '<2 → null');
  eq(buildKmTable([]), null, 'empty → null');

  // 间歇组 → 「分段」口径。
  const intervals = buildKmTable([seg(280, '训练', 0, 'type2'), seg(300, '训练', 0, 'type2'), seg(260, '训练', 0, 'type2')]);
  if (!intervals) throw new Error('interval table builds');
  eq(intervals.perKm, false, 'type2 not per-km');
  if (!intervals.header.includes('第 3 段')) throw new Error(`interval header unit: ${intervals.header}`);
}

// ── buildZoneRows：activity_zones 生产路 + %max 兜底路 ──
{
  const zone = (idx: number, min: number | null, max: number | null, dur: number | null, pct: number | null): Zone => ({
    zone_type: 'heartRate', zone_index: idx, range_min: min, range_max: max, range_unit: 'bpm', duration_s: dur, percent: pct,
  });
  // 生产路：percent 缺失时从 duration 派生；开放边界标签。
  const zones = [zone(0, 100, 120, 600, null), zone(1, 120, 150, 1800, null), zone(2, 150, null, 600, null)];
  const out = buildZoneRows(zones, [], null);
  if (!out) throw new Error('zones path should build');
  eq(out.source, 'zones', 'zones source');
  eq(out.rows.map((r) => r.label), ['Z1 100-120', 'Z2 120-150', 'Z3 ≥150'], 'zone labels with open top');
  eq(out.rows.map((r) => Math.round(r.pct * 100)), [20, 60, 20], 'pct derived from durations');
  // 首档与次档共享下界 → 首档开放为 `<`。
  const shared = buildZoneRows([zone(0, 120, 120, 60, null), zone(1, 120, 150, 540, null), zone(2, 150, null, 600, null)], [], null);
  eq(shared?.rows[0].label, 'Z1 <120', 'shared-bound first zone opens below');

  // 兜底路：%max 五分法（POC 数学）。1 分钟 100bpm（50%max → Z1）+ 2 分钟 150bpm（75%max → Z3），max 200。
  const ts: TimeseriesPoint[] = [
    { timestamp: 0, distance: 0, heart_rate: 100, speed: null, adjusted_pace: null, cadence: null, altitude: null, power: null, gps_lat: null, gps_lon: null },
    { timestamp: 6000, distance: 5, heart_rate: 150, speed: null, adjusted_pace: null, cadence: null, altitude: null, power: null, gps_lat: null, gps_lon: null },
    { timestamp: 18000, distance: 10, heart_rate: 150, speed: null, adjusted_pace: null, cadence: null, altitude: null, power: null, gps_lat: null, gps_lon: null },
  ];
  const fb = buildZoneRows(
    [],
    ts.map((p) => ({ t: (p.timestamp as number) / 100, hr: p.heart_rate })),
    200,
  );
  if (!fb) throw new Error('pctMax fallback should build');
  eq(fb.source, 'pctMax', 'fallback source');
  eq(fb.rows.length, 5, 'five bands');
  eq(fb.rows.map((r) => r.durS), [60, 0, 120, 0, 0], 'band durations from ts deltas (厘秒→秒)');
  eq(fb.rows.map((r) => r.label), ['Z1 <120', 'Z2 120-140', 'Z3 140-160', 'Z4 160-180', 'Z5 ≥180'], 'fallback band labels');
  // 无 max_hr / 无序列 → null。
  eq(buildZoneRows([], ts, null), null, 'no max_hr → null');
  eq(buildZoneRows([], [], 200), null, 'no series → null');
}

// ── buildDetailPosterModel：端到端模型（通道配速 / km 基横轴 / pause 剔除） ──
{
  const ts: TimeseriesPoint[] = [];
  // 10km 均速 5:00/km：每 75s（厘秒 7500）一个点、250m、pace 300。
  for (let i = 0; i <= 40; i++) {
    ts.push({
      timestamp: i * 7500, distance: i * 250, heart_rate: 150 + (i % 5), speed: null,
      adjusted_pace: i % 4 === 0 ? null : 300, // 通道缺口走 dist+ts 推导兜底
      cadence: 180, altitude: 10, power: null,
      gps_lat: 31.2 + i * 1e-4, gps_lon: 121.5 + i * 1e-4,
    });
  }
  const segments: Segment[] = Array.from({ length: 10 }, (_, i) => ({
    lap_index: i, lap_type: 'autoKm', distance_m: 1000, distance_km: 1, duration_s: 300, duration_fmt: '05:00',
    avg_pace: 300, pace_fmt: '', adjusted_pace: 300, avg_hr: 150, max_hr: 160, avg_cadence: 180,
    avg_power: null, ascent_m: null, descent_m: null, seg_name: '训练', mode: 0,
  }));
  const zones: Zone[] = [
    { zone_type: 'heartRate', zone_index: 0, range_min: 100, range_max: 130, zone_unit: 'bpm', duration_s: 600, percent: 20 },
    { zone_type: 'heartRate', zone_index: 1, range_min: 130, range_max: 150, zone_unit: 'bpm', duration_s: 900, percent: 30 },
    { zone_type: 'heartRate', zone_index: 2, range_min: 165, range_max: null, zone_unit: 'bpm', duration_s: 300, percent: 10 },
  ];
  const detail: ActivityDetailResponse = {
    activity: {
      label_id: 'L1', name: '长距离', sport_type: 1, sport_name: 'Run', date: '2026-11-07T22:32:00+08:00',
      distance_m: 10000, distance_km: 10, duration_s: 3000, duration_fmt: '00:50:00', avg_pace_s_km: 300, pace_fmt: "5'00",
      avg_hr: 152, max_hr: 178, avg_cadence: 184, avg_step_len_cm: 125, calories_kcal: 700, training_load: 120, vo2max: 55,
      train_type: 'Aerobic Endurance', ascent_m: 100,
    },
    segments, zones, timeseries: ts,
    linked_scheduled_workout: { id: 7, abandoned_by_promote_at: null },
  };
  const model = buildDetailPosterModel(detail, { name: '长距离', sportLabel: '跑步', trainTypeLabel: '有氧耐力', dateLabel: '11月8日 06:32' }, '2026-11-08');
  eq(model.stats.length, 8, 'eight stats');
  eq(model.stats[0], { label: '距离', value: '10', unit: 'km' }, 'distance stat');
  eq(model.stats[6], { label: '步幅', value: '1.25', unit: 'm' }, 'stride stat');
  eq(model.stats[7], { label: '爬升', value: '100', unit: 'm' }, 'ascent stat');
  eq(model.dateCapsule, '11月8日', 'capsule');
  if (!model.paceCurve) throw new Error('pace curve present');
  eq(model.paceCurve.xBasis, 'km', 'km basis when dist channel present');
  if (Math.abs(model.paceCurve.xMax - 10) > 0.01) throw new Error(`xMax ${model.paceCurve.xMax}`);
  eq(model.paceCurve.avgSec, 300, 'avg from official avg_pace');
  // 通道缺口（每 4 点 1 个 null）由 dist+ts 推导补齐（dd=4000m+，dt≈480s → ~300 s/km）。
  const missing = model.paceCurve.points.filter((p) => Math.abs(p.v - 300) > 30);
  if (missing.length) throw new Error(`derived fallback left gaps: ${missing.length} pts off 300`);
  if (!model.hrCurve) throw new Error('hr curve present');
  eq(model.hrCurve.z5, 165, 'z5 from top zone');
  if (!model.zones || model.zones.source !== 'zones') throw new Error('zones from activity_zones');
  if (!model.table || model.table.rows.length !== 10) throw new Error('table 10 rows');
  if (model.hrCurve.points.length > 240 || model.paceCurve.points.length > 240) throw new Error('curves resampled');

  // 无 dist 通道 → t 基（分钟）。
  const noDist = buildDetailPosterModel(
    { ...detail, timeseries: ts.map((p) => ({ ...p, distance: null })) },
    { name: 'x', sportLabel: '跑步', trainTypeLabel: '', dateLabel: '' },
    '2026-11-08',
  );
  if (!noDist.paceCurve) throw new Error('pace curve from channel without dist');
  eq(noDist.paceCurve.xBasis, 't', 'time basis without dist');
  // 末点通道空且无 dist 不可推导 → 序列止于最后一个有效点（39×75s = 48.75min）。
  if (Math.abs(noDist.paceCurve.xMax - 48.75) > 0.01) throw new Error(`t xMax ${noDist.paceCurve.xMax}`);

  // pause 窗口内的心率不进任何派生（兜底区间时长不含 pause）。
  const paused = buildDetailPosterModel(
    { ...detail, activity: { ...detail.activity, pauses: [{ start_ts: 0, end_ts: 6000, type: 1 }] }, zones: [] },
    { name: 'x', sportLabel: '跑步', trainTypeLabel: '', dateLabel: '' },
    '2026-11-08',
  );
  if (paused.zones?.source !== 'pctMax') throw new Error('fallback engaged without zones');
  const durTotal = (paused.zones?.rows ?? []).reduce((s, r) => s + r.durS, 0);
  // pause [0,60s] 只吞掉 i=0 点及其 75s 间隔：2925 = 3000 - 75。
  eq(durTotal, 2925, 'pause interval excluded from zone durations');

  // 显示窗常量（票面口径 3:30-7:00）。
  eq([PACE_WINDOW.lo, PACE_WINDOW.hi], [210, 420], 'pace display window');
}
console.log('posterDetail.check: all assertions passed');

// ── 零散落 hex：posterDetail.ts 绘制源码只允许 ON_ACCENT 一处白字常量
//（POC 九套主题最快行/徽标白字的既定口径，posterThemes.check 的 poster.ts
// 零 hex 同款纪律；其余颜色必须走 PosterTheme 字段）。 ──
{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'posterDetail.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const hexes = src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  if (hexes.length !== 1 || hexes[0] !== '#ffffff') {
    throw new Error(`posterDetail.ts 只允许 ON_ACCENT 一处 #ffffff，实得：${hexes.join(', ')}`);
  }
}

// ── 九主题 × 全节长图出图冒烟 + 颜色闭包（posterThemes.check 同款方法）：
// 录制 ctx 捕获全部颜色串，断言 ∈ 主题 token ∪ ON_ACCENT ∪ gradient3 色板路径。 ──
{
  const { POSTER_THEMES } = await import('./posterThemes.ts');
  const { gradient3, PACE_SLOW_GREEN, PACE_FAST_RED } = await import('./posterGradient.ts');

  const drawn = new Set<string>();
  const gradientStops: string[] = [];
  const mockCtx: Parameters<typeof drawDetailPosterSlice>[0] = {
    get fillStyle() {
      return '';
    },
    set fillStyle(v) {
      if (typeof v === 'string') drawn.add(v);
    },
    get strokeStyle() {
      return '';
    },
    set strokeStyle(v) {
      drawn.add(v);
    },
    lineWidth: 0,
    lineCap: 'butt',
    font: '',
    globalAlpha: 1,
    textAlign: 'left',
    fillRect() {},
    strokeRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    closePath() {},
    fill() {},
    stroke() {},
    fillText() {},
    measureText(text: string) {
      return { width: text.length * 30 };
    },
    createLinearGradient() {
      return { addColorStop(_o: number, color: string) { gradientStops.push(color); } };
    },
    setLineDash() {},
    save() {},
    restore() {},
    clip() {},
    drawImage() {},
  };

  // 满配模型：六节全覆盖（含矢量降级地图、最快行、%max 兜底区间）。
  const model: DetailPosterModel = {
    title: '周末长距离',
    sportLabel: '跑步',
    trainTypeLabel: '有氧耐力',
    isPlanned: true,
    dateCapsule: '11月7日',
    dateFull: '2026年11月7日',
    stats: [
      { label: '距离', value: '16.09', unit: 'km' },
      { label: '时长', value: '01:20:32' },
      { label: '平均配速', value: `5'00"`, unit: '/km' },
      { label: '平均心率', value: '152', unit: 'bpm' },
      { label: '最大心率', value: '178', unit: 'bpm' },
      { label: '步频', value: '184', unit: 'spm' },
      { label: '步幅', value: '1.25', unit: 'm' },
      { label: '爬升', value: '100', unit: 'm' },
    ],
    paceCurve: { points: Array.from({ length: 40 }, (_, i) => ({ x: i * 0.4, v: 300 + (i % 5) * 20 })), xBasis: 'km', xMax: 16, avgSec: 300 },
    hrCurve: { points: Array.from({ length: 40 }, (_, i) => ({ x: i * 0.4, v: 140 + (i % 20) })), xBasis: 'km', xMax: 16, z5: 165, avgHr: 152, maxHr: 178 },
    zones: {
      rows: [1, 2, 3, 4, 5].map((z) => ({ label: `Z${z}`, pct: z / 15, durS: z * 120 })),
      source: 'pctMax',
    },
    table: {
      rows: [1, 2, 3, 4, 5, 6].map((k) => ({ ordinal: k, paceText: `4'0${k}"`, tint: k / 6, fastest: k === 3 })),
      header: `最快 4'03"/km · 第 3 公里`,
      perKm: true,
    },
  };
  const track = [
    Array.from({ length: 40 }, (_, i) => ({ latitude: 31.2 + i * 1e-4, longitude: 121.5 + i * 1e-4, pace: 300 + (i % 7) * 10 })),
  ];

  const layout = detailLayout({ hasMap: true, hasPace: true, hasHr: true, zoneRows: 5, tableRows: 6, tablePerKm: true });
  for (const t of POSTER_THEMES) {
    for (const part of planDetailParts(layout)) {
      for (const sl of planDetailSlices(part.h)) {
        try {
          drawDetailPosterSlice(mockCtx, t, { y: part.y + sl.y, h: sl.h }, layout, model, { mapImage: null, track, userName: '测试跑者' });
        } catch (err) {
          throw new Error(`${t.key} 长图出图抛错：${String(err)}`);
        }
      }
    }
  }

  const allowed = new Set<string>(['#ffffff', PACE_SLOW_GREEN, PACE_FAST_RED]);
  const colorFields: Array<keyof (typeof POSTER_THEMES)[number]> = [
    'ink', 'sub', 'tertiary', 'cardInk', 'cardSub', 'card', 'chip', 'hairline', 'bgSunken', 'accent', 'accentDeep', 'danger',
  ];
  for (const t of POSTER_THEMES) {
    for (const field of colorFields) allowed.add(String(t[field]));
    for (const [, color] of t.bgStops) allowed.add(color);
  }
  const hexToRgb = (h: string): [number, number, number] => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
  const rampA = hexToRgb(PACE_SLOW_GREEN);
  const rampB = hexToRgb(gradient3(0.5));
  const rampC = hexToRgb(PACE_FAST_RED);
  const onRamp = (h: string): boolean => {
    const [r, g, b] = hexToRgb(h);
    const near = (x: number, y: number): boolean => Math.abs(x - y) <= 2;
    return ([rampA, rampB, rampC].some((p) => near(r, p[0]) && near(g, p[1]) && near(b, p[2])))
      || ((r >= Math.min(rampA[0], rampB[0]) - 2 && r <= Math.max(rampA[0], rampB[0]) + 2
        && g >= Math.min(rampA[1], rampB[1]) - 2 && g <= Math.max(rampA[1], rampB[1]) + 2
        && b >= Math.min(rampA[2], rampB[2]) - 2 && b <= Math.max(rampA[2], rampB[2]) + 2)
        || (r >= Math.min(rampB[0], rampC[0]) - 2 && r <= Math.max(rampB[0], rampC[0]) + 2
          && g >= Math.min(rampB[1], rampC[1]) - 2 && g <= Math.max(rampB[1], rampC[1]) + 2
          && b >= Math.min(rampB[2], rampC[2]) - 2 && b <= Math.max(rampB[2], rampC[2]) + 2));
  };
  for (const color of [...drawn, ...gradientStops]) {
    if (allowed.has(color)) continue;
    if (/^#[0-9a-fA-F]{6}$/.test(color) && onRamp(color)) continue;
    throw new Error(`长图绘制出现闭包外颜色：${color}`);
  }
}
