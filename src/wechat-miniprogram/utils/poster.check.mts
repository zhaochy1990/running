// poster.ts 自检：`node --import ./utils/ts-resolve-hooks.mjs utils/poster.check.mts`。
// 覆盖版式几何（四比例精确尺寸 / 内容底不越页脚线 / 抖音安全区避让 /
// 3:4 已发布几何回归锁 / 地图请求尺寸换算）、平台矩阵、配速条派生（恢复圈
// 剔除 / 最快标注 / 表头同源派生）、Z5 阈值、心率重采样、ellipsize。
// canvas 绘制函数不在此断言（node 无 wx）。
import {
  buildPaceBars,
  buildPosterModel,
  DOUYIN_SAFE_BOTTOM,
  DOUYIN_SAFE_RIGHT,
  ellipsize,
  posterMapRequestSize,
  POSTER_HEIGHT,
  POSTER_PLATFORMS,
  POSTER_WIDTH,
  posterLayout,
  resampleSeries,
  z5Threshold,
} from './poster.ts';
import type { ActivityDetailResponse, Segment, Zone } from '../types/activity.ts';

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

const ASPECTS = ['3:4', '9:16', '4:5', '1:1'] as const;

// ── 端到端 fixture（唯一数据源）：四比例同数据回归与 buildPosterModel
// 派生断言共用；bars/hr 都在场，各比例节策略的压制才可观测。 ──
const fixtureDetail: ActivityDetailResponse = {
  activity: {
    label_id: 'L1',
    name: '周末长距离',
    sport_type: 1,
    sport_name: 'Run',
    date: '2026-11-07T22:32:00+08:00',
    distance_m: 16093,
    distance_km: 16.09,
    duration_s: 4832,
    duration_fmt: '01:20:32',
    avg_pace_s_km: 300,
    pace_fmt: "5'00",
    avg_hr: 152,
    max_hr: 178,
    avg_cadence: 180,
    calories_kcal: 900,
    training_load: 120,
    vo2max: 55,
    train_type: 'Aerobic Endurance',
    ascent_m: 100,
  },
  segments: [
    {
      lap_index: 0, lap_type: 'autoKm', distance_m: 1000, distance_km: 1, duration_s: 300, duration_fmt: '05:00',
      avg_pace: 300, pace_fmt: '', adjusted_pace: 300, avg_hr: 150, max_hr: 160, avg_cadence: 180,
      avg_power: null, ascent_m: null, descent_m: null, seg_name: '训练', mode: 0,
    },
    {
      lap_index: 1, lap_type: 'autoKm', distance_m: 1000, distance_km: 1, duration_s: 280, duration_fmt: '04:40',
      avg_pace: 280, pace_fmt: '', adjusted_pace: 280, avg_hr: 155, max_hr: 165, avg_cadence: 182,
      avg_power: null, ascent_m: null, descent_m: null, seg_name: '训练', mode: 0,
    },
    {
      lap_index: 2, lap_type: 'autoKm', distance_m: 1000, distance_km: 1, duration_s: 320, duration_fmt: '05:20',
      avg_pace: 320, pace_fmt: '', adjusted_pace: 320, avg_hr: 148, max_hr: 158, avg_cadence: 178,
      avg_power: null, ascent_m: null, descent_m: null, seg_name: '训练', mode: 0,
    },
  ],
  zones: [
    { zone_type: 'heartRate', zone_index: 0, range_min: 100, range_max: 130, range_unit: 'bpm', duration_s: 600, percent: 20 },
    { zone_type: 'heartRate', zone_index: 1, range_min: 130, range_max: 150, range_unit: 'bpm', duration_s: 900, percent: 30 },
    { zone_type: 'heartRate', zone_index: 2, range_min: 165, range_max: null, range_unit: 'bpm', duration_s: 300, percent: 10 },
  ],
  timeseries: Array.from({ length: 50 }, (_, i) => ({
    timestamp: i * 10000,
    distance: i * 20000,
    heart_rate: 140 + (i % 20),
    speed: 3,
    adjusted_pace: 330,
    cadence: 180,
    altitude: 10,
    power: null,
    gps_lat: 31.2 + i * 1e-4,
    gps_lon: 121.5 + i * 1e-4,
  })),
  linked_scheduled_workout: { id: 7, abandoned_by_promote_at: null },
};
const fixtureModel = buildPosterModel(
  fixtureDetail,
  { name: '周末长距离', sportLabel: '跑步', trainTypeLabel: '有氧耐力', dateLabel: '11月7日 06:32' },
  '2026-11-07',
);
if (!fixtureModel.bars || !fixtureModel.hr) throw new Error('fixture must have bars + hr so policy suppression is observable');

