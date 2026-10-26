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

## 引导账号域（PR-2 落地，devops#765）

| ID | 检查点 | 维度 | 小程序现状 | iOS 现状 | 状态 | 确认人 | 日期 | 说明 |
| ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- |
| P-login-1 | 登录页结构 | UI | 双 tab（手机验证码默认/邮箱密码）+ 60s 倒计时 + 行内错误区 + 协议勾选门默认不勾 + 忘记密码 toast + 法务链接 declaration | 同构：验证码默认双 tab、60s 倒计时（发送失败不启动）、18 错误码中文表（AuthErrorMessages.swift）、协议门、忘记密码「暂未开放，请联系客服」toast、法务链接本地栈 push（LoginView.swift） | aligned | — | 2026-10-26 | #752 决议一逐项；错误码表与 #460 三端同表 |
| D-login-1 | 登录通道 | 架构 | 手机 tab 走 wechat_phone_bind grant（微信身份+手机号），微信免登 wx.login code 换 token | 纯 SMS login-or-register（sms/send scene=login + sms/verify）+ 邮箱密码 /api/auth/login；微信链路整体不迁 | confirmed | 用户（#419 决议 1 / #752 决议一） | 2026-10-26 | 保留偏差：iOS 无微信身份（全局面 D-auth-1 已覆盖，本条登记页面级）；invite_code 字段位预留（门禁将来开不用改客户端） |
| P-login-2 | 登录成功分支 | 架构 | redirect 回跳 / registered=true→onboarding 透传 redirect / 老用户→coach tab（login.ts:99-112） | 同序：redirect 优先；sms/verify 不回 registered，由档案链（GET profile !profile_ready→onboarding）判定新用户；查询失败放行 coach（AppModel.handleLoginSuccess） | aligned | — | 2026-10-26 | #752 决议「onboarding 重定向链天然覆盖」；401 回登录页预填 lastSmsPhone（一键重发不自动发） |
| P-onb-1 | onboarding 状态机 | 架构 | 单页三步五视图 + onShow 重算落点 + ensureSync 五段链（开关→有表→指针三分→认领别端 run→幂等键先落盘）+ 60min 超时=pending | 同构五视图（loading/profile/watch/sync/ready），进页面+前台恢复双触发 refresh；OnboardingSyncService 五段链，指针/幂等键 key 与 Web/小程序同名（stride:onboarding-run:{uid}），轮询 2s/60min、超时 pending 放行 | aligned | — | 2026-10-26 | #418 决议全量；complete=资料步（ADR 0013）空 body 幂等自愈；失败重试清指针+幂等键起新 run |
| D-onb-1 | 头像选择 | UI | button open-type=chooseAvatar（微信头像/相册）→ 远端 URL 先 downloadFile 再 uploadFile | PhotosPicker 选图 → multipart 直传 POST /api/users/me/avatar → PATCH /api/users/me 回写 avatar_url；上传失败不阻断建档（best-effort） | confirmed | 用户（#752 决议一「chooseAvatar→PhotosPicker」） | 2026-10-26 | 保留偏差：平台选择器差异；微信头像 CDN 下载链路无对等（相册选图天然本地） |
| P-onb-2 | 资料步字段 | UI | 六字段（昵称/性别 picker/生日 picker 默认 1990-01-01/身高体重/跑龄 picker），OPTIONS 展示与 VALUES 提交分离 | 同六字段；OPTIONS（男/女/其他、暂不透露…3 年以上）与 VALUES（male…、lt_6m…）分离（OnboardingSteps.swift），生日 DatePicker 默认 1990-01-01 防「今天」 | aligned | — | 2026-10-26 | 与 Go profileInput oneof 严格一致（users.go:206）；RHR/MaxHR 不在 onboarding（#418 决议 5） |
| P-decl-1 | 声明页 | UI | mp-html 渲染 GET /api/declarations/{doc_type}（auth:false），404=尚未发布，非法 doc_type 白名单拒绝 | MarkdownText 简易 GFM 渲染（标题/列表/引用/表格/代码块 + AttributedString 行内），公开拉取 404=「该声明尚未发布」；doc_type 白名单由 DeclarationType 收口（DeclarationView.swift） | aligned | — | 2026-10-26 | mapping.md 转译约定（mp-html→简易渲染器，内容是 markdown 无需 WKWebView）；极端 HTML 标签按纯文本回退 |
| P-priv-1 | 隐私聚合页 | UI | 两行菜单（用户协议/隐私政策，icon+标题+副标题）→ declaration | 同构两行菜单卡片，路由 .privacy → .declaration push（PrivacyView） | aligned | — | 2026-10-26 | 入口在 profile-edit「隐私与权限」行（PR-7 接线），路由与本页先行落地 |

