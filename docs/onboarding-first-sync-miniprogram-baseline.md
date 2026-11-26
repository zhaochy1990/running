# 小程序首次同步（session 路径）行为基线 — devops#1015 / Epic devops#1004 T11

本文是小程序端「绑表后进首页、续看和失败重试」的**明确行为基线**，供 iOS 对齐（T12）
与真实开发者工具/测试环境验证使用。实现：`src/wechat-miniprogram/`（服务
`services/onboarding-sync.ts`、视图模型 `utils/onboardingSession.ts`、状态卡组件
`components/onboarding-sync-status/`、提交步 `pages/onboarding/`）。Web 对应实现为
devops#1014（T10），语义一致、交互面随平台。

## 1. 入口选择（客户端只跟随服务端开关）

- `GET /api/users/me/profile` 的 `features` 回显双开关：`sync_data_at_onboarding`（总开关）
  与 `onboarding_sync_session`（rollout）。**两者同开**才走 session 路径；任一关闭维持
  旧 full-run 流程，旧路径行为不变（本地 run 指针 + 认领别端 run + 幂等键）。
- 开关在「读 profile 之后、提交之前」被关：session 提交会收到 403（或 503 未接线），
  客户端**当场回退旧流程**，不报错、不重试 session。
- 游客/未登录：状态卡完全静默（认证 settle 后才轮询，避免 401 触发登录跳转）。

## 2. 提交步（onboarding 同步步，session 模式）

1. `POST /api/users/me/onboarding/sync`（body `{}`）——服务端原子创建或认领当前绑定
   的 session。**客户端无本地指针、无幂等键**：杀进程、重新登录、多端同时进入都解析到
   同一个 session，不重复创建 full。
2. 返回 `shell_ready=true`（session 与可靠派发记录均已持久化）→ **profile-only 完成**
   （不传 run_id，新 run 永不交给旧完成验证）→ 按既有安全 redirect 语义进首页
   （redirect 参数经 `sanitizeRedirect` 校验后 reLaunch；默认 coach tab）。
3. 返回 `shell_ready=false`（`waiting_legacy`：服务端接管在途旧 full run）→ 展示
   「正在接管已有同步任务」，每 5s `GET` 只读视图直到 shell_ready 再进首页；期间链路
   判 failed 则如实展示（区别于创建失败的文案），可重试。
4. 创建失败（非 403/503/409）→ 如实报「同步任务创建失败：后台没有正在运行的同步任务，
   不会重复导入数据」，**不假报后台正在同步**；重试按钮重新 POST。
5. `409 no_watch_provider`（能力标志不满足，如提交前解绑）→ 回绑表步。
6. 绑表页（`pages/watch`）绑定成功后 fire-and-forget 触发一次（session 模式 POST 创建/
   认领；旧模式 ensureSync），带 redirect 直接回来源页，同步在服务端继续。

## 3. 同步进度与缺口

- 提交步等待近期数据，历史数据在后台补齐。首页没有常驻同步卡。手表管理页通过
  `GET /api/users/me/onboarding/sync` 只读载入首次同步状态和可展开的阶段明细，离开页面即停轮询。
- 明细分别显示目标范围与实际覆盖。`empty` 显示无训练或健康记录，COROS 的短健康批次显示实测天数。
  只有正常空档的阶段标为已完成，这些日期依然没有实际覆盖。`transient` 显示暂时拿不到的数据，后台
  自动重试。`unavailable` 单列无法获取的记录和原因。
- 提交步等待期间若遇到暂时失败，可看到正在重试的日期。长期失败仍可在提交步通过
  `POST {retry:true}` 恢复未完成项，已完成凭据复用。

## 4. 旧 run 迁移

已有在途旧 full run 的用户首次 POST 时由服务端 `waiting_legacy` 接管并对账（不并行新
session、不重复拉取）；旧 run 已结束的老用户正常走 session 创建。客户端无需感知迁移
细节——只认 shell_ready 与只读视图。

## 5. 真实开发者工具/测试环境验证清单（AC5）

前置：测试环境双开关全开（`sync-data-at-onboarding` + `onboarding-sync-session`），
准备一个多年历史数据的 Garmin/COROS 测试账号、一个新账号、两台设备/两个开发者工具实例。

- [ ] 新账号：资料 → 绑表 → 提交步显示「正在准备你的训练数据」→ shell_ready 后自动进
      首页（带 redirect 深链时回跳目标页，非法 redirect 落默认 tab）。
- [ ] 近期数据就绪后从记录页打开近期训练详情（心率/圈/轨迹）。在手表管理页展开首次同步，
      确认各类缺口文案和实际覆盖范围。
- [ ] 绑表后杀进程重开、退出重登、两台设备同时进 onboarding：均只有一个 session
      （服务端 session_id 相同），不出现第二个 full。
- [ ] 中途换设备续看：GET-only 展示同一进度；折叠/展开偏好记忆生效。
- [ ] 失败重试：断网/错凭据制造 failed → 卡片展示错误与缺项（文案区分）→「重试失败项」
      只重派失败阶段。每个重派阶段使 `fail_retry_count` 加一，已成功范围继续复用。
- [ ] 正常空档：休息日没有训练记录，阶段显示已完成；COROS 短健康批次能说明厂商提供的范围。
- [ ] 开关回退：关掉 rollout 开关后重进 onboarding → 走旧 full-run 流程（进度条文案、
      本地指针续跑语义与 devops#1015 之前一致）；状态卡静默隐藏。
- [ ] 旧 run 迁移：开关开启前已起过旧 full run 的账号，POST 后显示「正在接管已有同步任务」，
      完成后进度并入 session 视图。

## 6. iOS parity 要点

- 入口判定、回退规则、shell_ready 语义、只读轮询与重试端点必须与本文一致（服务端契约
  见 devops#1006；Go handler `src/go/internal/api/onboarding_sync.go`）。
- 平台差异允许项：状态卡的呈现形式（banner vs 卡片）、轮询启停跟随页面生命周期的方式、
  折叠偏好的本地存储介质。
