// 赛事详情「赛道」tab 的纯视图模型 —— 不依赖小程序运行时，
// 配套 utils/raceCourse.check.mts 自检。
// 项目 tab 只留报名信息；路线文字与难点挪进独立赛道 tab（无任何赛道内容的
// 赛事不显示该 tab，页面回落三 tab）。难点沿线渲染为「赛道全景」：纵向线 +
// 站点卡（点击展开全文），数据源是 item.course_challenges —— 公里段是自由
// 文本（"0–16km" / "17.4km"，破折号含 – — - ~），描述带【类别】前缀。

import type { RaceItem } from '../services/race-center';

/** 赛道沿线一个难点「站点」。 */
export interface CourseStation {
  /** 展开态键（页面级唯一，供 wx:key 与展开/收起索引） */
  key: string;
  /** 类别名（已剥离描述的【x】前缀），未知前缀归「其他」 */
  cat: string;
  /** 类别主题色的 rgb 三元组（"255,159,10"）：wxml 拼 rgb()/rgba(…,0.12) 徽章 */
  color: string;
  /** distance_km 原文（null → 「全段」） */
  km: string;
  /** 短标题：正文首个分隔符前的主干；描述常以公里段开头（与右上角标签重复），先剥掉 */
  title: string;
  /** 展开后的全文（无前缀） */
  body: string;
  /** 纵向位置（rpx）：紧凑间距 —— 公里次序与相对远近保留为「节奏」，夹紧防大空档 */
  top: number;
}

/** 赛道 tab 一个项目一节。 */
export interface RaceCourseSection {
  id: number;
  /** 项目名（全程 / 半程…） */
  title: string;
  /** 路线文字串；'' = 待补（页面显示空态） */
  route: string;
  /** 累计爬升（米）字符串，null = 未录 */
  ascent: string | null;
  /** 项目距离（km），null = 未录（meta 不显示距离） */
  distanceKm: number | null;
  stations: CourseStation[];
  /** 站点画布总高（rpx） */
  plotH: number;
}

/** 相邻站点间距（rpx）：下限 ≈ 收起卡高（视觉等距），上限封顶——
 * 全比例映射会把稀疏难点拉成大空档，公里差只保留节奏感。 */
const GAP_MIN = 96;
const GAP_MAX = 200;
/** 每百分点公里差补的间距（35% 差即触顶） */
const GAP_PER_PCT = 3;
/** 末位站点收起卡的高度余量（rpx） */
const PLOT_SLOT = 150;

/** 类别 → 主题色（rgb 三元组）。 */
const CATEGORY_COLORS: Record<string, string> = {
  坡道: '255,159,10',
  桥梁: '143,184,232',
  隧道: '185,143,232',
  拥堵: '255,99,99',
  折返: '232,192,125',
  立交: '99,208,200',
  风: '158,230,184',
  其他: '156,156,157',
};

const FALLBACK_COLOR = CATEGORY_COLORS['其他'];

/** 【x】前缀 → 类别；正文剥掉前缀。无前缀的脏数据归「其他」。 */
function splitCategory(description: string): { cat: string; body: string } {
  const m = /^【(.+?)】\s*/.exec(description);
  if (!m) return { cat: '其他', body: description };
  const body = description.slice(m[0].length);
  return { cat: m[1], body: body || description };
}

/** 自由文本公里段 → [起点km, 终点km]；区间与单点都要吃下，解析不出 → null。 */
export function parseCourseKm(text: string | null): [number, number] | null {
  if (!text) return null;
  const range = /(\d+(?:\.\d+)?)\s*[–—\-~]\s*(\d+(?:\.\d+)?)?/.exec(text);
  if (range) {
    const start = Number(range[1]);
    const end = range[2] !== undefined ? Number(range[2]) : start;
    if (Number.isFinite(start) && Number.isFinite(end)) return [start, end];
  }
  const single = /(\d+(?:\.\d+)?)/.exec(text);
  if (!single) return null;
  const v = Number(single[1]);
  return Number.isFinite(v) ? [v, v] : null;
}

/** 站点短标题：剥前导公里段 → 取首个分隔符前的主干 → 截断。 */
export function courseStationTitle(body: string): string {
  const stripped = body
    .replace(/^\s*\d+(?:\.\d+)?\s*[–—\-~]\s*\d+(?:\.\d+)?\s*km?\s*/i, '')
    .replace(/^\s*\d+(?:\.\d+)?\s*km?\s*/i, '');
  const m = /^[^：:（(；;，,]*/.exec(stripped);
  let title = (m ? m[0] : stripped).trim();
  if (title.length > 16) title = `${title.slice(0, 16)}…`;
  return title || body.slice(0, 16);
}

/** 一个项目的赛道节；无路线且无难点 → null（调用方据此决定 tab 是否可用）。 */
export function toCourseSection(item: RaceItem): RaceCourseSection | null {
  const route = item.route_description || '';
  const rows = item.course_challenges || [];
  if (!route && rows.length === 0) return null;

  // 阅读顺序即赛道顺序：按起点公里排，无里程的垫底（稳定排序保原序）
  const parsed = rows
    .map((row, i) => {
      const { cat, body } = splitCategory(row.description);
      return {
        cat,
        body,
        color: CATEGORY_COLORS[cat] || FALLBACK_COLOR,
        km: row.distance_km || '全段',
        range: parseCourseKm(row.distance_km),
        seq: i,
      };
    })
    .sort((a, b) => {
      const ka = a.range ? a.range[0] : Number.MAX_SAFE_INTEGER;
      const kb = b.range ? b.range[0] : Number.MAX_SAFE_INTEGER;
      return ka - kb || a.seq - b.seq;
    });

  const distanceKm = item.distance_km && item.distance_km > 0 ? item.distance_km : null;
  const toPct = (km: number): number =>
    distanceKm ? Math.max(0, Math.min(100, (km / distanceKm) * 100)) : 0;

  let y = 0;
  let prevPct: number | null = null;
  const stations: CourseStation[] = parsed.map((p, i) => {
    const pct = p.range && distanceKm ? toPct(p.range[0]) : 100;
    if (prevPct !== null) {
      y += Math.min(GAP_MAX, GAP_MIN + Math.max(0, pct - prevPct) * GAP_PER_PCT);
    }
    prevPct = pct;
    return {
      key: `${item.id}:${i}`,
      cat: p.cat,
      color: p.color,
      km: p.km,
      title: courseStationTitle(p.body),
      body: p.body,
      top: y,
    };
  });

  return {
    id: item.id,
    title: item.name,
    route,
    ascent: item.total_ascent_m != null ? String(item.total_ascent_m) : null,
    distanceKm,
    stations,
    plotH: y + PLOT_SLOT,
  };
}
