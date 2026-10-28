/**
 * 主题常量 —— TS 侧唯一色源（#816 / Epic #815 色彩映射总表）
 * 与 styles/theme.wxss 互为镜像：键名与令牌一一对应（如 --color-bg-sunken
 * ↔ bgSunken），值必须同步；utils/theme.check.mts 对账两源一致（进 CI，
 * npm test 链）。canvas 绘制 / uCharts 配置 / 原生 API 色参一律引本常量，
 * 禁止写死主题色值。数据可视化色板（ZONE_COLORS / 训练状态色 / 分段色板）
 * 与主题解耦（Epic 原则），不在此列、保持各自模块内定义。
 * 当前值为浅色新值（devops#817 P2，数值源 = iOS LightTheme Tokens.swift；
 * 深色旧值见 styles/theme-dark.wxss 存档）。
 */
export const theme = {
  /* 底色 */
  bg: '#f7f9fb',
  bgSunken: '#eff2f6',
  bgDim: '#ebeef3',
  card: '#ffffff',
  chip: '#eff2f6',

  /* 文字（深 → 浅；muted 与 tertiary 分立语义槽位） */
  textTertiary: '#aab1bd',
  textMuted: '#aab1bd',
  textSecondary: '#6b7280',
  textCool: '#6b7280',
  textBright: '#4a5260',
  bandOther: '#6b7280',
  fieldText: '#2c3340',
  textPrimary: '#2c3340',
  textMax: '#2c3340',
  onAccent: '#ffffff',

  /* 轨迹缩略图墨色（devops#827）：canvas 矢量绘制的折线颜色。初值与
     textPrimary 同值（浅色主题下墨色 #2C3340，与旧 PNG 渲染端一致）；
     深色对应值存档于 styles/theme-dark.wxss（客户端切深色主题时用）。 */
  routeInk: '#2c3340',

  /* 主题色（藕粉）：透明度变体用 themeRgba(accentRgb, α) */
  accent: '#ff6363',
  accentRgb: '255, 99, 99',
  accentLight: '#d04545',
  accentPale: '#d04545',
  accentPaleRgb: '208, 69, 69',
  accentDeep: '#d04545',
  accentTint: '#ffecec',

  /* 黑 overlay（浅色下发丝线 / 弱分隔 / 压暗层；深色下为白 overlay） */
  overlayRgb: '0, 0, 0',
  borderSoft: '#ebeef3',
  hairline: '#dfe3ea',

  /* 顶栏副标题（浅色下收敛为 iOS foregroundSoft 同阶灰蓝） */
  headerMetaRgb: '74, 82, 96',

  /* 状态色 */
  success: '#00a85a',
  successRgb: '0, 168, 90',
  successLight: '#00a85a',
  warning: '#d89a3d',
  warningRgb: '216, 154, 61',
  info: '#4c8dff',
  infoRgb: '76, 141, 255',
  danger: '#d74331',
} as const;

/** rgba 组合：theme.wxss 里 rgba(var(--color-accent-rgb), α) 的 TS 等价。 */
export function themeRgba(rgb: string, alpha: number | string): string {
  return `rgba(${rgb}, ${alpha})`;
}
