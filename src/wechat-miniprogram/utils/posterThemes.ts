/**
 * 分享海报九色系主题常量（devops#947，Epic #601 P5）——海报 canvas 绘制的
 * 唯一色源：utils/poster.ts 绘制函数只读本表字段，禁止散落 hex。
 *
 * POC 出处：stride 仓 prototypes/activity-share-poster/scripts/gen-bright.mjs
 * 的 VARIANTS token 表（v5 九套，真实长距离数据出图定稿），迁值不动：
 * 晨光 sunrise（默认 · 品牌藕粉）/ 海盐 ocean / 薄荷冰 mint / 星紫 lavender /
 * 樱花 sakura / 蜜柚 citrus / 墨松 forest / 绯红鎏金 festive / 夜航 midnight。
 * 票面验收口径为「九套主题全量出图」：樱花与星紫并存、夜航保留。
 *
 * 每套主题 = 一组 canvas 绘制常量：底渐变停点 + 底面文字 + 白卡内文字 +
 * 卡/胶囊/发丝线/沉降底 + 强调双色（POC trackA/trackB：距离渐变字与心率
 * 曲线用）。dark（夜航）切浅字逻辑随 POC page() 一并迁移：底面主/次文字、
 * 胶囊底、最弱文字、发丝线换暗底值；白卡恒白故卡内文字恒深（POC 同款）。
 *
 * 选择持久化（storage）：load/savePosterThemeKey，页侧切换即写。
 * utils/posterThemes.check.mts 对账进 CI（npm test 链）。
 */

/** 九色系 key（与 POC VARIANTS 键一致）。 */
export type PosterThemeKey =
  | 'sunrise'
  | 'ocean'
  | 'mint'
  | 'lavender'
  | 'sakura'
  | 'citrus'
  | 'forest'
  | 'festive'
  | 'midnight';

/** 海报绘制用色 token 集（poster.ts 消费的完整字段）。 */
export interface PosterTheme {
  key: PosterThemeKey;
  /** 中文名（选择器圆点下标签）。 */
  label: string;
  /** 暗底主题（夜航）：底面文字已在构建期换浅值。 */
  dark: boolean;
  /** 页面底渐变（竖向停点，offset 升序 0→1；POC 168° 渐变迁为竖向）。 */
  bgStops: ReadonlyArray<readonly [offset: number, color: string]>;
  /** 底面主文字：品牌 / 课名 / chips / 页脚署名（dark 已切浅字）。 */
  ink: string;
  /** 底面次文字：日期胶囊（dark 已切浅字）。 */
  sub: string;
  /** 最弱文字：页脚 slogan / 地图降级角标（dark 已切浅字）。 */
  tertiary: string;
  /** 白卡内主文字：四宫格数值（卡恒白，恒深字）。 */
  cardInk: string;
  /** 白卡内次文字：标签 / 表头。 */
  cardSub: string;
  /** 白卡底（POC card 半透白，叠在底渐变上）。 */
  card: string;
  /** 底面胶囊底（POC：亮色 = card，dark = 半透白）。 */
  chip: string;
  /** 卡片发丝线 / 页脚分隔线（dark 换半透白）。 */
  hairline: string;
  /** 地图降级占位底（白卡内，恒浅）。 */
  bgSunken: string;
  /** 强调起点（POC trackA）：心率曲线 / 距离渐变字起点。 */
  accent: string;
  /** 强调终点（POC trackB）：距离渐变字终点。 */
  accentDeep: string;
  /** 语义红：最快公里描边 / Z5 阈值线（数据语义色，九套共用）。 */
  danger: string;
}

/** POC VARIANTS 原始 token（迁值不动；dark 切换逻辑在 buildPosterTheme 应用）。 */
interface PosterThemeVariant {
  key: PosterThemeKey;
  label: string;
  dark?: boolean;
  bg: ReadonlyArray<readonly [number, string]>;
  ink: string;
  sub: string;
  card: string;
  trackA: string;
  trackB: string;
}

