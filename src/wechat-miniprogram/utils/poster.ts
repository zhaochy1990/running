/**
 * 活动概览分享海报（devops#944，Epic #601 P2；四比例铺齐 devops#948 P6）——
 * 设计文档 docs/activity-share-poster-design.md §3 定稿版式的 canvas 实现：
 * 小红书 3:4（1080×1440）/ 抖音 9:16（1080×1920）/ 朋友圈 4:5（1080×1350）/
 * 通用 1:1（1080×1080），平台矩阵见 POSTER_PLATFORMS。
 *
 * 自上而下：品牌行 / 课名+chips / 地图 hero（腾讯静态图，缺图降级矢量占位，
 * 见 utils/posterMap.ts）/ 四宫格大数字（距离渐变字）/ 每公里配速条 /
 * 【仅 9:16】心率曲线卡（面积曲线 + Z5 阈值虚线）/ 文档流页脚。
 * 9:16 为抖音专属比例，正文整体收进 DOUYIN_SAFE_* 安全区（右侧按钮栏 /
 * 底部文案区不压关键数据）；1:1 高度只够地图+四宫格最小信息集（§3 策略表）。
 *
 * 数据口径：每公里分段用后端 segments（勿用 ts 自算与厂商 best_km_pace 混搭，
 * 表头与表内同源派生）；心率区间用 activity_zones（Z5 = 最高档 range_min）；
 * 视觉 token 引 utils/theme.ts 单源；训练负荷文案；标题超长 ellipsize。
 *
 * 布局与派生是纯函数（posterLayout / buildPosterModel / resampleSeries），
 * `utils/poster.check.mts` 自检进 CI；canvas 绘制函数保持薄。
 */
import type { ActivityDetailResponse, Segment, Zone } from '../types/activity';
import { buildHrSeries } from './curve';
import { lapPaceMarks } from './lapRows';
import { theme } from './theme';
import { gradient3, PACE_SLOW_GREEN, PACE_FAST_RED } from './posterGradient';
import { fmtHms, fmtPaceQuote, fmtPaceQuoteParts } from './format';
import { trackBBox, type TrackPoint } from './posterMap';

/** 海报比例。 */
export type PosterAspect = '3:4' | '9:16' | '4:5' | '1:1';

export const POSTER_WIDTH = 1080;
export const POSTER_HEIGHT: Record<PosterAspect, number> = { '3:4': 1440, '9:16': 1920, '4:5': 1350, '1:1': 1080 };

/** 平台矩阵（devops#948）：分享页选目标平台 → 出对应比例，用户不手动裁
 * （设计文档 §2）。label 直接进 wx.showActionSheet 的 itemList。 */
export interface PosterPlatform {
  label: string;
  aspect: PosterAspect;
}
export const POSTER_PLATFORMS: readonly PosterPlatform[] = [
  { label: '小红书 3:4', aspect: '3:4' },
  { label: '抖音 9:16', aspect: '9:16' },
  { label: '朋友圈 4:5', aspect: '4:5' },
  { label: '通用 1:1', aspect: '1:1' },
];

/** 抖音 9:16 安全区（devops#948 实测口径，保守取整）：
 * - SAFE_RIGHT 168px：图文 feed 右侧按钮栏（头像/点赞/评论/分享/收藏）横行
 *   ~x 912-1080，纵向 ~y 340-1500；
 * - SAFE_BOTTOM 336px：底部文案区（caption + 话题 + 音乐行）整宽压底。
 * 9:16 版式的正文右缘与页脚底分别退到两界之内（品牌行/标题/chips 在遮挡
 * 纵向范围之上，但也统一按 contentRight 收口，保持整版单列）。数值待
 * 真机发布回归校准（挂 devops#949 E2E）。 */
export const DOUYIN_SAFE_RIGHT = 168;
export const DOUYIN_SAFE_BOTTOM = 336;

/** 海报纸面留白与卡片间距。 */
const PAD = 48;
const GAP = 28;
const CARD_INSET = 10;

/** 心率曲线重采样点数上限（卡片内宽 ~950px，再多看不出差别）。 */
const MAX_HR_POINTS = 180;