// ── 版式：精确尺寸 + 内容底不越页脚线（文档流页脚不可能被压住的几何保证） ──
for (const aspect of ASPECTS) {
  for (const flags of [
    { hasMap: true, hasBars: true, hasHr: aspect === '9:16' },
    { hasMap: true, hasBars: false, hasHr: false },
    { hasMap: false, hasBars: true, hasHr: false },
    // 数据齐但策略表不画的节必须被压制（1:1 无配速条；心率卡仅 9:16）。
    { hasMap: true, hasBars: true, hasHr: true },
  ]) {
    const layout = posterLayout(aspect, flags);
    eq(layout.width, POSTER_WIDTH, `${aspect} width`);
    eq(layout.height, POSTER_HEIGHT[aspect], `${aspect} height`);
    if (flags.hasMap !== (layout.map != null)) throw new Error(`${aspect} map presence mismatch`);
    // 首节不压 chips：map/grid 顶 ≥ chips 底 + 12
    const firstTop = Math.min(...[layout.map, layout.grid].map((sec) => (sec ? sec.y : Infinity)));
    if (firstTop < layout.chips.y + layout.chips.h + 12) {
      throw new Error(`${aspect} ${JSON.stringify(flags)}: first section top ${firstTop} overlaps chips bottom`);
    }
    const sections = [layout.map, layout.grid, layout.bars, layout.hr].map((s) => s && s.y + s.h).filter((v): v is number => v != null);
    const bottom = Math.max(...sections);
    if (bottom > layout.footerLineY - 8) {
      throw new Error(`${aspect} ${JSON.stringify(flags)}: content bottom ${bottom} overflows footer line ${layout.footerLineY}`);
    }
    // 相邻节不重叠：上一节底 + ≥16 才到下一节顶
    const boxes = [layout.map, layout.grid, layout.bars, layout.hr].filter((b): b is { x: number; y: number; w: number; h: number } => b != null);
    for (let i = 1; i < boxes.length; i++) {
      if (boxes[i].y < boxes[i - 1].y + boxes[i - 1].h + 16) {
        throw new Error(`${aspect}: section ${i} overlaps previous (y ${boxes[i].y} < ${boxes[i - 1].y + boxes[i - 1].h + 16})`);
      }
    }
  }
}

// ── 节策略：心率卡仅 9:16；配速条 1:1 不画（高度只够地图+四宫格） ──
for (const aspect of ASPECTS) {
  const full = posterLayout(aspect, { hasMap: true, hasBars: true, hasHr: true });
  const wantHr = aspect === '9:16';
  if ((full.hr != null) !== wantHr) throw new Error(`${aspect} hr card policy`);
  const wantBars = aspect !== '1:1';
  if ((full.bars != null) !== wantBars) throw new Error(`${aspect} bars card policy`);
}

// ── 3:4 已发布几何回归锁（devops#944 定稿，勿随四比例铺开漂移） ──
{
  const l = posterLayout('3:4', { hasMap: true, hasBars: true, hasHr: false });
  eq(l.map && l.map.h, 440, '3:4 map height locked');
  eq(l.bars && l.bars.h, 200, '3:4 bars height locked');
  eq(l.footerLineY, 1332, '3:4 footer line locked');
  eq(l.footerTextY, 1384, '3:4 footer text locked');
  eq(l.contentRight, 1032, '3:4 no safe inset');
}

