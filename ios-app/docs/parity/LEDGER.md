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
| D-coach-2 | 多选转发封面 | UI | canvas 预生成 5:4 气泡封面图（onShareAppMessage imageUrl） | CoachBubbleCoverView 声明式 5:4 气泡封面（暗底+藕粉顶线+前两条所选节选折行，coach.ts drawShareCover 直译），转发面板呈现时 ImageRenderer 出图随图+文案+链接整组送出（PR-8） | aligned | — | 2026-10-26 | 渲染失败 fail-soft 自动少封面项；折行/节选纯函数单测覆盖（ShareOutboundTests） |
| D-coach-3 | 转发阅读端 | 功能 | path=/pages/coach-share/coach-share?sid=（微信内打开） | universal link https://stride-running.cn/s/pages/coach-share/coach-share?sid=（PR-8 起 /s/ 分流前缀） | aligned | 用户（D-share-1） | 2026-10-26 | 未登录回流免登录浏览已随 PR-8 落地（A-share-6）；回流 Route(url:) 剥 /s/ 前缀 |

### PR-4 未迁面（显式登记）

- 流式气泡 16ms 帧节流合并（MP setTimeout 节流）：SwiftUI 状态更新天然合帧，逐 delta 更新渲染语义等价，不单列偏差。
- `shareIndex` 投影序号、空回复降级占位、needs_input 追问不领序号、断流回前台对账：行为对齐（CoachChatModelTests 24 例覆盖）。

## 训练域（PR-5 落地后登记，devops#768）

| ID | 检查点 | 维度 | 小程序现状 | iOS 现状 | 状态 | 确认人 | 日期 | 说明 |
| ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- |
| D-trn-1 | 训练 tab 顶栏 | UI | 自绘顶栏（菜单钮 toast「暂未开放」/「本周训练」+ 周副标题） | 系统 inline 导航标题 + principal 副标题（周次），菜单钮删除（TrainingHomeView.swift） | confirmed | 用户（D-rec-1 同款推导 + D-menu-1） | 2026-10-26 | 保留偏差：菜单钮在小程序即占位 toast；周副标题保留在 principal |
| D-trn-2 | 今日卡操作行 | UI | 手表/分享/更多 icon + ActionSheet→modal 双确认删除 | 显式 icon 按钮 + confirmationDialog 单确认（系统形态）；「更多」仅自建课出删除（TrainingHomeView.swift） | confirmed | 用户（D-sheet-1 / D-menu-1 对等实现） | 2026-10-26 | 保留偏差：删除确认从「ActionSheet 选删除 + modal 再确认」合并为系统 confirmationDialog；「暂无更多操作」toast 保留 |
| D-trn-3 | 自建课分享出向 | 功能 | onShareAppMessage 免登录落地页卡（canvas 5:4 封面预生成） | ShareLink 单一路分享，URL = web 域 + 落地路径占位（WorkoutSharePlaceholder）；canvas 封面不迁 | pending | — | 2026-10-26 | 出向归 PR-8（#758）接线：universal link 注册、真实落地页形态、海报封面（D-poster-1）届时收口 |
| D-trn-4 | 图表技术栈 | UI | uCharts（训练状态六图）+ CSS grid（计划周柱图/热力图格子）+ flex 强度条形图 | 训练状态六图 Swift Charts + chartOverlay tooltip（#756 决议沿 #754）；周柱图/强度条/16 周热力图自绘 SwiftUI 容器（#756：Charts RectangleMark 不适合该交互密度） | confirmed | 用户（#756 决议五） | 2026-10-26 | 保留偏差：图元技术栈换 Swift Charts；数据口径（分桶阈值/配色语义/归一算法）逐函数直译有单测 |
| D-trn-5 | 雷达/预测/PB 三块 | 功能 | 无（#747 清点实证，#423 决议描述与现状不符） | 不做（TrainingStatusView 不含三块） | confirmed | 用户（#756 决议一拍板：以当前代码为唯一事实源） | 2026-10-26 | 1.x 与小程序 #615-#619 线一起上双端对齐；ledger 不需记（1.0 与样板一致） |
| D-trn-6 | push 选日弹层 | UI | 自定义底部弹层组件（±7 天滚动列表） | .sheet + presentationDetents(.medium) 列表（今天起 8 个可选日，与 plan 端点 target_date 窗口一致）（PushDateSheet） | confirmed | 用户（#755 sheet 惯例 + D-sheet-1） | 2026-10-26 | 保留偏差：buildPushDateOptions 本身只取今天起 8 项（历史日不出现在选项）；iOS 沿同一工具函数口径 |
| A-trn-1 | 强度条形图与估时口径 | UI | deriveIntensityBars/estimateWorkoutSeconds 启发式（配速中值折算、课内归一 [55,95]、16 柱采样） | 逐函数直译（WorkoutSpec.swift），配速/心率分段线性锚点表原样，单测覆盖锚点/采样/休息占位 | aligned | 用户（#756 决议三：10-20 口径照搬） | 2026-10-26 | 课表类型 chip 七类启发式、分段组（骑线 ×N/休息独立行/心率帽）、力量动作行同款直译 |
| A-trn-2 | 备赛旅程视图模型 | UI | training-plan.ts buildViewModels（阶段 span 推导/当前周解析/周柱归一/点柱详情/dose 兜底系数） | TrainingPlanBuilder 逐函数直译（周区间缺口按日期推导、current_week_number 优先、km·dose 切换重建、计划 dose≈跑量×6.6-7.6 兜底），单测覆盖 | aligned | 用户（#756 决议四） | 2026-10-26 | v1 旧 markdown 计划不渲染、提示去网页；空态 CTA switchTab coach（selectedTab 等价） |
| D-trn-7 | 跨域同名 wire 镜像 | 架构 | types/plan.ts + utils/workoutSegments.ts 全库一份（各页直接 import） | 训练域（TrainingWireModels/WorkoutSpec，flat 类型 + enum kind）与教练域（CoachPlanSessionRow，4 字段最小投影）、分享落地域（Landing 前缀自持镜像，String kind 嵌套类型）三份并存，rebase 整合重名规避 | pending | — | 2026-10-26 | PR-2/4/6/7 并行落地后同模块撞名（CoachPlanSessionRow 先例）；两套镜像的语义去重（提升 Shared、统一 kind 口径）延后另票收口 |