/** 配速条单卡最多展示的段数（超出按等距抽稀；超长距离的极端形态）。 */
const MAX_BARS = 42;

// ---------------------------------------------------------------------------
// 数据派生（纯函数）
// ---------------------------------------------------------------------------

/** 每公里（分段）配速条：color = 该段配速（gradient3 绿慢红快），最快段高亮。 */
export interface PosterBar {
  /** s/km */
  secPerKm: number;
  color: string;
  fastest: boolean;
}

/** 心率曲线卡数据：重采样序列 + Z5 阈值（无区间数据时 null）。 */
export interface PosterHr {
  points: Array<{ t: number; v: number }>;
  z5: number | null;
}

/** 海报数据模型：页面在 buildView 时一次算好，渲染只读。 */
export interface PosterModel {
  title: string;
  sportLabel: string;
  trainTypeLabel: string;
  /** 关联了 STRIDE 计划课（linked_scheduled_workout 存在）时展示 chip。 */
  isPlanned: boolean;
  /** 日期胶囊：如「11月7日」。 */
  dateCapsule: string;
  /** 页脚署名日期：如「2026年11月7日」。 */
  dateFull: string;
  /** 四宫格：距离 / 时长 / 平均配速 / 平均心率。 */
  grid: Array<{ label: string; value: string; unit?: string }>;
  /** 配速条（含表头文案）；null = 无有效分段，整卡不画。 */
  bars: PosterBar[] | null;
  barsHeader: string | null;
  /** 心率曲线卡；null = 无心率数据，整卡不画。 */
  hr: PosterHr | null;
}

/** 等距重采样（首尾点保留）。 */
export function resampleSeries(series: Array<{ t: number; v: number }>, max: number): Array<{ t: number; v: number }> {
  if (series.length <= max) return series.slice();
  const stride = (series.length - 1) / (max - 1);
  const out: Array<{ t: number; v: number }> = [];
  for (let i = 0; i < max; i++) out.push(series[Math.round(i * stride)]);
  return out;
}

/** 心率 Z5 阈值 = 校准/手表心率区间里最高档的下界（bpm）。 */
export function z5Threshold(zones: Zone[]): number | null {
  const hr = zones.filter((z) => z.zone_type === 'heartRate' && z.range_min != null);
  if (!hr.length) return null;
  const top = hr.reduce((a, b) => (b.zone_index > a.zone_index ? b : a));
  return Math.round(top.range_min as number);
}

/** 分段 → 配速条：恢复圈不计；最快 = 有配速段里 avg_pace 最小者（≥2 段才标）。 */
export function buildPaceBars(segments: Segment[]): { bars: PosterBar[]; header: string } | null {
  const marks = lapPaceMarks(segments);
  const paced: Array<{ seg: Segment; ordinal: number }> = [];
  let ordinal = 0;
  segments.forEach((seg, i) => {
    if (marks[i].rest) return;
    if (seg.avg_pace == null || !(seg.avg_pace > 0)) return;
    ordinal += 1;
    paced.push({ seg, ordinal });
  });
  if (paced.length < 2) return null;

  const paces = paced.map((p) => p.seg.avg_pace as number);
  const min = Math.min(...paces);
  const max = Math.max(...paces);
  // 全部同配速时不分高下（lapPaceMarks 同款约定），不标最快。
  if (min === max) return { bars: paced.map((p) => ({ secPerKm: min, color: gradient3(0), fastest: false })), header: `${fmtPaceQuote(min)}/km` };
  const fastestIdx = paced.findIndex((p) => p.seg.avg_pace === min);

  let bars = paced.map((p) => {
    const t = max > min ? (max - (p.seg.avg_pace as number)) / (max - min) : 0;
    return { secPerKm: p.seg.avg_pace as number, color: gradient3(t), fastest: false };
  });
  // 极端段数抽稀（保留最快段的位置语义：抽稀后重算最快）。
  if (bars.length > MAX_BARS) {
    const keep: PosterBar[] = [];
    const stride = bars.length / MAX_BARS;
    for (let i = 0; i < MAX_BARS; i++) keep.push(bars[Math.floor(i * stride)]);
    bars = keep;
    let fi = 0;
    bars.forEach((b, i) => {
      if (b.secPerKm < bars[fi].secPerKm) fi = i;
    });
    bars.forEach((b) => {
      b.fastest = false;
    });
    bars[fi].fastest = true;
  } else {
    bars[fastestIdx].fastest = true;
  }

  const fastestPace = min;
  const fastestOrdinal = paced[fastestIdx].ordinal;
  const [m, s] = fmtPaceQuoteParts(fastestPace);
  return { bars, header: `最快 ${m}${s}/km · 第 ${fastestOrdinal} 公里` };
}