// dark（夜航）底面切浅字四值 + 暗底发丝线（POC page() 的
// bgInk/bgSub/chipBg/footer 随迁，发丝线为暗底可读性等效值）。
const DARK_BG_INK = '#eef3fb';
const DARK_BG_SUB = '#93a3bd';
const DARK_CHIP = 'rgba(255, 255, 255, 0.14)';
const DARK_TERTIARY = '#8fa0ba';
const DARK_HAIRLINE = 'rgba(255, 255, 255, 0.22)';

// 九套共用中性值：POC 亮色页脚最弱字 + 现海报（devops#944）发丝线/沉降底/语义红。
const LIGHT_TERTIARY = '#9aa3b2';
const HAIRLINE = '#dfe3ea';
const BG_SUNKEN = '#eff2f6';
const DANGER = '#d74331';

const VARIANTS: ReadonlyArray<PosterThemeVariant> = [
  {
    key: 'sunrise',
    label: '晨光',
    bg: [
      [0, '#fff4f0'],
      [0.3, '#ffeee9'],
      [0.62, '#fdf2f8'],
      [1, '#f3f6ff'],
    ],
    ink: '#20242e',
    sub: '#6d7686',
    card: 'rgba(255, 255, 255, 0.92)',
    trackA: '#ff6363',
    trackB: '#ff9c6b',
  },
  {
    key: 'ocean',
    label: '海盐',
    bg: [
      [0, '#f0f7ff'],
      [0.3, '#eef5ff'],
      [0.62, '#f0fbf9'],
      [1, '#fdf7ff'],
    ],
    ink: '#1c2530',
    sub: '#66788c',
    card: 'rgba(255, 255, 255, 0.92)',
    trackA: '#3f8cff',
    trackB: '#33cdb5',
  },
  {
    key: 'mint',
    label: '薄荷冰',
    bg: [
      [0, '#f2fbf6'],
      [0.32, '#effcf7'],
      [0.64, '#eefaff'],
      [1, '#f6fff9'],
    ],
    ink: '#153028',
    sub: '#5f7a70',
    card: 'rgba(255, 255, 255, 0.92)',
    trackA: '#0ea5a4',
    trackB: '#7de3c8',
  },
  {
    key: 'lavender',
    label: '星紫',
    bg: [
      [0, '#f7f4ff'],
      [0.32, '#f4f0ff'],
      [0.64, '#fdf2fb'],
      [1, '#f0f6ff'],
    ],
    ink: '#241f33',
    sub: '#6f6884',
    card: 'rgba(255, 255, 255, 0.92)',
    trackA: '#8b5cf6',
    trackB: '#ec4899',
  },
  {
    key: 'sakura',
    label: '樱花',
    bg: [
      [0, '#fff5f7'],
      [0.32, '#fff0f3'],
      [0.64, '#fdf6f9'],
      [1, '#f7fbff'],
    ],
    ink: '#33222a',
    sub: '#7c6a71',
    card: 'rgba(255, 255, 255, 0.93)',
    trackA: '#f472a0',
    trackB: '#fda4af',
  },
  {
    key: 'citrus',
    label: '蜜柚',
    bg: [
      [0, '#fffaeb'],
      [0.32, '#fff7e0'],
      [0.64, '#fffbe8'],
      [1, '#f7fbef'],
    ],
    ink: '#33281a',
    sub: '#7d7260',
    card: 'rgba(255, 255, 255, 0.93)',
    trackA: '#f59e0b',
    trackB: '#fb923c',
  },
  {
    key: 'forest',
    label: '墨松',
    bg: [
      [0, '#f4faf4'],
      [0.32, '#f0f8f0'],
      [0.64, '#eef7f2'],
      [1, '#f5faf7'],
    ],
    ink: '#1e2b20',
    sub: '#66786a',
    card: 'rgba(255, 255, 255, 0.93)',
    trackA: '#16a34a',
    trackB: '#0d9488',
  },
  {
    key: 'festive',
    label: '绯红鎏金',
    bg: [
      [0, '#fff5f5'],
      [0.32, '#fff0ec'],
      [0.64, '#fdf6ec'],
      [1, '#fffaf0'],
    ],
    ink: '#331d1a',
    sub: '#7d6660',
    card: 'rgba(255, 255, 255, 0.93)',
    trackA: '#e0242c',
    trackB: '#f59e0b',
  },
  {
    key: 'midnight',
    label: '夜航',
    dark: true,
    bg: [
      [0, '#101a2e'],
      [0.34, '#12223e'],
      [0.68, '#0e2a38'],
      [1, '#101a2e'],
    ],
    ink: '#1c2530',
    sub: '#66788c',
    card: 'rgba(255, 255, 255, 0.95)',
    trackA: '#22d3ee',
    trackB: '#a78bfa',
  },
];

