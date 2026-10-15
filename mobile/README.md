# STRIDE Mobile (Flutter)

STRIDE 跑步训练项目的跨端移动 App。信息架构对齐小程序四 tab（训练 / 记录 /
教练 / 我，stride-devops#414），**Android v1** 为当前发布目标；iOS 复用同一份
`lib/` 代码，终验以 iOS 模拟器 + 真机走查为准。

> 迁移已完成（stride-devops#413 地图 + #426 收口决议，实施 PR #563–#572）。
> Onboarding 为单页三步状态机（资料 → 绑表 → 同步），走通用 full-sync 契约，
> 无表用户放行进首页（不再有 blocked 死路）。旧的「onboarding 暂停」声明已
> 随 #418 / #461 决议废止。

这是 `https://api.stride-running.cn/api/*` 的客户端，auth 走同网关
`/api/auth/*`；教练对话走 `/api/users/me/coach/*`（网关分流到 TS coach
服务，SSE 流式）。

## Quick reference

- **Design system:** `mobile/DESIGN.md`（Vercel 风基底）+ `mobile/STRIDE_OVERRIDES.md`（accent-green + extended Mono）
- **Package name / bundle id:** Android `com.lipaotech.stridewise` · iOS `com.lipaotech.stridewise`
- **Min SDK:** API 26 (Android 8.0)
- **Domain:** `stride-running.cn`

## Setup

Requires Flutter SDK (stable channel ≥ 3.47) and Android SDK (cmdline-tools or
full Android Studio).

```bash
# 1. Resolve dependencies
cd mobile
flutter pub get

# 2. (One-time) Generate launcher icons from assets/branding/icon-1024.png
dart run flutter_launcher_icons

# 3. Run on connected device or emulator（默认直连生产 API）
flutter run
```

本地后端联调（可选）：

```bash
flutter run \
  --dart-define=API_BASE_URL=http://10.0.2.2:8000 \
  --dart-define=AUTH_URL=http://10.0.2.2:8001
```

## Project layout

```
lib/
├── main.dart                # entry point + ProviderScope
├── app.dart                 # MaterialApp.router + GoRouter + 自更新检查
├── core/                    # Cross-cutting concerns
│   ├── api/                 # Dio client + interceptors（X-Client-Id、token 刷新）
│   ├── auth/                # auth-service tokens + secure storage + 当前用户态
│   ├── env/                 # build-time dart-define 配置（默认全生产值）
│   ├── router/              # GoRouter：四 tab IA、auth/onboarding 守卫、
│   │   ├── app_router.dart  #   /v2 深链重定向
│   │   └── routes.dart      #   路由常量 + 重定向映射表
│   ├── theme/               # Material3 亮色主题（tokens.dart / app_colors.dart）
│   └── updater/             # GitHub Releases 自更新检查
├── data/
│   ├── api/                 # 手写 REST 客户端（stride_api / coach_turn_id）
│   ├── coach/               # 教练 SSE 客户端（sse_parser / coach_api / cards）
│   └── models/              # @JsonSerializable 契约模型
├── features/                # 仅剩 updater 提示 UI（v1 legacy 屏已全删）
├── features_v2/             # 全部页面（四 tab IA）
│   ├── _shared/             # MainShell（底部导航）+ 通用 widgets
│   │   ├── shell/           #   main_shell.dart
│   │   └── widgets/         #   StridePill / TopBar / SegControl / PhoneCard …
│   ├── auth/                # 登录（SMS/邮箱双 tab）、注册、法务声明页
│   ├── onboarding/          # 单页三步：资料 → 绑表 → 同步（full-sync 契约）
│   ├── training/            # 训练 tab（今日课表 + 周日期条 + 营养摘要）
│   ├── plan/                # 周计划：周列表 / 周详情 / 会话详情
│   ├── records/             # 记录列表 + 活动详情（含高德轨迹地图 widgets/）
│   ├── coach/               # 教练 SSE 对话 + 多会话抽屉 + 策略卡片交接
│   ├── race/                # 赛事中心 / 详情 / 策略 / 我的比赛
│   ├── health/              # 训练状态页 + 雷达 / 预测 / PB
│   ├── watch/               # 手表双品牌绑定与手动同步
│   └── profile/             # 我 tab + 资料编辑 / 隐私
└── shared/
    ├── utils/               # 日期 / 配速 / 坐标（WGS84→GCJ02）格式化
    └── widgets/             # 曲线图（HR/Pace）等 primitives
```