// ── 抖音 9:16 安全区避让（devops#948）：正文右缘让出右侧按钮栏、页脚底
// 上移出底部文案区；非 9:16 比例无避让。 ──
{
  const l = posterLayout('9:16', { hasMap: true, hasBars: true, hasHr: true });
  eq(l.contentRight, POSTER_WIDTH - 48 - DOUYIN_SAFE_RIGHT, '9:16 content right = safe right inset');
  eq(l.safeBottomY, POSTER_HEIGHT['9:16'] - DOUYIN_SAFE_BOTTOM, '9:16 safe bottom boundary');
  const rects = [l.chips, l.map, l.grid, l.bars, l.hr].filter((r): r is { x: number; y: number; w: number; h: number } => r != null);
  for (const r of rects) {
    if (r.x + r.w > l.contentRight + 0.5) throw new Error(`9:16 section leaks into right rail zone: ${JSON.stringify(r)}`);
  }
  // 关键数据（地图/四宫格/配速条/心率卡）整卡底不进底部文案区。
  for (const r of rects.slice(1)) {
    if (r.y + r.h > l.safeBottomY) throw new Error(`9:16 section leaks into caption zone: ${JSON.stringify(r)}`);
  }
  if (l.footerTextY > l.safeBottomY - 8) throw new Error(`9:16 footer text ${l.footerTextY} inside caption zone`);
  for (const aspect of ['3:4', '4:5', '1:1'] as const) {
    const o = posterLayout(aspect, { hasMap: true, hasBars: true, hasHr: true });
    eq(o.contentRight, POSTER_WIDTH - 48, `${aspect} no safe inset`);
    eq(o.safeBottomY, POSTER_HEIGHT[aspect], `${aspect} no safe bottom`);
  }
}

// ── 四比例同数据回归（票面验收）：同一份详情派生一次模型，四比例版式
// 全部装得下、节策略一致（1:1 丢配速条/心率卡，4:5 丢心率卡，9:16 收安全区）。
// fixture 与文末 buildPosterModel 断言块共用（唯一数据源）。
{
  for (const aspect of ASPECTS) {
    const layout = posterLayout(aspect, { hasMap: true, hasBars: fixtureModel.bars != null, hasHr: fixtureModel.hr != null });
    if (layout.map == null) throw new Error(`${aspect} map missing`);
    if ((layout.bars != null) !== (aspect !== '1:1')) throw new Error(`${aspect} same-data bars policy`);
    if ((layout.hr != null) !== (aspect === '9:16')) throw new Error(`${aspect} same-data hr policy`);
    const bottom = Math.max(...[layout.map, layout.grid, layout.bars, layout.hr].map((s) => (s ? s.y + s.h : 0)));
    if (bottom > layout.footerLineY - 8) throw new Error(`${aspect} same-data overflow`);
  }
}

// ── 平台矩阵（devops#948）：四平台标签唯一、比例恰好铺满四比例。 ──
{
  eq(POSTER_PLATFORMS.length, 4, 'four platforms');
  eq(new Set(POSTER_PLATFORMS.map((p) => p.label)).size, 4, 'platform labels unique');
  const aspects = POSTER_PLATFORMS.map((p) => p.aspect).sort();
  eq(aspects, [...ASPECTS].sort(), 'platform aspects cover all four');
}

// ── posterMapRequestSize：scale=2 出图 = 显示区像素；≥ API 下限 50 ──
for (const aspect of ASPECTS) {
  const size = posterMapRequestSize(aspect);
  const r = posterLayout(aspect, { hasMap: true, hasBars: true, hasHr: false }).mapImage;
  if (Math.abs(size.width * 2 - r.w) > 2 || Math.abs(size.height * 2 - r.h) > 2) throw new Error(`${aspect} map request size mismatch`);
  if (size.width < 50 || size.height < 50 || size.width > 900 || size.height > 900) throw new Error(`${aspect} map size out of range`);
}

// ── z5Threshold：最高档 range_min；开放区间 / 缺数据兜底 ──
{
  const zones: Zone[] = [
    { zone_type: 'heartRate', zone_index: 0, range_min: 100, range_max: 120, range_unit: 'bpm', duration_s: 60, percent: 10 },
    { zone_type: 'heartRate', zone_index: 1, range_min: 120, range_max: 140, range_unit: 'bpm', duration_s: 60, percent: 20 },
    { zone_type: 'heartRate', zone_index: 2, range_min: 140, range_max: null, range_unit: 'bpm', duration_s: 60, percent: 5 },
    { zone_type: 'pace', zone_index: 3, range_min: 240000, range_max: 300000, range_unit: 'ms/km', duration_s: 60, percent: 30 },
  ];
  eq(z5Threshold(zones), 140, 'z5 = top hr zone lower bound');
  eq(z5Threshold([]), null, 'no zones → null');
  eq(z5Threshold([zones[3]]), null, 'pace-only zones → null');
}