/** POC token → 海报绘制 token（dark 切浅字逻辑在此，单一出口）。 */
function buildPosterTheme(v: PosterThemeVariant): PosterTheme {
  const dark = v.dark === true;
  return {
    key: v.key,
    label: v.label,
    dark,
    bgStops: v.bg,
    ink: dark ? DARK_BG_INK : v.ink,
    sub: dark ? DARK_BG_SUB : v.sub,
    tertiary: dark ? DARK_TERTIARY : LIGHT_TERTIARY,
    cardInk: v.ink,
    cardSub: v.sub,
    card: v.card,
    chip: dark ? DARK_CHIP : v.card,
    hairline: dark ? DARK_HAIRLINE : HAIRLINE,
    bgSunken: BG_SUNKEN,
    accent: v.trackA,
    accentDeep: v.trackB,
    danger: DANGER,
  };
}

/** 九套主题（POC 库存顺序，晨光在首位）。 */
export const POSTER_THEMES: ReadonlyArray<PosterTheme> = VARIANTS.map(buildPosterTheme);

/** 默认主题 = 晨光（品牌藕粉）。 */
export const DEFAULT_POSTER_THEME_KEY: PosterThemeKey = 'sunrise';

/** 按 key 取主题；未知值（storage 里的历史/已砍调 key）回落默认。 */
export function posterTheme(key: string): PosterTheme {
  return POSTER_THEMES.find((t) => t.key === key) ?? POSTER_THEMES[0];
}

/** key 合法性守卫（dataset / storage 读出的 string 收窄回九色系 key）。 */
export function isPosterThemeKey(v: string): v is PosterThemeKey {
  return POSTER_THEMES.some((t) => t.key === v);
}

/** 选择器圆点视图数据（双色渐变点 + 标签 + 暗底标记）。 */
export interface PosterThemeDot {
  key: PosterThemeKey;
  label: string;
  colorA: string;
  colorB: string;
  dark: boolean;
}

/** 圆点视图数据（九套，顺序同 POSTER_THEMES）。 */
export function posterThemeDots(): PosterThemeDot[] {
  return POSTER_THEMES.map((t) => ({
    key: t.key,
    label: t.label,
    colorA: t.accent,
    colorB: t.accentDeep,
    dark: t.dark,
  }));
}

// ---------------------------------------------------------------------------
// 选择持久化（storage）
// ---------------------------------------------------------------------------

const POSTER_THEME_STORAGE_KEY = 'poster.theme';

/** 读持久化的偏好主题；缺失/非法值回落默认。 */
export function loadPosterThemeKey(): PosterThemeKey {
  try {
    const v = wx.getStorageSync(POSTER_THEME_STORAGE_KEY) as string;
    return isPosterThemeKey(v) ? v : DEFAULT_POSTER_THEME_KEY;
  } catch {
    return DEFAULT_POSTER_THEME_KEY;
  }
}

/** 写偏好主题；失败静默（不影响本次出图）。 */
export function savePosterThemeKey(key: PosterThemeKey): void {
  try {
    wx.setStorageSync(POSTER_THEME_STORAGE_KEY, key);
  } catch {
    // storage 写失败不阻断分享流程。
  }
}