/** 详情 → 海报模型。header 由页面传（SPORT_CN 等映射单源在页面）。 */
export function buildPosterModel(
  detail: ActivityDetailResponse,
  header: { name: string; sportLabel: string; trainTypeLabel: string; dateLabel: string },
  dateIso: string,
): PosterModel {
  const a = detail.activity;
  const bars = buildPaceBars(detail.segments || []);
  const hrSeries = buildHrSeries(detail.timeseries || []);
  const hr = hrSeries.length > 1 ? { points: resampleSeries(hrSeries, MAX_HR_POINTS), z5: z5Threshold(detail.zones || []) } : null;

  // 日期：详情 date 已是上海本地日期（后端序列化前已转）。
  const ymd = (dateIso || '').slice(0, 10);
  const [, mm, dd] = ymd.split('-');
  const monthDay = mm && dd ? `${Number(mm)}月${Number(dd)}日` : '';
  const dateFull = ymd ? `${ymd.slice(0, 4)}年${monthDay}` : '';

  return {
    title: header.name,
    sportLabel: header.sportLabel,
    trainTypeLabel: header.trainTypeLabel,
    isPlanned: Boolean(detail.linked_scheduled_workout),
    dateCapsule: monthDay || header.dateLabel,
    dateFull,
    grid: [
      { label: '距离', value: `${a.distance_km}`, unit: 'km' },
      { label: '时长', value: a.duration_fmt || fmtHms(a.duration_s) },
      { label: '平均配速', value: fmtPaceQuote(a.avg_pace_s_km), unit: '/km' },
      { label: '平均心率', value: a.avg_hr != null ? `${Math.round(a.avg_hr)}` : '—', unit: 'bpm' },
    ],
    bars: bars ? bars.bars : null,
    barsHeader: bars ? bars.header : null,
    hr,
  };
}

// ---------------------------------------------------------------------------
// 版式（纯函数）
// ---------------------------------------------------------------------------

export interface PosterRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PosterLayout {
  width: number;
  height: number;
  pad: number;
  /** 正文右缘 x（width - pad - 安全区右让位）；标题/chips/卡体/页脚统一收口。 */
  contentRight: number;
  /** 底部遮挡区上界 y（无避让比例 = height）。 */
  safeBottomY: number;
  /** 品牌行文字基线。 */
  brandY: number;
  /** 课名基线。 */
  titleY: number;
  /** chips 行。 */
  chips: PosterRect;
  /** 地图卡；null = 无 GPS 轨迹（如力量训练），整卡不画、下节上移。 */
  map: PosterRect | null;
  /** 地图图像绘制区（card 内缩 CARD_INSET）；随 map 为 null。 */
  mapImage: PosterRect | null;
  grid: PosterRect;
  bars: PosterRect | null;
  hr: PosterRect | null;
  footerLineY: number;
  footerTextY: number;
}

/** 各比例版式策略（§2/§3）：地图卡高 / 是否画配速条 / 心率卡高（null 不画）/
 * 安全区避让（抖音 9:16 专属）。9:16 收进安全画幅后地图 560→360、心率卡
 * 316→220；1:1 只够地图 300 + 四宫格的最小信息集（配速条/心率卡不画）。 */