// ── buildPaceBars：恢复圈剔除 / 最快标注 / 表头派生 ──
{
  const seg = (avgPace: number | null, name = '训练', mode: number | null = 0): Segment => ({
    lap_index: 0,
    lap_type: 'autoKm',
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
  const out = buildPaceBars(segments);
  if (!out) throw new Error('bars should build');
  // 恢复圈（休息 mode3）与无配速段剔除：5 段进条
  eq(out.bars.length, 5, 'rest & pace-less segments dropped');
  const fastest = out.bars.findIndex((b) => b.fastest);
  eq(fastest, 3, 'fastest is the 240 s/km (4th kept)');
  eq(out.bars[fastest].secPerKm, 240, 'fastest pace');
  // 表头：最快段配速与序号（剔除后的公里序号）同源派生
  if (!out.header.includes(`4'00"`)) throw new Error(`header pace: ${out.header}`);
  if (!out.header.includes('第 4 公里')) throw new Error(`header ordinal: ${out.header}`);
  // 慢(320)→绿系、快(240)→红系：色值可读断言（G 通道快段更低）
  const slowBar = out.bars[2];
  const fastBar = out.bars[3];
  const gSlow = parseInt(slowBar.color.slice(3, 5), 16);
  const gFast = parseInt(fastBar.color.slice(3, 5), 16);
  if (gSlow <= gFast) {
    throw new Error(`slow bar should be greener than fast: ${slowBar.color} vs ${fastBar.color}`);
  }
  // 不足两段 → null
  eq(buildPaceBars([seg(300)]), null, '<2 paced segments → null');
  eq(buildPaceBars([]), null, 'empty → null');
  // 全同配速不标最快（无并列冠军）
  const flat = buildPaceBars([seg(300), seg(300), seg(300)]);
  if (flat && flat.bars.some((b) => b.fastest)) throw new Error('equal paces: no fastest highlight');
  // 超长段数抽稀后仍标唯一最快
  const many = buildPaceBars(Array.from({ length: 80 }, (_, i) => seg(300 + (i % 7) * 10)));
  if (!many) throw new Error('many bars should build');
  eq(many.bars.length <= 42, true, 'bars capped');
  eq(many.bars.filter((b) => b.fastest).length, 1, 'exactly one fastest after cap');
}

// ── resampleSeries ──
{
  const series = Array.from({ length: 1000 }, (_, i) => ({ t: i, v: i }));
  const out = resampleSeries(series, 180);
  eq(out.length, 180, 'resampled to 180');
  eq(out[0], { t: 0, v: 0 }, 'first kept');
  eq(out[179], { t: 999, v: 999 }, 'last kept');
  eq(resampleSeries(series, 2000).length, 1000, 'under max is identity');
}

// ── ellipsize ──
{
  const measure = (s: string) => s.length * 10;
  eq(ellipsize('short', 100, measure), 'short', 'fits untouched');
  eq(ellipsize('a very long title', 80, measure), 'a very …', 'ellipsized to fit');
  eq(ellipsize('中文字符标题超长截断测试', 60, measure), '中文字符标…', 'CJK ellipsis');
}

// ── buildPosterModel：端到端模型派生（fixture 在文件头，与四比例回归共用） ──
{
  const model = fixtureModel;
  eq(model.isPlanned, true, 'planned chip');
  eq(model.dateCapsule, '11月7日', 'date capsule');
  eq(model.dateFull, '2026年11月7日', 'footer date');
  eq(model.grid.length, 4, 'four-grid');
  eq(model.grid[0], { label: '距离', value: '16.09', unit: 'km' }, 'distance cell');
  eq(model.grid[1], { label: '时长', value: '01:20:32' }, 'duration cell');
  eq(model.grid[2], { label: '平均配速', value: `5'00"`, unit: '/km' }, 'pace cell');
  eq(model.grid[3], { label: '平均心率', value: '152', unit: 'bpm' }, 'hr cell');
  if (!model.bars || model.bars.length !== 3) throw new Error('bars from segments');
  if (!model.barsHeader || !model.barsHeader.includes(`4'40"`)) throw new Error(`fastest header ${model.barsHeader}`);
  if (!model.hr || model.hr.points.length < 2) throw new Error('hr series present');
  eq(model.hr.z5, 165, 'z5 from top zone');
  if (model.hr.points.length > 180) throw new Error('hr resampled');
}

console.log('poster.check: all assertions passed');