## 赛事域（PR-6 落地后登记，devops#769）

| ID | 检查点 | 维度 | 小程序现状 | iOS 现状 | 状态 | 确认人 | 日期 | 说明 |
| ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- |
| A-race-1 | 日历整年拉全与三防 | 功能 | per_page=100 翻页 ≤50 页；onShow 重拉真值+同键静默刷新+请求序号；星标乐观回滚 | 同口径直译（RaceCenterModel：fetchingKey/fetchSeq/rowsKey；星标 pendingStars 防连点，服务端结果为准失败回滚 toast） | aligned | — | 2026-10-26 | 空态三分（年份·省份无数据/收藏空/筛选空）+ 默认视图 upcoming 地板（收藏与往年看整年）单测覆盖 |
| A-race-2 | 报名选择器 PUT/DELETE 语义 | 功能 | 同态纯确认不发写；删除 404 幂等收尾；hotel/transit 缺省保留（键省略） | 同口径（RaceDetailModel.chooseState；RacePlanUpsertBody encodeIfPresent = 键省略，单测断言 JSON 面） | aligned | — | 2026-10-26 | 计划/策略拉取失败不阻塞详情（按钮按未报名、策略卡按未生成展示） |
| A-race-3 | 策略版本键控与草稿交接 | 功能 | target_finish_time 版本键、PUT 覆盖、DELETE ?target=、删空回未生成态；教练卡片 storage 交接草稿 | 同口径（RaceStrategyModel + AppModel.pendingStrategyDraft 消费；「用时=距离×配速」recompute 单测覆盖） | aligned | — | 2026-10-26 | 草稿应用后落自己目标版（initialTarget 指定刷新落点） |
| A-race-4 | 混排卡乐观与在飞补丁 | 功能 | 状态 chips/行程勾选乐观更新失败回滚；在飞补丁防并发读打回；自定义 PUT 全量带聚合原行 | 同口径（MyRacesModel.inflight 合并闭包：并发 GET 重放补丁；customRaceBody 全字段回传） | aligned | — | 2026-10-26 | CustomRaceBody 显式 null 编码（PUT 缺省即清空契约）单测断言 |
| A-race-5 | PB 徽章判定 | 功能 | 全马/半马各取净用时最短、同成绩记首场（新→旧遍历 `<=`） | 同口径（pbLabelIds）；显示名链四级兜底（官方→手编→活动→档位）单测覆盖 | aligned | — | 2026-10-26 | |
| D-race-1 | 成绩行长按菜单 | UI | wx.showActionSheet（未识别：输入/修改比赛名+恢复活动名；自动识别：「不是这场比赛」二次确认） | iOS contextMenu + alert 文本框（#757 决议拍板 platform-difference） | confirmed | 用户（#757 决议一） | 2026-10-26 | 保留偏差：contextMenu/alert 系统形态；清除识别本地回落（断官方关联、手输名保留）后重拉对齐 |
| D-race-2 | 配速卡海报保存交互 | UI | canvas 海报 → previewImage 长按保存 | 声明式海报 View + ImageRenderer（600×动态高、深色底+黄绿顶线规格照 #420）→ sheet 预览 + 显式「保存」（相册追加权限）/「分享」按钮 | confirmed | 用户（D-poster-1 + #757 决议一） | 2026-10-26 | 保留偏差：iOS 无长按保存惯例；NSPhotoLibraryAddUsageDescription 已随本 PR 落 Info.plist；分享=图+文案+链接整组已随 PR-8 接线 |
| D-race-3 | 配速表行内编辑落值时机 | UI | blur 落值 + dirty | SwiftUI TextField 直绑（每键落值即重算用时/置 dirty）；终态语义一致（值+自动换算+dirty） | confirmed | — | 2026-10-26 | 保留偏差：iOS 无 onBlur 表单惯例，直绑即时反馈；保存仍按 dirty 门控 |
| D-race-4 | 自定义比赛编辑回显通道 | 架构 | navigateTo eventChannel emit('race', 全字段行) | AppModel.pendingCustomRaceEdit 单次消费交接（Route 表定稿「AppModel 交接，非 query」，Route.swift:58） | confirmed | — | 2026-10-26 | eventChannel 回显延迟坑在 iOS 单进程下自然消失（#757 决议一） |
| D-race-5 | 策略分享出向 | 功能 | onShareAppMessage 带 strategy-share path（微信卡片） | ShareLink 单一路分享：已落库版本 → owner+race+version 三元组 `/s/` 分流链接；草稿 → 赛事详情链接；hero 分享与配速卡海报共用（RaceStrategyModel.shareTarget） | aligned | — | 2026-10-26 | PR-8 落地：链接统一 ShareOutbound `/s/` 构造；海报分享=图+文案+链接（A-share-2） |
| D-race-6 | 赛事中心顶栏 | UI | 自绘顶栏（返回/小房子 + 标题 + 「我的赛事」入口） | 系统 inline 导航标题 + toolbar「我的赛事」；返回走系统手势（D-nav-3 种子推演） | confirmed | — | 2026-10-26 | 保留偏差：D-nav-3 同族；「我的赛事」入口语义保留 |