interface AspectPolicy {
  mapH: number;
  bars: boolean;
  hrH: number | null;
  safeRight: number;
  safeBottom: number;
}
const ASPECT_POLICY: Record<PosterAspect, AspectPolicy> = {
  '3:4': { mapH: 440, bars: true, hrH: null, safeRight: 0, safeBottom: 0 },
  '9:16': { mapH: 360, bars: true, hrH: 220, safeRight: DOUYIN_SAFE_RIGHT, safeBottom: DOUYIN_SAFE_BOTTOM },
  '4:5': { mapH: 340, bars: true, hrH: null, safeRight: 0, safeBottom: 0 },
  '1:1': { mapH: 300, bars: false, hrH: null, safeRight: 0, safeBottom: 0 },
};

/** 定稿版式：固定节序 + 缺卡自动收拢（无地图 / 无分段 / 无心率逐级上移）；
 * 断言内容底不越页脚线、节序不重叠、9:16 全节收进安全区（check.mts）。 */
export function posterLayout(aspect: PosterAspect, o: { hasMap: boolean; hasBars: boolean; hasHr: boolean }): PosterLayout {
  const p = ASPECT_POLICY[aspect];
  const width = POSTER_WIDTH;
  const height = POSTER_HEIGHT[aspect];
  const inner = width - PAD * 2 - p.safeRight;
  const contentRight = width - PAD - p.safeRight;

  const brandY = 76;
  const titleY = 168;
  const chips: PosterRect = { x: PAD, y: 204, w: inner, h: 52 };
  // 内容顶：chips 底（204+52=256）之下留 16px 呼吸。
  let y = 272;
  let map: PosterRect | null = null;
  let mapImage: PosterRect | null = null;
  if (o.hasMap) {
    map = { x: PAD, y, w: inner, h: p.mapH };
    mapImage = { x: PAD + CARD_INSET, y: y + CARD_INSET, w: inner - CARD_INSET * 2, h: p.mapH - CARD_INSET * 2 };
    y += p.mapH + GAP;
  }

  const gridH = 356; // 2×2：每格 170 高 + 16 间距
  const grid: PosterRect = { x: PAD, y, w: inner, h: gridH };
  y += gridH;

  let bars: PosterRect | null = null;
  if (o.hasBars && p.bars) {
    y += GAP;
    bars = { x: PAD, y, w: inner, h: 200 };
    y += 200;
  }

  let hr: PosterRect | null = null;
  // 心率曲线卡仅 9:16（§3 定稿版式；其余比例版面留给地图/四宫格/配速条）。
  if (o.hasHr && p.hrH != null) {
    y += GAP;
    hr = { x: PAD, y, w: inner, h: p.hrH };
    y += p.hrH;
  }

  // 页脚：常规比例贴底（线 h-108 / 文字 h-56）；抖音 9:16 整体上移出底部
  // 文案遮挡区（文字基线 ≤ safeBottomY - 16，线仍在其上 52px）。
  const footerTextY = height - Math.max(56, p.safeBottom + 16);
  const footerLineY = footerTextY - 52;

  return {
    width,
    height,
    pad: PAD,
    contentRight,
    safeBottomY: height - p.safeBottom,
    brandY,
    titleY,
    chips,
    map,
    mapImage,
    grid,
    bars,
    hr,
    footerLineY,
    footerTextY,
  };
}


/** 静态图请求尺寸：mapImage 显示区像素 ÷ 2（scale=2 出图，实际像素即
 * 显示区大小）。四舍五入并夹在 API 下限 50px 内。 */
export function posterMapRequestSize(aspect: PosterAspect): { width: number; height: number } {
  const r = posterLayout(aspect, { hasMap: true, hasBars: true, hasHr: false }).mapImage;
  if (!r) return { width: 50, height: 50 }; // unreachable with hasMap（check 断言）
  const w = Math.max(50, Math.round(r.w / 2));
  const h = Math.max(50, Math.round(r.h / 2));
  return { width: w, height: h };
}

// ---------------------------------------------------------------------------
// 绘制（薄壳：所有几何/文案决策在上面的纯函数里）
// ---------------------------------------------------------------------------