## 记录域（PR-3 落地后登记，devops#766）

| ID | 检查点 | 维度 | 小程序现状 | iOS 现状 | 状态 | 确认人 | 日期 | 说明 |
| ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- |
| D-rec-1 | 记录 tab 顶栏 | UI | 自绘顶栏（菜单钮 toast「暂未开放」/标题+副标题「最近训练」/胶囊占位） | 系统 inline 导航标题「活动记录」，无菜单钮/副标题（ActivitiesView.swift） | confirmed | 用户（#749 §3 tab 顶栏升级系统容器 + D-menu-1） | 2026-10-26 | 保留偏差：菜单钮在小程序即占位 toast；副标题信息量低；胶囊占位删除 |
| D-rec-2 | 指标值配色 | UI | METRIC_COLORS 深色荧光（run/pace #00e676、duration #0097a7、hr #ff5252） | 系统动态色映射同语义：跑量/配速 green、时长 teal、心率 danger（MetricsGridView） | confirmed | 用户（D-theme-1 亮色定调 + #753 决议：逐页按映射后语义判色） | 2026-10-26 | 保留偏差：数值语义保留，色值随亮色主题换系统动态色（深浅自适应） |
| D-rec-3 | 列表行路线缩略图 | 功能 | 后端预渲染 thumb_url PNG，加载失败回退运动图标 | 同款 AsyncImage(thumb_url)+失败回退 SF Symbol；**未用 MKMapSnapshotter 本地生成** | pending | — | 2026-10-26 | #754 决议提过 MKMapSnapshotter，但 list 端点无 GPS 坐标、快照无数据源（后端 route_thumbnails job 已出图）；如需本地生成须列表端点加轻量 GPS 摘要，另立票 |
| D-rec-4 | 区间卡走势曲线 | UI | uCharts 折线按区间档位渐变着色（linearColor 硬切）+ 基线带 + 触摸 tooltip | Swift Charts 单色 LineMark（uCharts 基础粉）+ 档位基线带（RectangleMark）+ chartOverlay tooltip；折线本体不逐段着色（ZoneChartView.swift） | pending | — | 2026-10-26 | Charts 无四角线段图元；档位信息由基线带承载；后续可 Canvas 叠层补分段着色 |
| D-rec-5 | 详情头部字段 | UI | 顶栏仅名称+日期；sportLabel/trainTypeLabel 计算但 wxml 未渲染 | 按 baseline §3.1/票面渲染头部（运动 chip + 训练类型 + 体感 emoji；名称/日期在顶栏 principal） | pending | — | 2026-10-26 | baseline 描述与 wxml 实际不一致；iOS 按 baseline 票面实现，parity check 时与小程序对账 |
| A-rec-1 | 轨迹地图渲染决议 | UI | `<map>` 腾讯底图：wgs84ToGcj02 预转 + include-points + polyline 分段 + marker/label | MKMapView 包装：WGS-84 直传（勿转 GCJ-02）+ 禁旋转/俯仰 + 三色 gradient3 + 共享端点 8 点分段 + pause 分段 + 10% padding + 起终点徽标 + 圈号（TrackMapBuilder/TrackMapView） | aligned | 用户（#754 决议一/二） | 2026-10-26 | 坐标铁律有单测（WGS-84 逐位直传）；中国区加偏实测（外滩地标）留待真机接入时执行并回填本行 |