## 收尾域（PR-7 落地后登记，devops#770；规格 #759 决议二 + #758 拍板 2 + #425）

| ID | 检查点 | 维度 | 小程序现状 | iOS 现状 | 状态 | 确认人 | 日期 | 说明 |
| ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- |
| P-prof-1 | 我 tab 结构 | UI | 自绘顶栏（菜单钮 toast/标题+副标题「个人中心」）→ 用户卡（头像/昵称/邮箱/「STRIDE 会员」标）→ 手动同步行 → 菜单五行（含反馈副标题+红点 99+ 截断） | 系统 inline 标题「我的」；同构用户卡/手动同步行（spinner+「上次同步 Xm ago」）/五行菜单 + 红点徽标（ProfileHomeView.swift） | aligned | — | 2026-10-26 | 顶栏差异沿 D-rec-1 同族（菜单钮小程序即 toast 占位）；红点=total_unread，失败静默保留 |
| P-prof-2 | 手动同步链路 | 架构 | POST /api/{user}/sync {mode:'incremental'}（无幂等键）→ 轮询 GET /api/pipelines/{id} 2s/60min → 成功 toast + last_sync_at 回读；onUnload 取消 | 同构（triggerIncrementalSync 无 Idempotency-Key + pollRun 2s/60min + onDisappear cancel；#425 决议逐条，单测断言 body/无幂等头） | aligned | — | 2026-10-26 | 成功/失败 toast >15 字截断同款；取消不弹 toast |
| P-pedit-1 | profile-edit 双面拆分 | 架构 | 身份 GET/PATCH /api/users/me + 头像即时传；身体 GET/POST/PATCH /api/users/me/profile（ADR 0013） | 同构：PhotosPicker 选完即传（uploadAvatar→PATCH avatar_url→AppModel.updateIdentity）；昵称失焦保存（空/未改不提交，失败回读）；身体已建立逐字段 PATCH 失败回读服务端值；未建立「完善身体数据」整表 POST（display_name 取当前昵称）（ProfileEditModel.swift） | aligned | — | 2026-10-26 | chooseAvatar→PhotosPicker 沿 D-onb-1 决议；身体失焦=FocusState 失焦+onSubmit 双触发 |
| P-pedit-2 | 注销入口 | 架构 | 无（小程序无 App Store 合规要求） | profile-edit 底部危险区「注销账号」（退出登录下方）→ 二次确认警示（不可恢复→确认注销）→ DELETE {auth}/api/users/me → 清 Keychain → Login | aligned | 用户（#759 决议 2 拍板） | 2026-10-26 | **合规增量**（超样板）：App Store 5.1.1(v) 硬要求；后端链路现成（auth 原子清理+四步审计） |
| P-fb-1 | 反馈双 tab | 架构 | 会话行（emoji 头像+标题截 20+已采纳角标+相对时间+末条预览+未读点）/onShow 重拉/路线 tab 首次挂载 hidden 保活/深链 ?tab=roadmap | 同构（FeedbackView.swift：会话行全要素、onShow 重拉、roadmapMounted opacity 保活、Route.feedback(initialTab:) 承接深链；行逻辑直译 feedbackRows.ts 单测覆盖） | aligned | — | 2026-10-26 | 已采纳角标点按切路线 tab（闭环手势）保留；右下悬浮 + 球 CTA 同位保留（原型 518 variant C） |
| P-road-1 | 投票乐观更新 | 架构 | 投票乐观+本地重排不重拉列表（#553）；失败回滚静默重拉对齐；同想法 in-flight 串行；not_votable 409 文案 | 同构（RoadmapPanelModel.swift：togglePoolVote 纯函数 + voting Set 串行 + 失败回滚 fetch 静默对齐；单测覆盖重排/夹 0/未知 id） | aligned | — | 2026-10-26 | 排序与 Go 端 backlog（票数降序、同票新想法在前）同源 |
| P-road-2 | 三区平铺形态 | UI | 最近上线时间线（绿点+日期+「由 N 位跑友投票促成」）/正在做（+预计 chip）/投票池（toggle pill ▲/✓+NEW 标）+投票规则常显，全部不折叠 | 同构三区平铺（RoadmapPanelView.swift，2026-10-20 拍板照搬） | aligned | — | 2026-10-26 | hero 聚合卡已移除（拍板既有）；product-roadmap 薄壳页保活照搬（RoadmapPages.swift） |
| P-road-3 | roadmap-detail | UI | 标题+markdown 正文（mp-html）；draft 404=「这个想法不存在或已下线」 | MarkdownText 简易渲染（declaration 同款）；404 分流同文案（RoadmapPages.swift） | aligned | — | 2026-10-26 | D-coach-1 渲染子集决议共用 |
| P-fbf-1 | 反馈表单 | 架构 | 类型分段联动占位/描述必填点亮/图片 0-9 张（>10MB 跳过 toast）previewImage/两段式上传（任一失败中止保留本地图）/client_version 静默注入 | 同构（FeedbackFormView/Model：PhotosPicker 多选+Data 载入+超限跳过 toast+全屏查看器（D-9 显式交互）；两段式逐张中止保留；client_version=ios/{version} 注入，单测断言 body） | aligned | — | 2026-10-26 | 版本号取 CFBundleShortVersionString（≤32 字符）；页面零展示同款 |
| P-fbc-1 | 反馈线程聊天 | 架构 | 进入 GET 详情（服务端读即清未读）/已采纳横幅去投票（roadmap 反查标题失败隐藏）/409 feedback_closed 前端同步禁言/草稿输入条/closed 禁言条+提交新反馈 | 同构（FeedbackChatModel：409 双判同步 closed；横幅标题 roadmap 反查 best-effort；气泡流 ScrollViewReader 滚底；图片九宫格全屏查看） | aligned | — | 2026-10-26 | 时间标签上海墙钟（今天/昨天/跨年补年份）直译单测 |
| P-watch-1 | 手表绑定 | 架构 | 品牌网格（COROS/GARMIN）→ email+password 表单（region picker 仅 Garmin cn/global）→ 绑定成功 toast+回读+ensureSync fire-and-forget+redirectTo onboarding；解绑内联确认卡；?provider= 直达 | 同构（WatchModel/View：region 仅 Garmin+MFA 提示行；绑定后 presentOnboardingAfterWatchBind（AppModel 切全屏 onboarding 续跑进度）；解绑内联卡「已同步数据不删除」） | aligned | — | 2026-10-26 | #425 决议直译；绑表后跳 onboarding 与小程序 redirectTo 同语义 |
| D-watch-1 | Garmin 登录形态 | 架构 | garth 式 SSO 直登：客户端收 email+password POST /api/users/me/watch/login（服务端 OAuth1→OAuth2；MFA fail-fast 提示） | 同 email+password 表单直连同端点（#425 实施清单口径）；**ASWebAuthenticationSession 前端 SSO 不采用**：需后端 OAuth 回调新端点，违反「端点零新增」铁律（mapping §0） | confirmed | — | 2026-10-26 | 保留偏差：#770 票面「garth SSO→ASWebAuthenticationSession」按 #425 实际契约（email+password 直登，garth 在服务端）落地；如未来开 OAuth 回调端点另立票 |
| P-wshare-1 | workout-share 落地页 | 架构 | 免登录 GET /api/workouts/shared + 沉浸课卡（hero/summary/全量分段）+ 双 CTA（保存±7 天选日+save_token 幂等/推送先存后推+绑表检查 modal→watch 回来续推）；未登录 CTA→login?redirect=本页；缺参/404 失效态、5xx 重试 | 同构（WorkoutShareView/Model：三 stat 口径与 workout-detail 一致（力量=时长/动作/总组数）；选日 sheet 8 档+计划日默认；save_token=shared-{id}；绑表检查 alert→去绑定→onAppear 续推；AppModel.requestLogin(redirect:) 回跳；流测试覆盖保存/推送/续推/未登录四链） | aligned | — | 2026-10-26 | #758 拍板 2 直译；公开落地页 loggedOut 免登录浏览已随 PR-8 落地（A-share-6） |
| P-cshare-1 | coach-share 阅读端 | 架构 | 免登录 GET /api/coach-shares/{sid}（410/404/429 分流）浅色气泡流+策略卡静态摘要降级+底部品牌条（wxacode fail-soft） | 同构（CoachShareView/Model：410 过期/404 不存在/其余可重试三空态；race-strategy/master-plan 卡头静态摘要、动作卡降级 markdown（coachShareRows 口径单测）；品牌条占位块兜底） | aligned | — | 2026-10-26 | 「再转发同 sid」已随 PR-8 落地（A-share-7） |
| P-sshare-1 | strategy-share 落地页 | 架构 | 免登录三元组 GET；只读渲染+底部 CTA「生成我的比赛策略」（已登录→detail，未登录→登录流）；缺 pace_segments 视为失效；赛名以 race_calendar 行为准 | 同构（StrategyShareView/Model：hero/配速表/补给/打包清单/赛道/天气/依据全区块；损坏 content 失效分流；CTA 双分支；toStrategyShareView 纯函数单测含目标配速换算） | aligned | — | 2026-10-26 | #506 三元组即访问边界；行构造复用 raceStrategyRows 只读子集 |
| D-net-1 | path 内嵌 query 编码缺陷 | 架构 | —（wx.request URL 原生合法） | 修复 APIClient makeURLRequest：`URL.appending(path:)` 会把 `?` 编成 `%3F`，path 拼串带 query 的调用（记录域 `?include=timeseries`、`?limit=&offset=`、自建课 `?target_date=`）此前整段被当路径 | aligned | — | 2026-10-26 | PR-7 落地时发现并修复的既有缺陷：拆 path 于 `?` 经 URLComponents 重组 query（回归靠 workout-share 推送流测试断言完整 URL） |
| P-priv-2 | privacy 入口接线 | 架构 | privacy 两行菜单（P-priv-1 已登记，入口在 profile-edit） | profile-edit「隐私与权限」行 → .privacy push（本 PR 接线完成，闭环 P-priv-1 预留位） | aligned | — | 2026-10-26 | 页面本体 PR-2 落地；本行只补入口 |