## Router & IA

GoRouter 守卫规则（stride-devops#461）：

```
0. Legacy /v2/* 深链   → 按 #414 映射表重定向到新路由
   已删 E1/E2/E3 深链   → /me/data* 保底重定向到 /me/training-status
1. 无 token            → /auth/start（/auth/* 与 /declaration/* 公开）
2. token, !completedAt → /onboarding（单页三步，页面自重算落点）
3. else                → 按请求路由（无表不拦，首页空态引导绑表）
```

### Route map

| Path | Screen |
|------|--------|
| `/auth/start` | 启动页（登录/注册入口 + 法务链接） |
| `/auth/login` | 登录（SMS 默认 tab / 邮箱密码 tab） |
| `/auth/register` | 注册（SMS 首登自动注册） |
| `/declaration/:docType` | 法务声明（公开可读） |
| `/onboarding` | 单页三步 onboarding |
| `/training` | 训练 tab（shell） |
| `/training/plan` | 周计划周列表 |
| `/training/plan/weeks/:folder` | 周详情 |
| `/training/plan/weeks/:folder/sessions/:date/:sessionIndex` | 会话详情 |
| `/records` | 记录 tab（shell，月份折叠 + 分页） |
| `/records/activity/:id` | 活动详情（指标/曲线/圈表/力量/轨迹地图） |
| `/coach` | 教练 tab（shell，SSE 流式对话） |
| `/races` | 赛事中心（全页栈） |
| `/races/:id` | 赛事详情（概要/项目/出行 + 报名 sheet） |
| `/races/:id/strategy` | 比赛策略（版本 pills + 海报分享） |
| `/my-races` | 我的比赛（赛程/成绩双 tab） |
| `/me` | 我 tab（shell，菜单 + 手动同步 + 退出） |
| `/me/profile-edit` | 资料编辑（头像直传 COS，双库字段） |
| `/me/privacy` | 隐私与权限（声明入口） |
| `/me/training-status` | 训练状态（4 指标卡 + 五图 + 热力图） |
| `/me/data/ability` · `/me/data/predictions` · `/me/data/pbs` | 雷达 / 预测 / PB |
| `/me/watch` | 手表管理（Garmin/COROS 双品牌） |

## Hand-written API client (no codegen)

All API client code is hand-written `@JsonSerializable()` + Dio. When backend
models change, update `mobile/lib/data/models/` in the same PR. No OpenAPI
generator — contract drift is caught by the contract tests and walkthrough
tests instead.

## 高德地图（轨迹地图）

活动详情 GPS 轨迹用 `flutter_amap_plus`（issue 463）：WGS84→GCJ02 转换、
共享端点分段、三色着色。Android key 已内置（`Env.amapAndroidKey`，公开 key
参照行业先例 + AndroidManifest meta-data）；**iOS key 尚未申请**（#422 只备了
Android key），iOS 端底图鉴权会降级，key 到位后经
`--dart-define=AMAP_IOS_KEY` 注入即可。

## Self-update (in-app)

App 启动后查 GitHub Releases 最新版（`core/updater/`），有新版弹提示，下载
APK 安装（Android）。回滚 = 重装上一版 Release APK。

## Distribution (v1)

Signed APK attached to GitHub Release on tagged push (`mobile-v2026.10.0`
style, CalVer)。No Play Store account in v1. Sideload only；Web Landing 下载
区链接指向 `github.com/zhaochy1990/running/releases/latest`。

## Testing

- **Unit / widget tests:** `flutter test`（CI 强制，含 router 重定向、契约
  model、海报分享文本等）
- **Integration walkthroughs:** `integration_test/*_walkthrough_test.dart`，
  真实 tap 直连生产 API，凭据经 `--dart-define=TEST_EMAIL/TEST_PASSWORD`
  注入（不落仓库）；宿主机监听 `WALKTHROUGH-MARK:` 输出配合
  `xcrun simctl io booted screenshot` 逐页截图
- **发布门槛**（stride-devops#426 决议）：CI 全绿 + 契约测试 + 18 页
  checklist 终验三绿，才可打 `mobile-v*` tag

## Decisions reference

- 迁移地图与全部决议：stride-devops#413（含各域决策票）
- 收口决议 + 18 页终验 checklist：stride-devops#426
