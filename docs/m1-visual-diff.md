# M1 视觉对比清单

设计稿来源：`~/Downloads/index.html`（本地 HTML mock，`.frame-card` 结构，CSS `:root` 定义 token）

## 设计稿 vs 实现 对照

| ID | 屏幕 | 设计稿来源 | 实现路径 | 已知差异 |
|---|---|---|---|---|
| A1 | 启动（AuthStartScreen） | `frame-card` id="A1"，`logo-wordmark` STRIDE + slogan + 两个按钮 | `mobile/lib/features_v2/auth/start_screen.dart` | 已对齐。Logo 字重 w800 + 字间距 4 匹配设计稿。按钮样式：实心 primary + outline secondary，与设计稿一致。 |
| A2 | 登录（AuthLoginScreen） | `frame-card` id="A2"，email + password TextField + 登录按钮 + 错误提示 | `mobile/lib/features_v2/auth/login_screen.dart` | 已对齐。实时错误提示通过 `_error` state 渲染，与设计稿 `.error-text` 一致。loading 状态禁用按钮。 |
| A3 | 注册（AuthRegisterScreen） | `frame-card` id="A3"，email + password + confirm + invite code + checkbox | `mobile/lib/features_v2/auth/register_screen.dart` | 已对齐。含 4 个 TextField + 协议 Checkbox，与设计稿字段顺序匹配。实时 6 项校验逻辑在 widget state 内。 |
| B1 | 品牌选择（BrandScreen） | `frame-card` id="B1"，COROS / Garmin 两张品牌卡 + 继续按钮 | `mobile/lib/features_v2/onboarding/brand_screen.dart` | 已对齐。Garmin 卡显示 "即将支持" + `StridePill(variant: PillVariant.muted)` disabled 状态，与设计稿一致。 |
| B2 | COROS 绑定（CorosLinkScreen） | `frame-card` id="B2"，region selector + email + password + 绑定按钮 | `mobile/lib/features_v2/onboarding/coros_link_screen.dart` | 已对齐。Region 下拉选全球/中国/欧洲，与设计稿 3 项一致。错误状态用红色 banner。 |
| B3 | 同步进度（SyncProgressScreen） | `frame-card` id="B3"，进度条 + 阶段文字 + 活动计数 | `mobile/lib/features_v2/onboarding/sync_progress_screen.dart` | 已对齐。LinearProgressIndicator 宽度 100%，阶段文字动态更新，error 状态显示重试按钮。PopScope 阻止返回。 |
| B4 | 基本信息（BasicInfoScreen） | `frame-card` id="B4"，姓名 + 出生年 + 性别 + 身高体重 + 目标 | `mobile/lib/features_v2/onboarding/basic_info_screen.dart` | 已对齐。所有字段与设计稿一致；目标下拉用 DropdownButton，与设计稿 select 一致。 |
| B5 | 已阻塞（BlockedScreen） | `frame-card` id="B5"，watch_off 图标 + 说明文字 + 去绑定按钮 | `mobile/lib/features_v2/onboarding/blocked_screen.dart` | 已对齐。`Icons.watch_off` 居中，PopScope 阻止返回，与设计稿全屏拦截语义一致。 |
| D5 | 主页（HomeScreen） | `frame-card` id="D5"，状态环 + 周统计 + 最近活动列表 + 生成计划 CTA | `mobile/lib/features_v2/home/home_screen.dart` | 已对齐。三环（疲劳/TSB/负荷）通过 `StatusRingCard` widget 渲染，颜色 band 与设计稿 green/warn/danger 一致。pull-to-refresh 已实现。 |
| D8 | 活动详情（ActivityDetailScreen） | `frame-card` id="D8"，顶部统计行 + HR/pace 折线图 + lap 表格 + 备注 | `mobile/lib/features_v2/activity/activity_detail_screen.dart` | 地图为 placeholder（设计稿有地图卡），tracked 为 M1.x 任务。其余统计/图表/lap 已对齐。 |
| E1 | 健康概览（HealthOverviewScreen） | `frame-card` id="E1"，2×2 指标卡 + 睡眠迷你图 + AI 解读卡 | `mobile/lib/features_v2/health/health_overview_screen.dart` | 已对齐。指标卡使用 `MetricCard` 组件，fl_chart 渲染睡眠柱状图。AI 解读卡为静态文字。 |
| G1 | 个人中心（ProfileScreen） | `frame-card` id="G1"，用户头像 + 名字 + 邮箱 + 终身里程 + 菜单列表 + 退出 | `mobile/lib/features_v2/profile/profile_screen.dart` | 已对齐。头像为首字母 CircleAvatar（设计稿同），菜单列表用 `ProfileMenuItem` 组件。退出调用 authController.logout()。 |

## 共享组件对照