### PR-7 未迁面（显式登记）

- ASWebAuthenticationSession 前端 Garmin SSO：见 D-watch-1（端点零新增铁律下的保留偏差）。
- ~~落地页 loggedOut 根栈免登录浏览形态：归 PR-8~~ 已随 PR-8 落地（AppModel.publicLanding + RootView loggedOut 根栈，见 A-share-6）。
- 路线 tab 投票池「我的票数」聚合：hero 聚合卡已在 2026-10-20 拍板移除，两端口径一致，不单列偏差。

## 分享出向（PR-8 落地后登记，devops#771）

| ID | 检查点 | 维度 | 小程序现状 | iOS 现状 | 状态 | 确认人 | 日期 | 说明 |
| ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- |
| A-share-1 | 出向链接架构 | 架构 | path=`/pages/...`（微信内小程序页直达） | 统一 `https://stride-running.cn/s/<mp 页路径>?query`（ShareOutbound 收口，页路径/query 复用 Route 白名单表）；App 回流 `Route(url:)` 剥 `/s/` 前缀解析 | aligned | — | 2026-10-26 | #758 拍板 1 + #762 分流页（PR-9 已上线）：微信内换 URL Link 进小程序、系统环境 UL 唤起 App/落下载卡；mp-link 页面白名单六页全覆盖 |
| A-share-2 | 配速卡海报出向 | 功能 | canvas 海报 imageUrl + 卡片（title+path） | 海报 sheet「分享」=海报图+strategyShareTitle+只读落地页/详情 `/s/` 链接整组（系统分享面板，PacePosterSheet） | aligned | — | 2026-10-26 | #420/#757 海报规格；与 hero 分享同源链接（RaceStrategyModel.shareTarget） |
| A-share-3 | 教练多选出向 | 功能 | onShareAppMessage promise：标题+canvas 封面+sid path | 标题（`<昵称> 与 StrideWise 的对话 · N 条`，昵称随快照上送）+5:4 气泡封面+`/s/` coach-share 链接整组（CoachChatModel.forwardSelected） | aligned | — | 2026-10-26 | 创建失败仅 toast 不出面板（微信必须回卡片、iOS 面板未开无需兜底卡）；封面渲染 fail-soft |
| A-share-4 | 赛事三页出向 | 功能 | race-center/detail/strategy 定制标题+path（胶囊转发） | race-center/detail toolbar ShareLink：定制文案+`/s/` 链接（`StrideWise · 全年路跑赛事日历` / `<名> · <日> 开跑`）；strategy hero ShareLink（D-race-5） | aligned | — | 2026-10-26 | 胶囊转发→D-1 ShareLink（D-13）；detail 坏链 id 回落赛事中心语义天然消失（Route 强类型必带 id） |
| D-share-2 | 微信卡片形态 | UI | 分享卡片三位一体（title+imageUrl+path 由微信组装） | 系统分享面板多 item 并列（图/文案/链接），接收渠道（信息/AirDrop/微信）各自组装 | confirmed | 用户（#758 决议三 / #771 票面） | 2026-10-26 | platform-difference：无微信卡片对等物；单一路分享语义由链接承载 |
| D-share-3 | 默认品牌文案 | UI | `砺跑 · 马拉松训练助手`（utils/share.ts） | `StrideWise · 马拉松训练助手`（ShareCopy，拉丁优先品牌口径；文案不提 AI/教练，含 coach 转发标题修正） | confirmed | 用户（#771 品牌口径） | 2026-10-26 | 保留偏差：App 品牌统一 StrideWise（分流页/AASA 同口径）；coach-share 阅读端品牌条文案随本票对齐小程序「跑马拉松，用 StrideWise / 训练计划 · 比赛策略」 |
| A-share-5 | 自建课出向 | 功能 | workout-detail 分享 pill（5:4 深色 canvas 封面+课名+落地页 path）/ index 今日卡（仅自建课，无封面） | workout-detail 分享 pill=5:4 深色封面（WorkoutDarkCoverView：顶线+品牌 label+课名两行+双指标色块）+课名+`/s/` workout-share 链接整组；今日卡 icon=课名文案+`/s/` 链接（无封面，对齐 MP index 分支） | aligned | — | 2026-10-26 | PR-5 占位（WorkoutSharePlaceholder）随本票删除，链接统一 ShareOutbound |
| A-share-6 | 公开落地页免登录回流 | 架构 | PUBLIC_ENTRY_PAGES 白名单放行，未登录可浏览三落地页 | AppModel.publicLanding：冷开/回流 `/s/` 公开页未登录 → loggedOut 根栈直接渲染落地页（RootView），toolbar「登录」带 redirect 回跳；登录成功/CTA 登录清 landing 回栈内落点 | aligned | — | 2026-10-26 | 三链单测覆盖（AppModelTests：冷开/browse/requestLogin 清退）；CTA 继续走 requestLogin(redirect:) |
| A-share-7 | coach-share 再转发 | 功能 | 底部品牌条「转发」按钮（open-type=share 同 sid path） | 品牌条「转发」ShareLink：同 sid `/s/` 链接+分享标题（ShareViews.swift）；品牌条文案对齐 MP | aligned | — | 2026-10-26 | PR-7 曾登记「归 PR-8」；阅读端转发无封面（MP 也是微信默认截图卡），D-share-1 单一路 |

### PR-8 备注

- 朋友圈渠道缺失、timeline 单页模式：全局种子 D-share-1（confirmed）已覆盖，页面级不再重复登记。
- 三 canvas 产物齐且全部接线：配速卡海报（PR-6 海报+本票分享面板）、教练气泡封面（本票）、自建课深色封面（本票，PR-5 页面已合故直接接线）。
- 品牌口径（#771）：StrideWise 拉丁优先、文案不提 AI/教练——PR-4 的「与 StrideWise 教练的对话」标题已随本票修正。
- 实施期间 PR-5/PR-7 合入 master（#768/#770）：本票 rebase 其上完成自建课接线、coach-share 再转发与落地页免登录回流（原 PR-7 登记的 PR-8 归属项）。
