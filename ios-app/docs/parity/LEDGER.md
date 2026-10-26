# Parity Ledger — 小程序 vs iOS App

- 铁律与流程：`.agents/skills/mp-ios-parity-check`（stride 工作区）
- 基线：[baseline.md](baseline.md)（27 活跃页功能对照，devops#747 产物落盘）
- 转译映射：[mapping.md](mapping.md)（devops#749 产物落盘）
- 状态：`aligned`（一致）/ `pending`（差异待确认）/ `confirmed`（人工确认保留差异）
- confirmed 必须三选一：**保留偏差**（含平台差异）/ **修 iOS 对齐**（转实施票）/ **放弃该功能**（1.0 不做，注明理由）
- 本文件是唯一事实源；`pending` 清零是发布门槛（devops#759）

## 全局种子条目（PR-1 建立，devops#764）

> 本表登记决议既定的跨页 confirmed 偏差；各域票收尾时逐页增补 P/D 条目。

| ID | 检查点 | 维度 | 小程序现状 | iOS 现状 | 状态 | 确认人 | 日期 | 说明 |
| ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- |
| D-theme-1 | 主题体系 | UI | 深色 `#07080A` 底 + dark.wxss 26 token（styles/dark.wxss:31） | 亮色 LightTheme，accent 藕粉 #ff6363（StrideKit/Sources/StrideKit/Core/Theme/LightTheme.swift:15），Info.plist 锁 UIUserInterfaceStyle=Light | confirmed | 用户（#753 决议 1，2026-10-25） | 2026-10-26 | 保留偏差：App 亮色定调；逐页颜色按「映射后语义」判对比，不逐色判 |
| D-icon-1 | 图标体系 | UI | SVG 资产双态图标（custom-tab-bar、各页内联 svg） | SF Symbols 重制（AppTab.swift:17），品牌资产（logo/海报字样）仍自带 | confirmed | 用户（#753 决议 6） | 2026-10-26 | 保留偏差：图标 SF Symbols 全套重制，逐 icon 对照表归各域票产出 |
| D-nav-1 | switchTab 栈语义 | 架构 | switchTab 销毁所有普通页栈（26 处调用） | TabView 四 tab 各自 NavigationStack 栈保留（AppRouter.swift:16） | confirmed | 用户（#751 决议 4） | 2026-10-26 | 保留偏差：iOS 惯例切 tab 不清栈；reLaunch 语义由 AppRouter.reset(to:) 保住 |
| D-nav-2 | 死页 | 架构 | plan/health 两页注册但零引用（baseline §10） | Route 表 27 页不含这两页（Route.swift） | confirmed | 用户（#751 推导项） | 2026-10-26 | 放弃该功能：死页不迁；其 services 端点在活跃页仍消费 |
| D-nav-3 | 返回兜底 | 架构 | 顶栏 canBack ? 箭头 : home 小房子；返回 fail → switchTab 教练 | 系统返回 + 边缘滑手势；深链 path 填根使返回永远有处可退，小房子整体消失（AppRouter.reset） | confirmed | 用户（#749 §3 / #751 决议 4） | 2026-10-26 | 保留偏差：只读落地页如需「回主页」用 toolbar 显式按钮 |
| D-auth-1 | 免密登录链路 | 架构 | wx.login code 换 JWT（silentLogin/recoverSession，每生命周期一次） | 不迁：401 → refresh 单飞一次 → 失败清 Keychain → 全屏 Login + redirect 回跳（APIClient.swift + AppModel.handleSessionExpired） | confirmed | 用户（#751 决议 2 / #419 边界） | 2026-10-26 | 放弃该功能：iOS 无微信身份，SMS+邮箱密码（PR-2 登录域承接） |
| D-sheet-1 | 底部弹层形态 | UI | wx.showActionSheet / showModal / 自绘抽屉 | confirmationDialog / alert / .sheet（系统形态，D-6/D-7 对等实现） | confirmed | 用户（#749 §8） | 2026-10-26 | 保留偏差：系统组件形态差异，语义等价 |
| D-menu-1 | 长按/更多菜单 | UI | 页面内「···」菜单 + 长按操作 | contextMenu / 显式按钮（iOS 惯例无「···」胶囊） | confirmed | 用户（#749 §8 D-13） | 2026-10-26 | 保留偏差：胶囊菜单移除，操作入口重排归各域票 |
| D-share-1 | 朋友圈渠道 | 功能 | onShareTimeline 单页模式分享 | 仅单一路分享（ShareLink），timeline 渠道无对等 | confirmed | 用户（#749 §8 D-2） | 2026-10-26 | 放弃该功能：微信生态渠道，iOS 无对等；单一路分享用 universal link 承载 |
| D-poster-1 | 海报保存交互 | UI | canvas 海报 → previewImage 长按保存 | 声明式海报 View + ImageRenderer + fullScreenCover 预览 + 显式「保存/分享」按钮 | confirmed | 用户（#749 §5 / D-9） | 2026-10-26 | 保留偏差：iOS 无长按保存惯例；需照片库写入权限文案（PR-8 落地） |

## 引导账号域（PR-2 落地后登记）

（空）

## 记录域（PR-3 落地后登记）

（空）

## 教练域（PR-4 落地后登记）

（空）

## 训练域（PR-5 落地后登记）

（空）

## 赛事域（PR-6 落地后登记）

（空）

## 收尾域（PR-7 落地后登记）

（空）

## 分享出向（PR-8 落地后登记）

（空）