/** 海报 canvas 2d 上下文（wx typings 不带 DOM Canvas 类型的最小结构）。 */
export interface PosterCtx {
  fillStyle: string | CanvasGradientLike;
  strokeStyle: string;
  lineWidth: number;
  lineCap: CanvasLineCapLike;
  font: string;
  globalAlpha: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradientLike;
  setLineDash(segments: number[]): void;
  save(): void;
  restore(): void;
  clip(): void;
  drawImage(img: PosterImage, x: number, y: number, w: number, h: number): void;
}

/** lineCap 值类型（'round' 等）。 */
export type CanvasLineCapLike = 'butt' | 'round' | 'square';

/** 渐变对象的最小结构（canvas.createLinearGradient 的产物）。 */
export interface CanvasGradientLike {
  addColorStop(offset: number, color: string): void;
}

/** canvas.createImage() 产物（mp Canvas 2d Image）——不透明句柄，只喂 drawImage。 */
export interface PosterImage {
  // 有意的空标记接口：真实对象字段不读。
}

/** 单行尾截 ellipsize（Array.from 处理代理对）。 */
export function ellipsize(text: string, maxWidth: number, measure: (s: string) => number): string {
  if (measure(text) <= maxWidth) return text;
  const chars = Array.from(text);
  while (chars.length && measure(`${chars.join('')}…`) > maxWidth) chars.pop();
  return chars.length ? `${chars.join('')}…` : '…';
}

/** 圆角白卡 + 发丝线描边（§3 风格语言的卡片基元）。 */
function card(ctx: PosterCtx, r: PosterRect, radius = 24): void {
  roundRect(ctx, r, radius);
  ctx.fillStyle = theme.card;
  ctx.fill();
  ctx.strokeStyle = theme.hairline;
  ctx.lineWidth = 2;
  roundRect(ctx, r, radius);
  ctx.stroke();
}

function roundRect(ctx: PosterCtx, r: PosterRect, radius: number): void {
  ctx.beginPath();
  ctx.moveTo(r.x + radius, r.y);
  ctx.lineTo(r.x + r.w - radius, r.y);
  ctx.arc(r.x + r.w - radius, r.y + radius, radius, -Math.PI / 2, 0);
  ctx.lineTo(r.x + r.w, r.y + r.h - radius);
  ctx.arc(r.x + r.w - radius, r.y + r.h - radius, radius, 0, Math.PI / 2);
  ctx.lineTo(r.x + radius, r.y + r.h);
  ctx.arc(r.x + radius, r.y + r.h - radius, radius, Math.PI / 2, Math.PI);
  ctx.lineTo(r.x, r.y + radius);
  ctx.arc(r.x + radius, r.y + radius, radius, Math.PI, (Math.PI * 3) / 2);
  ctx.closePath();
}

/** 品牌行 + 日期胶囊。 */
function drawBrand(ctx: PosterCtx, layout: PosterLayout, model: PosterModel): void {
  ctx.fillStyle = theme.accent;
  ctx.font = 'bold 34px sans-serif';
  ctx.fillText('砺跑 StrideWise', layout.pad, layout.brandY);

  if (model.dateCapsule) {
    ctx.font = '26px sans-serif';
    const w = ctx.measureText(model.dateCapsule).width;
    const rect: PosterRect = { x: layout.contentRight - w - 44, y: layout.brandY - 38, w: w + 44, h: 52 };
    roundRect(ctx, rect, 26);
    ctx.fillStyle = theme.chip;
    ctx.fill();
    ctx.fillStyle = theme.textSecondary;
    ctx.fillText(model.dateCapsule, rect.x + 22, layout.brandY - 2);
  }
}