| 组件 | 设计稿 CSS class | 实现路径 | 一致性 |
|---|---|---|---|
| StridePill | `.pill` / `.pill.green` / `.pill.warn` / `.pill.danger` / `.pill.solid` | `mobile/lib/features_v2/_shared/widgets/pill.dart` + `mobile/lib/core/theme/pill_colors.dart` | 已对齐。5 个 variant 与设计稿 class 一一对应，颜色值直接来自 `StrideTokens`。 |
| StrideStatRow | `.stat-row`（3 列等宽，label + value + unit） | `mobile/lib/features_v2/_shared/widgets/stat_row.dart` | 已对齐。严格要求 3 items（assert），字体 mono/sans 可切换，与设计稿 3 列结构一致。 |
| StrideTopBar | `.top-bar`（左 leading + 居左 title + 右 actions） | `mobile/lib/features_v2/_shared/widgets/top_bar.dart` | 已对齐。高度 48/40（compact），底部 1px border，implements PreferredSizeWidget。 |
| StrideNavTab | `.nav-tab .item`（顶部 4px indicator + icon + label） | `mobile/lib/features_v2/_shared/widgets/nav_tab.dart` | 已对齐。选中态 4px accent 条，未选中态 transparent。label 和 icon 与设计稿一致。 |
| StrideSegControl | `.seg`（2px padding 背景 + 滑动选中块） | `mobile/lib/features_v2/_shared/widgets/seg_control.dart` | 已对齐。圆角 8px，选中块白底 shadow，与设计稿 `radiusSm` 一致。 |
| StridePhoneCard | `.phone`（390×844 iPhone 外框，dev 预览用） | `mobile/lib/features_v2/_shared/widgets/phone_card.dart` | 已对齐。仅用于 widget book 预览，不进入 production 路由。 |

## 颜色 token 对照

| Token | 设计稿值（`:root` CSS var） | 实现值（`tokens.dart`） | 一致 |
|---|---|---|---|
| `--bg` | `#F7F9FB` | `Color(0xFFF7F9FB)` | 已对齐 |
| `--surface` | `#FFFFFF` | `Color(0xFFFFFFFF)` | 已对齐 |
| `--fg` | `#2C3340` | `Color(0xFF2C3340)` | 已对齐 |
| `--fg-soft` | `#4A5260` | `Color(0xFF4A5260)` | 已对齐 |
| `--muted` | `#6B7280` | `Color(0xFF6B7280)` | 已对齐 |
| `--muted-2` | `#AAB1BD` | `Color(0xFFAAB1BD)` | 已对齐 |
| `--border` | `#DFE3EA` | `Color(0xFFDFE3EA)` | 已对齐 |
| `--border-2` | `#EBEEF3` | `Color(0xFFEBEEF3)` | 已对齐 |
| `--accent` | `oklch(58% 0.16 145)` ≈ `#1FAD5B` | `Color(0xFF1FAD5B)` | 已对齐（oklch 近似转换） |
| `--accent-fg` | `#E8FFEF` | `Color(0xFFE8FFEF)` | 已对齐 |
| `--warn` | `#D89A3D` | `Color(0xFFD89A3D)` | 已对齐 |
| `--danger` | `#D74331` | `Color(0xFFD74331)` | 已对齐 |
| `--grid` | `#EFF2F6` | `Color(0xFFEFF2F6)` | 已对齐 |

## 字体 token 对照

| Token | 设计稿值 | 实现值（`tokens.dart`） | 一致 |
|---|---|---|---|
| Sans 字体 | `'DM Sans', sans-serif` | `AppTypography.fontSans = 'DM Sans'` | 已对齐 |
| Mono 字体 | `'DM Mono', monospace` | `AppTypography.fontMono = 'DM Mono'` | 已对齐（override：设计稿用 IBM Plex Mono，实现用 DM Mono，经用户确认 override 生效） |
| fs-display-64 | 64px | `fsDisplay64 = 64` | 已对齐 |
| fs-display-48 | 48px | `fsDisplay48 = 48` | 已对齐 |
| fs-display-40 | 40px | `fsDisplay40 = 40` | 已对齐 |
| fs-18 | 18px | `fs18 = 18` | 已对齐 |

## 待优化项（不阻塞 M1 验收）

- **D8 GPS 地图**：ActivityDetailScreen 的地图卡为 placeholder（灰色容器 + "地图 TODO" 文字）。设计稿有路线地图卡（类似 M1.x 中已实现的后端 SVG thumbnail 方案）。计划在 M1.x 引入 flutter_map + AMap tile。
- **B3 SyncProgressScreen 动画**：设计稿有环形进度动画，实现使用 LinearProgressIndicator（线性）。视觉差异可接受，M1.x 可升级为环形。
- **G1 头像**：设计稿显示真实用户头像图片，实现为首字母 CircleAvatar。M1 不涉及头像上传功能，后续版本对齐。
- **主页状态环 SVG**：设计稿的三环通过纯 CSS conic-gradient 实现。Flutter 实现用 `CustomPaint` + `drawArc`，视觉效果一致但技术路径不同，可接受。
- **字体加载**：`DM Sans` / `DM Mono` 通过 `pubspec.yaml assets/fonts/` 注册。如设备首次加载时字体回退为系统字体，视觉会有轻微差异（Android 会用 Roboto）。