## 教练域（PR-4 落地后登记，devops#767）

| ID | 检查点 | 维度 | 小程序现状 | iOS 现状 | 状态 | 确认人 | 日期 | 说明 |
| ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- |
| A-coach-1 | SSE 协议与解析 | 功能 | wx.request enableChunked + utils/sse.ts 字节级解析；五事件；超时 660s | URLSession.bytes + SSEParser 直译移植（mobile sse_parser.dart 同源）；timeoutInterval 空闲 120s + 总上限 660s（#421 决议勿照抄 60s） | aligned | — | 2026-10-26 | 单测覆盖任意字节边界/多字节 UTF-8/CRLF/截断恢复（SSEParserTests 12 例） |
| A-coach-2 | 幂等与 401 | 功能 | client_turn_id 失败重试复用；流内 401 刷新一次重建 parser | body 一次编码逐字节复用（fingerprint=sha256）；SSE 通道独立 401 单飞刷新（CoachClientTests 断言两轮 body 相同） | aligned | — | 2026-10-26 | 会话 JSON 端点同享 coach 通道单飞，不走 APIClient data 面 |
| A-coach-3 | 结构化卡片四型 | 功能 | race-strategy/master-plan/custom-workout/workout-op 注册表 + 历史信封自愈 | CoachCardRegistry 同口径移植（形状校验/角标/双 CTA/删除双确认/409/422 复查/重进对账） | aligned | — | 2026-10-26 | 对账恢复终态（save_token/workout_id）单测覆盖 |
| A-coach-4 | 会话抽屉形态 | UI | 自绘 drawer（半屏浮层 + 新建/列表/当前徽标/搜索 toast） | .sheet bottom sheet（detents medium/large）同信息结构 | aligned | — | 2026-10-26 | D-sheet-1 种子条目推导演绎；搜索占位同 toast「暂未开放」 |
| A-coach-5 | 键盘避让 | UI | onKeyboardHeightChange 手动 padding 顶起输入栏 | SwiftUI 系统键盘避让（safe area） | aligned | — | 2026-10-26 | 平台默认行为语义等价，无需手动垫高 |
| D-coach-1 | markdown 渲染 | UI | mp-html 全量 GFM（含表格/嵌套） | 自研轻量子集（标题/列表/引用/围栏代码/表格/行内 AttributedString），零三方依赖 | pending | — | 2026-10-26 | 复杂嵌套 GFM（嵌套列表/内联 html）降级为段落文本；PR-10 parity 核对时请用户裁（补依赖库 or 保留子集） |
| D-coach-2 | 多选转发封面 | UI | canvas 预生成 5:4 气泡封面图（onShareAppMessage imageUrl） | 无 canvas 封面：系统分享面板自带链接预览卡片 | pending | — | 2026-10-26 | D-poster-1/D-share-1 同族差异；是否需要自绘封面图 PR-8 分享出向统一裁 |
| D-coach-3 | 转发阅读端 | 功能 | path=/pages/coach-share/coach-share?sid=（微信内打开） | universal link https://stride-running.cn/pages/coach-share/coach-share?sid= | aligned | 用户（D-share-1） | 2026-10-26 | 落地页免登录浏览形态归 PR-8（AppModel.applyIncoming 注释位） |

### PR-4 未迁面（显式登记）

- 流式气泡 16ms 帧节流合并（MP setTimeout 节流）：SwiftUI 状态更新天然合帧，逐 delta 更新渲染语义等价，不单列偏差。
- `shareIndex` 投影序号、空回复降级占位、needs_input 追问不领序号、断流回前台对账：行为对齐（CoachChatModelTests 24 例覆盖）。

## 训练域（PR-5 落地后登记）

（空）

## 赛事域（PR-6 落地后登记）

（空）

## 收尾域（PR-7 落地后登记）

（空）

## 分享出向（PR-8 落地后登记）

（空）