/** 课名（超长 ellipsize）+ chips：STRIDE 计划课 / 课型 / 运动类型。 */
function drawTitle(ctx: PosterCtx, layout: PosterLayout, model: PosterModel): void {
  ctx.fillStyle = theme.textPrimary;
  ctx.font = 'bold 60px sans-serif';
  const title = ellipsize(model.title, layout.contentRight - layout.pad, (s) => ctx.measureText(s).width);
  ctx.fillText(title, layout.pad, layout.titleY);

  const chips: string[] = [];
  if (model.isPlanned) chips.push('STRIDE 计划课');
  if (model.trainTypeLabel) chips.push(model.trainTypeLabel);
  if (model.sportLabel) chips.push(model.sportLabel);
  let x = layout.pad;
  const y = layout.chips.y;
  const h = layout.chips.h;
  ctx.font = '26px sans-serif';
  for (const label of chips) {
    const w = ctx.measureText(label).width + 40;
    if (x + w > layout.contentRight) break; // 超宽截断（不画半个 chip）
    const rect: PosterRect = { x, y, w, h };
    roundRect(ctx, rect, h / 2);
    ctx.fillStyle = theme.chip;
    ctx.fill();
    ctx.fillStyle = theme.textSecondary;
    ctx.fillText(label, x + 20, y + h / 2 + 9);
    x += w + 16;
  }
}

