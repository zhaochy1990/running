/**
 * 主题常量 —— TS 侧唯一色源（#816 / Epic #815 色彩映射总表）
 * 与 styles/theme.wxss 互为镜像：键名与令牌一一对应（如 --color-bg-sunken
 * ↔ bgSunken），值必须同步；utils/theme.check.mts 对账两源一致（进 CI，
 * npm test 链）。canvas 绘制 / uCharts 配置 / 原生 API 色参一律引本常量，
 * 禁止写死主题色值。数据可视化色板（ZONE_COLORS / 训练状态色 / 分段色板）
 * 与主题解耦（Epic 原则），不在此列、保持各自模块内定义。
 */
export const theme = {
  /* 底色 */
  bg: '#07080a',
  bgSunken: '#0a0b0d',
  bgDim: '#0d0e10',
  card: '#101111',
  chip: '#17181a',

  /* 文字（暗 → 亮；muted 与 tertiary 分立语义槽位） */
  textTertiary: '#6a6a6c',
  textMuted: '#8a8a8c',
  textSecondary: '#9c9c9d',
  textCool: '#8a8f99',
  textBright: '#b9b8bc',
  bandOther: '#c9c3c4',
  fieldText: '#e8e8ea',
  textPrimary: '#e3e2e5',
  textMax: '#ffffff',
  onAccent: '#ffffff',

  /* 主题色（藕粉）：透明度变体用 themeRgba(accentRgb, α) */
  accent: '#ff6363',
  accentRgb: '255, 99, 99',
  accentLight: '#ff8f8f',
  accentPale: '#ffb3af',
  accentPaleRgb: '255, 179, 175',
  accentDeep: '#ff8f8f',
  accentTint: 'rgba(255, 99, 99, 0.12)',

  /* 白 overlay（浅色主题下整体翻转） */
  overlayRgb: '255, 255, 255',
  borderSoft: 'rgba(255, 255, 255, 0.05)',
  hairline: 'rgba(255, 255, 255, 0.08)',

  /* 顶栏副标题暖粉（各页共享） */
  headerMetaRgb: '225, 191, 188',

  /* 状态色 */
  success: '#5fc992',
  successRgb: '95, 201, 146',
  successLight: '#7ec9a6',
  warning: '#e8c07d',
  warningRgb: '232, 192, 125',
  info: '#8fb8e8',
  infoRgb: '143, 184, 232',
  danger: '#ff5252',
} as const;

export type ThemeTokenName = keyof typeof theme;

/** rgba 组合：theme.wxss 里 rgba(var(--color-accent-rgb), α) 的 TS 等价。 */
export function themeRgba(rgb: string, alpha: number | string): string {
  return `rgba(${rgb}, ${alpha})`;
}
