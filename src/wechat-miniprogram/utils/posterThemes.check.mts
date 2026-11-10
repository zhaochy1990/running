/**
 * posterThemes 对账自检：`node --import ./utils/ts-resolve-hooks.mjs utils/posterThemes.check.mts`。
 * 九色系表（devops#947，POC gen-bright.mjs VARIANTS 迁移）静态断言 +
 * 「九套主题全量出图无硬编码 hex」动态对账：
 *   1. 键集/顺序/唯一、中文名与 POC 库存一致，默认 = sunrise（首位）；
 *   2. dark（夜航）切浅字逻辑生效：底字/胶囊为 POC page() 的暗底值，
 *      亮色主题胶囊底 = 卡底（POC chipBg 规则）；
 *   3. bgStops 停点升序 0→1、色值全为合法格式；accent ≠ accentDeep；
 *   4. posterTheme() 未知 key 回落默认；圆点数据与主题表镜像；
 *   5. utils/poster.ts 源码零硬编码 hex（绘制颜色只能来自主题表/数据色板）；
 *   6. 全量出图冒烟：九主题 × 双比例用录制 canvas 跑 drawPoster，
 *      断言不抛错且绘制到的每个颜色都属于「主题 token ∪ 配速色板」闭包
 *      （混进任何写死的颜色即失败）。
 * 进 CI（npm test 链，同 theme.check / poster.check 模式）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_POSTER_THEME_KEY,
  POSTER_THEMES,
  isPosterThemeKey,
  posterTheme,
  posterThemeDots,
  type PosterTheme,
} from './posterThemes.ts';
import { drawPoster, type PosterCtx, type PosterModel } from './poster.ts';
import { gradient3, PACE_FAST_RED, PACE_SLOW_GREEN } from './posterGradient.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function fail(msg: string): never {
  throw new Error(`posterThemes 对账失败：${msg}`);
}

const EXPECTED_KEYS = [
  'sunrise',
  'ocean',
  'mint',
  'lavender',
  'sakura',
  'citrus',
  'forest',
  'festive',
  'midnight',
] as const;
const EXPECTED_LABELS = ['晨光', '海盐', '薄荷冰', '星紫', '樱花', '蜜柚', '墨松', '绯红鎏金', '夜航'];

// ── 1. 键集 / 顺序 / 唯一 / 标签 / 默认 ──
if (POSTER_THEMES.length !== 9) fail(`应有九套主题，实际 ${POSTER_THEMES.length}`);
if (POSTER_THEMES.map((t) => t.key).join(',') !== EXPECTED_KEYS.join(',')) {
  fail(`键集/顺序与 POC 库存不一致：${POSTER_THEMES.map((t) => t.key).join(',')}`);
}
POSTER_THEMES.forEach((t, i) => {
  if (t.label !== EXPECTED_LABELS[i]) fail(`${t.key} 标签应为 ${EXPECTED_LABELS[i]}，实际 ${t.label}`);
});
if (DEFAULT_POSTER_THEME_KEY !== 'sunrise' || POSTER_THEMES[0].key !== 'sunrise') {
  fail('默认主题必须是 sunrise（晨光，品牌藕粉）');
}

// ── 2. dark 切换逻辑 ──
const darks = POSTER_THEMES.filter((t) => t.dark);
if (darks.length !== 1 || darks[0].key !== 'midnight') fail('暗底主题必须恰好一套：midnight');
const midnight = darks[0];
if (midnight.ink !== '#eef3fb') fail(`夜航底面主字应为 POC bgInk #eef3fb，实际 ${midnight.ink}`);
if (midnight.sub !== '#93a3bd') fail(`夜航底面次字应为 POC bgSub #93a3bd，实际 ${midnight.sub}`);
if (midnight.chip !== 'rgba(255, 255, 255, 0.14)') fail(`夜航胶囊底应为 POC chipBg 半透白，实际 ${midnight.chip}`);
// 白卡恒白：卡内文字用原始 ink/sub（夜航也不切）
if (midnight.cardInk === midnight.ink) fail('夜航白卡内主字不应随底面切浅');
for (const t of POSTER_THEMES) {
  if (t.dark) continue;
  if (t.chip !== t.card) fail(`${t.key} 亮色主题胶囊底应 = 卡底（POC chipBg 规则）`);
  if (t.ink === '#eef3fb') fail(`${t.key} 亮色主题不应使用暗底底字`);
}

// ── 3. 格式与结构 ──
const HEX6 = /^#[0-9a-f]{6}$/;
const RGBAM = /^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, (0|1|0\.\d+)\)$/;
const colorFields: Array<[keyof PosterTheme, string]> = [
  ['ink', 'ink'],
  ['sub', 'sub'],
  ['tertiary', 'tertiary'],
  ['cardInk', 'cardInk'],
  ['cardSub', 'cardSub'],
  ['card', 'card'],
  ['chip', 'chip'],
  ['hairline', 'hairline'],
  ['bgSunken', 'bgSunken'],
  ['accent', 'accent'],
  ['accentDeep', 'accentDeep'],
  ['danger', 'danger'],
];
for (const t of POSTER_THEMES) {
  if (t.bgStops.length < 2) fail(`${t.key} bgStops 至少 2 停`);
  t.bgStops.forEach(([off], i) => {
    if (i > 0 && off <= (t.bgStops[i - 1] as readonly [number, string])[0]) fail(`${t.key} bgStops offset 必须严格升序`);
  });
  if (t.bgStops[0][0] !== 0 || t.bgStops[t.bgStops.length - 1][0] !== 1) fail(`${t.key} bgStops 必须 0 起 1 止`);
  for (const [, color] of t.bgStops) {
    if (!HEX6.test(color)) fail(`${t.key} bgStop 非法色值：${color}`);
  }
  for (const [field, name] of colorFields) {
    const v = String(t[field]);
    if (!HEX6.test(v) && !RGBAM.test(v)) fail(`${t.key}.${name} 非法色值：${v}`);
  }
  if (t.accent === t.accentDeep) fail(`${t.key} 强调双色端点重合（渐变字会退化单色）`);
}

// ── 4. 解析回落 + 圆点镜像 ──
if (posterTheme('nonexistent').key !== 'sunrise') fail('未知 key 必须回落 sunrise');
if (posterTheme('midnight').key !== 'midnight') fail('已知 key 应命中');
if (!isPosterThemeKey('midnight') || isPosterThemeKey('bogus')) fail('isPosterThemeKey 守卫判定错误');
const dots = posterThemeDots();
if (dots.length !== 9) fail(`圆点应九个，实际 ${dots.length}`);
dots.forEach((d, i) => {
  const t = POSTER_THEMES[i];
  if (d.key !== t.key || d.label !== t.label || d.colorA !== t.accent || d.colorB !== t.accentDeep || d.dark !== t.dark) {
    fail(`圆点 ${d.key} 与主题表不镜像`);
  }
});

// ── 5. poster.ts 绘制源码零硬编码 hex（只扫代码，注释里的票号 #944 不是色值） ──
const posterSrc = readFileSync(join(root, 'utils/poster.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');
const hexInPoster = posterSrc.match(/#[0-9a-fA-F]{3,8}\b/g);
if (hexInPoster) fail(`poster.ts 出现硬编码 hex：${hexInPoster.join(', ')}`);

// ── 6. 全量出图冒烟 + 颜色闭包 ──
// 录制 canvas：捕获所有被赋值/注入的颜色串。
const drawn = new Set<string>();
function record(color: string | number | undefined): void {
  if (typeof color === 'string') drawn.add(color);
}
const gradientStops: string[] = [];
const mockCtx: PosterCtx = {
  get fillStyle() {
    return '';
  },
  set fillStyle(v) {
    record(v);
  },
  get strokeStyle() {
    return '';
  },
  set strokeStyle(v) {
    record(v);
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
    return {
      addColorStop(_offset: number, color: string) {
        gradientStops.push(color);
      },
    };
  },
  setLineDash() {},
  save() {},
  restore() {},
  clip() {},
  drawImage() {},
};

// 满配模型：品牌/课名/chips/地图（矢量降级）/四宫格/配速条/心率/页脚全覆盖。
const model: PosterModel = {
  title: '周末长距离',
  sportLabel: '跑步',
  trainTypeLabel: '有氧耐力',
  isPlanned: true,
  dateCapsule: '11月7日',
  dateFull: '2026年11月7日',
  grid: [
    { label: '距离', value: '16.09', unit: 'km' },
    { label: '时长', value: '01:20:32' },
    { label: '平均配速', value: `5'00"`, unit: '/km' },
    { label: '平均心率', value: '152', unit: 'bpm' },
  ],
  bars: [
    { secPerKm: 300, color: gradient3(0.2), fastest: false },
    { secPerKm: 280, color: gradient3(0.8), fastest: false },
    { secPerKm: 240, color: gradient3(1), fastest: true },
  ],
  barsHeader: `最快 4'00"/km · 第 3 公里`,
  hr: { points: Array.from({ length: 60 }, (_, i) => ({ t: i * 60, v: 140 + (i % 20) })), z5: 165 },
};
const track = [
  Array.from({ length: 40 }, (_, i) => ({ latitude: 31.2 + i * 1e-4, longitude: 121.5 + i * 1e-4, pace: 300 + (i % 7) * 10 })),
];

for (const t of POSTER_THEMES) {
  // 平台矩阵四比例（devops#948）：九主题 × 4 比例全量出图冒烟。
  for (const aspect of ['3:4', '9:16', '4:5', '1:1'] as const) {
    try {
      drawPoster(mockCtx, aspect, model, { mapImage: null, track, userName: '测试跑者', themeKey: t.key });
    } catch (err) {
      fail(`${t.key} ${aspect} 全量出图抛错：${String(err)}`);
    }
  }
}

// 颜色闭包：绘制的每个颜色 ∈ 主题 token ∪ 配速色板。配速色板是连续渐变
// （gradient3 任意 t 的插值色都合法），按分段线性路径判定而非枚举。
const allowed = new Set<string>();
for (const t of POSTER_THEMES) {
  for (const [field] of colorFields) allowed.add(String(t[field]));
  for (const [, color] of t.bgStops) allowed.add(color);
}
allowed.add(PACE_SLOW_GREEN);
allowed.add(PACE_FAST_RED);

function hexToRgb(h: string): [number, number, number] {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
// gradient3 的两段折线端点：绿 → 琥珀（gradient3(0.5) 恰为琥珀）→ 红。
const rampA = hexToRgb(PACE_SLOW_GREEN);
const rampB = hexToRgb(gradient3(0.5));
const rampC = hexToRgb(PACE_FAST_RED);
/** 该 hex 是否落在绿→琥珀→红分段线性路径上（±2 容差吸收逐通道取整）。 */
function onPaceRamp(h: string): boolean {
  if (!/^#[0-9a-f]{6}$/.test(h)) return false;
  const [r, g, b] = hexToRgb(h);
  for (const [s0, s1] of [
    [rampA, rampB],
    [rampB, rampC],
  ] as const) {
    const d = [s1[0] - s0[0], s1[1] - s0[1], s1[2] - s0[2]];
    const i = d.findIndex((v) => Math.abs(v) === Math.max(...d.map(Math.abs)));
    if (d[i] === 0) continue;
    const k = ([r, g, b][i] - s0[i]) / d[i];
    if (k < -0.001 || k > 1.001) continue;
    if (
      Math.abs(r - (s0[0] + k * d[0])) <= 2 &&
      Math.abs(g - (s0[1] + k * d[1])) <= 2 &&
      Math.abs(b - (s0[2] + k * d[2])) <= 2
    ) {
      return true;
    }
  }
  return false;
}
for (const color of [...drawn, ...gradientStops]) {
  if (!allowed.has(color) && !onPaceRamp(color)) fail(`绘制到闭包外颜色（疑似硬编码）：${color}`);
}

console.log(
  `posterThemes 对账通过：九套主题（1 暗）结构/切换/格式一致；poster.ts 零 hex；` +
    `${POSTER_THEMES.length} 主题 × 4 比例全量出图，绘制颜色 ${drawn.size + gradientStops.length} 个记录全在 token/色板闭包内`,
);