/** 地图 hero：真图绘制（缩放进卡片）；缺图降级矢量轨迹占位 + 角标说明。 */
function drawMap(ctx: PosterCtx, layout: PosterLayout, mapImage: PosterImage | null, track: TrackPoint[][] | null): void {
  if (!layout.map || !layout.mapImage) return; // 无轨迹（力量训练等）：整卡不画
  card(ctx, layout.map);
  const r = layout.mapImage;
  if (mapImage) {
    ctx.save();
    roundRect(ctx, r, 16);
    ctx.clip();
    ctx.drawImage(mapImage, r.x, r.y, r.w, r.h);
    ctx.restore();
    return;
  }
  // 降级占位：真轨迹矢量（配速渐变着色）+ 起绿点/终红点 + 底图未开放角标。
  ctx.save();
  roundRect(ctx, r, 16);
  ctx.clip();
  ctx.fillStyle = theme.bgSunken;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  if (track && track.length) {
    const bbox = trackBBox(track);
    if (bbox) {
      const pad = 28;
      const spanLat = Math.max(bbox.maxLat - bbox.minLat, 1e-6);
      const spanLng = Math.max(bbox.maxLng - bbox.minLng, 1e-6);
      const project = (lat: number, lng: number): { x: number; y: number } => ({
        x: r.x + pad + ((lng - bbox.minLng) / spanLng) * (r.w - pad * 2),
        y: r.y + r.h - pad - ((lat - bbox.minLat) / spanLat) * (r.h - pad * 2),
      });
      ctx.lineWidth = 10;
      ctx.lineCap = 'round';
      let all: TrackPoint[] = [];
      for (const seg of track) all = all.concat(seg);
      let paceMin = Infinity;
      let paceMax = -Infinity;
      for (const p of all) {
        if (p.pace != null && p.pace > 0) {
          if (p.pace < paceMin) paceMin = p.pace;
          if (p.pace > paceMax) paceMax = p.pace;
        }
      }
      for (const seg of track) {
        if (seg.length < 2) continue;
        for (let i = 1; i < seg.length; i++) {
          const a = project(seg[i - 1].latitude, seg[i - 1].longitude);
          const b = project(seg[i].latitude, seg[i].longitude);
          const avgPace = ((seg[i - 1].pace ?? paceMax) + (seg[i].pace ?? paceMax)) / 2;
          const t = paceMax > paceMin && avgPace > 0 ? (paceMax - avgPace) / (paceMax - paceMin) : 0;
          ctx.strokeStyle = gradient3(t);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
      // 起绿点 / 终红点（与真图 markers 同语义）。
      const first = track.find((s) => s.length > 0);
      const last = [...track].reverse().find((s) => s.length > 0);
      if (first && last) {
        const s = project(first[0].latitude, first[0].longitude);
        const e = project(last[last.length - 1].latitude, last[last.length - 1].longitude);
        for (const [pt, color] of [
          [s, PACE_SLOW_GREEN],
          [e, PACE_FAST_RED],
        ] as const) {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 9, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
        }
      }
    }
  }
  ctx.fillStyle = theme.textTertiary;
  ctx.font = '24px sans-serif';
  ctx.fillText('地图底图暂未开放', r.x + r.w - 240, r.y + r.h - 24);
  ctx.restore();
}

/** 四宫格等权重大数字：距离为渐变字（唯一视觉锚点），其余主色。 */
function drawGrid(ctx: PosterCtx, layout: PosterLayout, model: PosterModel): void {
  const gap = 16;
  const cellW = (layout.grid.w - gap) / 2;
  const cellH = 170;
  model.grid.slice(0, 4).forEach((m, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const r: PosterRect = {
      x: layout.grid.x + col * (cellW + gap),
      y: layout.grid.y + row * (cellH + gap),
      w: cellW,
      h: cellH,
    };
    card(ctx, r);
    const valueY = r.y + 104;
    if (i === 0) {
      // 距离渐变字：accent → accentDeep（竖向）。
      const grad = ctx.createLinearGradient(r.x, valueY - 56, r.x, valueY + 8);
      grad.addColorStop(0, theme.accent);
      grad.addColorStop(1, theme.accentDeep);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = theme.textPrimary;
    }
    ctx.font = 'bold 64px sans-serif';
    const label = m.unit ? `${m.value}` : m.value;
    ctx.fillText(label, r.x + 32, valueY);
    if (m.unit) {
      const vw = ctx.measureText(label).width;
      ctx.fillStyle = theme.textSecondary;
      ctx.font = '28px sans-serif';
      ctx.fillText(m.unit, r.x + 36 + vw, valueY);
    }
    ctx.fillStyle = theme.textSecondary;
    ctx.font = '26px sans-serif';
    ctx.fillText(m.label, r.x + 32, r.y + 148);
  });
}

/** 每公里配速条：细柱，柱色=该段配速（绿慢红快），最快公里红色描边环。 */
function drawBars(ctx: PosterCtx, layout: PosterLayout, model: PosterModel): void {
  if (!layout.bars || !model.bars || !model.barsHeader) return;
  card(ctx, layout.bars);

  ctx.fillStyle = theme.textSecondary;
  ctx.font = '28px sans-serif';
  ctx.fillText(model.barsHeader, layout.bars.x + 32, layout.bars.y + 52);

  const bars = model.bars;
  const areaX = layout.bars.x + 32;
  const areaW = layout.bars.w - 64;
  const areaBottom = layout.bars.y + layout.bars.h - 32;
  const maxH = 96;
  const maxSec = Math.max(...bars.map((b) => b.secPerKm));
  const barW = Math.min(34, areaW / bars.length - 6);
  const step = areaW / bars.length;
  bars.forEach((b, i) => {
    const h = maxSec > 0 ? Math.max(10, (b.secPerKm / maxSec) * maxH) : 10;
    const x = areaX + i * step + (step - barW) / 2;
    const y = areaBottom - h;
    ctx.fillStyle = b.color;
    ctx.fillRect(x, y, barW, h);
    if (b.fastest) {
      ctx.strokeStyle = theme.danger;
      ctx.lineWidth = 4;
      ctx.strokeRect(x - 4, y - 4, barW + 8, h + 8);
    }
  });
}

/** 【9:16】心率曲线卡：面积曲线 + Z5 阈值虚线。 */
function drawHr(ctx: PosterCtx, layout: PosterLayout, model: PosterModel): void {
  if (!layout.hr || !model.hr || model.hr.points.length < 2) return;
  card(ctx, layout.hr);

  ctx.fillStyle = theme.textSecondary;
  ctx.font = '28px sans-serif';
  ctx.fillText('心率曲线', layout.hr.x + 32, layout.hr.y + 52);

  const r: PosterRect = { x: layout.hr.x + 32, y: layout.hr.y + 84, w: layout.hr.w - 64, h: layout.hr.h - 124 };
  const pts = model.hr.points;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const p of pts) {
    if (p.v < vMin) vMin = p.v;
    if (p.v > vMax) vMax = p.v;
  }
  if (model.hr.z5 != null) {
    if (model.hr.z5 > vMax) vMax = model.hr.z5;
    if (model.hr.z5 < vMin) vMin = model.hr.z5;
  }
  if (vMax <= vMin) vMax = vMin + 1;
  const t0 = pts[0].t;
  const tSpan = Math.max(pts[pts.length - 1].t - t0, 1);
  const vx = (t: number): number => r.x + ((t - t0) / tSpan) * r.w;
  const vy = (v: number): number => r.y + r.h - ((v - vMin) / (vMax - vMin)) * r.h;

  // 面积填充（accent 低透明度）。
  ctx.beginPath();
  ctx.moveTo(vx(pts[0].t), r.y + r.h);
  for (const p of pts) ctx.lineTo(vx(p.t), vy(p.v));
  ctx.lineTo(vx(pts[pts.length - 1].t), r.y + r.h);
  ctx.closePath();
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = theme.accent;
  ctx.fill();
  ctx.globalAlpha = 1;

  // 曲线本体。
  ctx.beginPath();
  ctx.moveTo(vx(pts[0].t), vy(pts[0].v));
  for (const p of pts) ctx.lineTo(vx(p.t), vy(p.v));
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 4;
  ctx.stroke();

  // Z5 阈值虚线。
  if (model.hr.z5 != null && model.hr.z5 >= vMin && model.hr.z5 <= vMax) {
    const y = vy(model.hr.z5);
    ctx.setLineDash([12, 10]);
    ctx.strokeStyle = theme.danger;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(r.x, y);
    ctx.lineTo(r.x + r.w, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = theme.danger;
    ctx.font = '24px sans-serif';
    ctx.fillText(`Z5 ${model.hr.z5}`, r.x + r.w - 96, y - 10);
  }
}

/** 海报主入口：暖粉彩底 + 各节绘制。mapImage=null 时地图层走矢量占位。 */
export function drawPoster(
  ctx: PosterCtx,
  aspect: PosterAspect,
  model: PosterModel,
  o: {
    mapImage: PosterImage | null;
    track: TrackPoint[][] | null;
    userName: string;
  },
): void {
  const hasMap = o.track != null && o.track.length > 0;
  // 节有无由数据决定；各比例画不画（1:1 无配速条、心率卡仅 9:16）由
  // posterLayout 内的策略表统一裁决。
  const layout = posterLayout(aspect, {
    hasMap,
    hasBars: model.bars != null,
    hasHr: model.hr != null,
  });

  // 暖粉彩渐变底（accentTint → bg）。
  const bg = ctx.createLinearGradient(0, 0, 0, layout.height);
  bg.addColorStop(0, theme.accentTint);
  bg.addColorStop(0.35, theme.bg);
  bg.addColorStop(1, theme.bg);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, layout.width, layout.height);

  drawBrand(ctx, layout, model);
  drawTitle(ctx, layout, model);
  drawMap(ctx, layout, o.mapImage, o.track);
  drawGrid(ctx, layout, model);
  drawBars(ctx, layout, model);
  drawHr(ctx, layout, model);
  drawFooterSignature(ctx, layout, model, o.userName);
}

/** 页脚署名：署名·日期 在左，品牌 slogan 在右（文档流内，不可能重叠）。
 * 整块收在 contentRight 内（抖音 9:16 上移出底部文案遮挡区）。 */
function drawFooterSignature(ctx: PosterCtx, layout: PosterLayout, model: PosterModel, userName: string): void {
  ctx.strokeStyle = theme.hairline;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(layout.pad, layout.footerLineY);
  ctx.lineTo(layout.contentRight, layout.footerLineY);
  ctx.stroke();

  ctx.fillStyle = theme.textTertiary;
  ctx.font = '26px sans-serif';
  const slogan = 'STRIDE · 用数据陪伴每一次奔跑';
  const sloganW = ctx.measureText(slogan).width;
  ctx.fillText(slogan, layout.contentRight - sloganW, layout.footerTextY);

  ctx.fillStyle = theme.textPrimary;
  ctx.font = '28px sans-serif';
  const parts = [userName, model.dateFull].filter(Boolean).join(' · ');
  const maxW = layout.contentRight - layout.pad * 2 - sloganW - 48;
  const signature = parts ? ellipsize(parts, maxW, (s) => ctx.measureText(s).width) : '';
  if (signature) ctx.fillText(signature, layout.pad, layout.footerTextY);
}
