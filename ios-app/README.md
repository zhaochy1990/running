# Stridewise iOS App

SwiftUI 原生 iOS App（小程序 → SwiftUI 迁移，devops#763 Epic）。本目录由
PR-1（devops#764）建立：工程地基 + 主题骨架 + 全局路由 + APIClient + CI + parity 文档。

## 结构

```
ios-app/
├── Stridewise.xcodeproj/     # 单 App target（Bundle ID com.lipaotech.stridewise，
│                             #   iOS 17、Swift 6、自动签名 Team M4G5WA6N83）
├── App/                      # App target 源（@main + Assets；同步文件夹挂载）
├── Support/                  # Info.plist（锁亮色）/ entitlements（applinks）/ ExportOptions
├── StrideKit/                # 本地 SPM 包（App target 依赖；swift test 的主体）
│   ├── Sources/StrideKit/
│   │   ├── Core/             # Theme（协议+LightTheme+Tokens+Geist）、Router
│   │   │                     #   （Route 27 页白名单解析 / AppRouter / AppModel）、
│   │   │                     #   Network（APIClient / ApiError 双格式）、Auth（Keychain 双 token）
│   │   ├── Features/         # 页面骨架按域（Root / Tabs 四 tab / Auth Login）
│   │   ├── Shared/           # 跨域复用（iOS 专属 API 条件编译收敛于此）
│   │   └── Resources/Fonts/  # Geist Sans / Mono（Regular/Medium/Bold）
│   └── Tests/                # 深链解析 / 刷新单飞 / 主题 token / Keychain 往返等
├── docs/parity/              # baseline.md + mapping.md + LEDGER.md（parity 唯一事实源）
└── scripts/asc-bootstrap.rb  # ASC 引导：Bundle ID + Associated Domains + App 记录
```

## 本地开发

```bash
# 测试（macOS 宿主机直跑，无需模拟器）
cd ios-app/StrideKit && swift test

# 打开 Xcode 直接 Cmd+R（选 iOS 17+ 模拟器）
open ios-app/Stridewise.xcodeproj

# 命令行构建 App（免签名）
xcodebuild -project ios-app/Stridewise.xcodeproj -scheme Stridewise \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

骨架验收路径：启动 → checkAuth（无 token）→ 全屏 Login → 四 tab 空壳切换 /
栈保留 / 深链 `Route(url:)` 解析单测。免后端走查登录后骨架：

```bash
xcrun simctl launch <device> com.lipaotech.stridewise -StrideSkeletonLoggedIn
# （DEBUG-only 启动参数：跳过 checkAuth 直接进已登录态，AppModel.bootstrap）
```

## CI / TestFlight

`.github/workflows/ios-app.yml`：

- **PR / master push**：`swift test` + App 模拟器构建（免签名）
- **master push / 手动**：TestFlight 出包（macOS runner，~$1/次；PR 不跑，
  沿 mobile-build.yml 先例）——出包前 `asc-bootstrap.rb` 幂等完成
  Bundle ID 注册 / ASSOCIATED_DOMAINS capability / ASC App 记录，
  然后 `xcodebuild archive` + `-exportArchive`（destination=upload）自动
  签名上传，build number 由 ASC 自动递增。

**前置 secrets（仓库 Settings → Secrets，缺失时 TestFlight 作业 notice 跳过）：**

| Secret | 说明 |
| --- | --- |
| `ASC_KEY_ID` | App Store Connect API Key ID |
| `ASC_ISSUER_ID` | ASC Issuer ID |
| `ASC_KEY_P8` | .p8 私钥（base64 或原文） |

版本号 CalVer `2026.MM.PATCH`（现 2026.10.0，提审版本线走 devops#759）。
App 图标位在 `App/Assets.xcassets/AppIcon.appiconset`（1024 单尺寸位，
品牌资产落地后补文件名）。

## 后续票据衔接

- PR-2 登录域：LoginView 表单、18 错误码映射、profileReady 启动拦截（AppModel.bootstrap 注释位）
- PR-3~PR-7 各域：替换 `Features/` 空壳与 `RouteShellView` 占位页
- PR-4 教练域：coach turn 600s 超时、SSE（URLSession.bytes）
- PR-6 赛事域：`PendingStrategyDraft.payload` 定稿为结构化草稿
- PR-8 分享出向：公开落地页免登录浏览形态（AppModel.applyIncoming 注释位）
- PR-10：parity 全量核对（`docs/parity/LEDGER.md` pending 清零门槛）
