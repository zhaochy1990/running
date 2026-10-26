parity baseline v0 (devops#747)

# 小程序全量功能清点 · parity 基线 baseline v0

- 票：zhaochy1990/stride-devops#747（地图 #746 SwiftUI iOS App 迁移）
- 源码基线：`running/src/wechat-miniprogram/`（2026-10-25 快照）
- 用途：iOS App 每页/每域 parity check 的功能对照基线。每页条目即 checklist 项，可逐条勾选对照。
- 口径说明：`文件:行` 均相对 `src/wechat-miniprogram/`；端点所在行为 services 层定义处。

---

## 0. 全局骨架（App 级 parity 项）

### 0.1 注册与 tabBar
- [ ] app.json 注册 29 页（活跃 27 + 死页 2），主包无分包
- [ ] 自定义 tabBar（`custom-tab-bar/index.ts`）：教练 coach / 记录 activities / 训练 index / 我 profile，选中色 `#ff6363`，SVG 图标 on/off 双态
- [ ] 深色全局主题：导航/背景 `#07080A`，标题 STRIDE，白字
- [ ] 各 tab 页 onShow 调 `getTabBar().setData({selected:N})` 同步选中态

### 0.2 启动认证状态机（app.ts:49-149 + services/request.ts）
- [ ] onLaunch → checkAuth：本地有 token → 主动 `GET /api/users/me` 验证（不信本地过期时间）；网络类失败保留会话不误登出
- [ ] 无 token → 免密登录：wx.login code → `POST /oauth/token`（grant=token_exchange，RFC 8693）；已绑账号无感进入，未绑定 reLaunch 登录页
- [ ] 免登录冷开白名单 PUBLIC_ENTRY_PAGES（app.ts:10-14）：workout-share / strategy-share / coach-share 三落地页不强制登录、不拽 onboarding
- [ ] profileReady 检查（app.ts:38-47）：启动查 `GET /api/users/me/profile`，档案未齐 reLaunch onboarding（老账号补档案通道）；查询失败放行
- [ ] 会话失效兜底 handleSessionExpired（request.ts:97-138）：清 token → 先试一次微信免密恢复（每 app 生命周期至多 1 次，防死循环）→ 失败 reLaunch `login?redirect=<当前页完整 path+query>`（401 不丢上下文）
- [ ] token 刷新：401 → `POST /api/auth/refresh` → 重试一次（并发去重 refreshPromise）；SSE 通道独立实现同款 401 处理（coach.ts:158-180）
- [ ] 数据页统一模式：onLoad → `userStore.waitForAuth()` 再发数据请求（store/user.ts，防首帧 401）；未认证兜底 reLaunch 登录页

### 0.3 请求层（services/request.ts）
- [ ] Bearer JWT + `X-Client-Id: app_895073719c0147368b8feed3`；Base URL：PROD `https://api.stride-running.cn`（auth 与数据面同域分流；coach 对话 PROD 同域、DEV 独立 8889）
- [ ] 错误体归一 ApiError{statusCode, code, detail}（数据面 {detail,code} / auth {error,message}）；请求日志敏感字段脱敏
- [ ] 上传走 wx.uploadFile 两个端点（头像/反馈图）；流式走 wx.request enableChunked + onChunkReceived 1 个端点（coach chat SSE）

### 0.4 全局导航与分享惯例
- [ ] 返回惯例：`navigateBack({fail: () => switchTab('/pages/coach/coach')})`（栈深 1 分享卡冷开回主页）；深层普通页跳教练 tab 用 reLaunch（避免 switchTab 闪宿主 tab，race-center/detail.ts:353）
- [ ] 默认分享（utils/share.ts）：品牌卡「砺跑 · 马拉松训练助手」落 `/pages/index/index`；除赛事三页/workout-detail/index 今日卡/coach 多选/roadmap-detail 定制外全页引用默认
- [ ] 跨 tab 上下文交接：switchTab 不能带 query → storage 中转（coach.pendingContext / pendingStrategyDraft），目标页 onShow 消费
- [ ] 回跳白名单 sanitizeRedirect（utils/redirect.ts）：login/onboarding 的 ?redirect= 校验后才回跳

### 0.5 共享组件（components/）
- [ ] mp-html（GFM markdown → 富文本，coach/declaration/roadmap-detail/coach-share 共用）
- [ ] coach-card（教练结构化产物卡片：master-plan / custom-workout / workout-op / race-strategy 四型）
- [ ] push-date-sheet（推送/保存选日弹层，±7 天 15 选项）
- [ ] roadmap-panel（产品路线三区面板，feedback 二级 tab 与 product-roadmap 共用）
- [ ] custom-tab-bar（见 0.1）

### 0.6 平台口径
- [ ] 时区：展示/日历运算全部上海时区（utils/date）
- [ ] 坐标：轨迹渲染前 wgs84ToGcj02（utils/coord，iOS MapKit 不复用，见地图 #746 决策）
- [ ] 图表：uCharts（折线/柱状，utils/curveChart）+ canvas 2d 海报（配速卡/分享封面）

---

## 1. 引导账号域（4 页）

### 1.1 pages/login/login（登录/绑定）
- 入口：checkAuth reLaunch（未绑定/会话失效，带 ?redirect=）；workout-share 等 CTA 未登录时 navigateTo（带 redirect）
- 导航出：协议链接 → declaration（navigateTo ×2，doc_type=）；登录成功 → 有 redirect reLaunch 回目标 / 新注册（registered=true）redirectTo onboarding（透传 redirect）/ 老用户 switchTab coach（login.ts:99-112）
- UI（自上而下）：品牌头（logo/STRIDE/副标题「登录以同步训练数据并绑定微信」）→ 表单卡：tab 分段「邮箱登录｜手机号登录」（默认手机号，特性开关 PHONE_LOGIN_AVAILABLE）→ 邮箱 tab（邮箱 input + 密码 input 显隐切换 + 忘记密码 toast 暂未开放）→ 手机 tab（+86 手机号 + 验证码 + 「获取验证码」按钮 60s 倒计时）→ 行内错误区 → CTA「立即登录」→ 法务勾选行（默认不勾，审核要求）
- 端点：`POST /oauth/token`（token_exchange+email/password 或 wechat_phone_bind+phone/code）services/auth.ts:86；`POST /api/auth/sms/send`（scene=bind_phone）auth.ts:149；`GET /api/users/me`（登录后拉用户）auth.ts:101
- 交互：前端校验（EMAIL_RE / `^1\d{10}$` / 6 位验证码）；未勾协议拦截；auth 错误码→中文映射 BIND_ERROR_MESSAGES（18 个错误码，auth.ts:22-43）；验证码发送失败不启动倒计时
- 三态：loading（按钮「登录中...」禁用）；错误行内展示；无空态

### 1.2 pages/onboarding/onboarding（单页三步引导）
- 入口：login 新注册 redirectTo（?redirect=）；checkAuth 档案未齐 reLaunch；watch 绑定成功 redirectTo（看同步进度）
- 导航出：完成/跳过 → redirect reLaunch 或 switchTab coach（onboarding.ts:160-167）
- UI：step=loading → profile 资料步（button open-type=chooseAvatar 头像 / 昵称 input / 性别 picker / 生日 picker / 身高体重 input / 跑龄 picker / 保存）→ watch 绑表步（COROS/GARMIN 二选一 / 邮箱 / 密码 / 区域 picker 中国区·国际区 / 绑定·跳过）→ sync 同步步（「第 N/M 步·label」+ 百分比 + 重试 + 超时态「还在同步中」）→ ready 完成引导
- 端点：`GET /api/users/me/profile`（状态）services/profile.ts:147；`POST /api/users/me/avatar`（uploadFile）profile.ts:43；`PATCH /api/users/me`（头像 URL 回写身份）profile.ts:76；`POST /api/users/me/profile`（整表建档）profile.ts:152；`POST /api/users/me/onboarding/complete`（幂等）services/onboarding.ts:58；`POST /api/users/me/watch/login` services/watch.ts:41；`POST /api/{user}/sync`（Idempotency-Key，mode=full）services/sync.ts:23；`GET /api/pipelines/{runId}`（2s 轮询，上限 60min）sync.ts:31；`GET /api/users/{user}/pipelines`（认领别端在跑的 run）sync.ts:40
- 交互：onShow 重算落点（24 分钟 pipeline 中途被杀后天然续跑）；ensureSync 三层幂等（本地指针→认领别端 run→幂等键先落盘再触发）；complete 只依赖资料（ADR 0013）失败下次自愈
- 三态：状态读取失败 → 资料步 + formError；表单/绑表错误行内；同步失败 syncError+重试；轮询超时不判失败（放行，指针续跑）

### 1.3 pages/declaration/declaration（声明正文）
- 入口：login 协议链接、privacy 菜单行（navigateTo ?doc_type=user_agreement|privacy_policy，白名单校验）
- UI：自定义顶栏（返回/栈深 1 小房子）→ markdown 正文（mp-html 深色 tagStyle）
- 端点：`GET /api/declarations/{docType}`（auth:false 公开）services/declarations.ts:32
- 三态：loading；404「该声明尚未发布」/ 其他「加载失败」；非法 doc_type「未知的声明类型」

### 1.4 pages/privacy/privacy（隐私与权限聚合页）
- 入口：profile-edit「隐私与权限」行
- UI：顶栏 → 两行菜单（用户协议/隐私政策，icon+标题+副标题）
- 端点：无（纯静态行）
- 导航出：declaration navigateTo

---

## 2. 四 tab 域（4 页）

### 2.1 pages/coach/coach（教练 tab · 冷启动落地页）
- 入口：tabBar[0]；冷启动首页（app.json 首位）；index 今日卡「和教练聊一聊」switchTab（storage 交接 target=session/kickoff）；race-center/detail 与 strategy 的策略 CTA reLaunch（target=race + kickoff 首条消息自动发出）
- 导航出：卡片主体 tap → 目标页（策略草稿经 pendingStrategyDraft 交接 → strategy 页）
- UI（自上而下）：顶栏（汉堡→会话抽屉 / 标题 / 搜索 toast 暂未开放）→ 上下文提示条「正在围绕「xx」对话」+ 关闭 → 消息流（欢迎语；user 气泡；assistant markdown 经 mp-html + 底部常驻复制按钮；流式气泡=阶段文案「正在查询数据…/正在分析…」+ 进度说明 + 打字机正文 + 光标；结构化卡片 coach-card 替代 markdown 气泡）→ 多选转发模式（长按消息进入，顶栏「已选 N 条」，底栏 [取消|全选|转发 N]，消息行勾选框）→ 输入栏（textarea+发送，键盘 heightchange 顶起 padding）→ 会话抽屉（新建对话 / 会话列表含当前徽标 / 搜索占位）
- 端点：`POST /api/users/me/coach/chat`（SSE：status/narration/text_delta/done/error 五事件；Accept: text/event-stream；超时 11min；done 带 card 结构化信封）services/coach.ts:202；`GET /api/users/me/coach/sessions/{id}/messages`（历史恢复）coach.ts:315；`GET /api/users/me/coach/sessions`（抽屉列表，失败回退本地）coach.ts:337；`POST /api/users/me/coach/sessions/{id}/share`（多选转发快照 ≤30 条）coach.ts:393。卡片动作端点：`GET /api/users/{u}/master-plan/current`（替换三态预检）services/master-plan.ts:196、`POST /api/users/{u}/master-plan/apply`（apply_token 幂等+替换确认）master-plan.ts:234、`POST /api/users/me/custom-workouts`（save_token 幂等 upsert）services/plan.ts:118、`POST .../custom-workouts/{id}/push` plan.ts:143、`DELETE .../custom-workouts/{id}` plan.ts:88、`POST .../custom-workouts/{id}/move` plan.ts:107、`GET /api/users/me/plan/sessions`（卡片终态对账 reconcile）plan.ts:83
- 交互：发送/重试（重试复用 client_turn_id 服务端幂等）；SSE JSON 泄漏防御（呈现层换「正在整理内容…」）；多选转发：canvas 预生成 5:4 气泡封面，onShareAppMessage promise 模式（微信 3s 预算，2.8s 主动回落品牌卡），path `/pages/coach-share/coach-share?sid=`；master-plan 应用流：三态预检 + 替换确认 modal + 409/422 复查收口；custom-workout 保存→推送幂等链 + 重进会话按 save_token 对账恢复终态；workout-op 删除双确认 modal / 改期 toast 区分「手表未同步」
- 三态：历史加载失败保留欢迎语（historySyncFailed 拦截多选 + onShow 静默重拉）；流失败该 user 气泡打 failed 标记可重试；空回复（output budget 吃满）降级占位并保投影序号不漂移；抽屉列表失败回退本地存储

### 2.2 pages/activities/activities（记录 tab）
- 入口：tabBar[1]
- 导航出：活动行 → activity-detail（navigateTo ?labelId=）
- UI：顶栏（标题「活动记录」）→ 月份折叠分组（月头「2026年3月 · N 次 · X km · H:MM」点击折叠/展开，默认本月展开；行=路线缩略图（失败回退运动图标）+ 名称 + 日期周几 + 距离/时长/配速/心率/负荷（STRIDE dose 优先））→ 空态卡「暂无活动记录」→ 底部「查看更早记录」
- 端点：`GET /api/{user}/activities?limit=100&offset=`（月汇总用后端 monthly_summaries 整月统计）services/activities.ts:18
- 交互：下拉刷新（json enablePullDownRefresh）；onReachBottom 无 — 用按钮 onLoadMore 分页（PAGE_SIZE 100，offset 累计）；月份头折叠
- 三态：loading；空态；失败静默保持空态（无错误条）

### 2.3 pages/index/index（训练 tab · 今日首页）
- 入口：tabBar[2]
- 导航出：今日活动行 → activity-detail；训练卡整体 → workout-detail（有分段结构时）；手表按钮 → push-date-sheet 弹层；更多 → 删除流程；教练 CTA → switchTab coach（target 交接）
- UI（自上而下）：顶栏（菜单 toast / 标题 STRIDE + 周副标题）→ 周选择条（周日→周六 7 天 chip，可点任意日期含跨周）→ 「今日活动」卡（选中日实际活动行，同 activities 行样式）→ 「今日训练」卡（类型/来源标签 自建·手表 + 课名 + 分段强度条形图（blocks）+ 指标 距离/总时长/负荷 + 操作行：手表推送 icon / 分享 icon（仅自建课，open-type=share）/ 「和教练聊一聊」CTA / 更多（自建课=删除））→ 营养建议卡（nutrition）→ push-date-sheet 弹层
- 端点：`GET /api/{user}/plan/weeks/{weekName}`（周计划详情）services/plan.ts:44；`GET /api/users/me/plan/sessions?from=&to=`（三源统一课表行 weekly/custom/watch）plan.ts:83；`GET /api/{user}/activities?date_from=&date_to=`（当日活动）activities.ts:18；`POST /api/{user}/plan/sessions/{date}/{idx}/push?date=`（计划课推送）plan.ts:65；`POST /api/users/me/custom-workouts/{id}/push` plan.ts:143；`DELETE /api/users/me/custom-workouts/{id}` plan.ts:88
- 交互：onShow 静默刷新本周课表（教练在对话里删/改/存课后切回即时反映，devops#698）；跨周切换先空渲染再拉取（重入保护）；推送流：弹层选日 → showLoading → push → 重拉周课表 → toast；删除：ActionSheet→modal 确认→软删→重拉；自建课分享卡（onShareAppMessage data-share=today → workout-share 落地页，封面回落页面截图）
- 三态：loading；无计划/拉取失败 → 空态卡；当日无活动隐藏今日活动卡

### 2.4 pages/profile/profile（我 tab）
- 入口：tabBar[3]
- 导航出：用户卡 → profile-edit；菜单行 → training-plan / training-status / race-center / my-races / feedback（均 navigateTo）
- UI：顶栏 → 用户卡（头像/昵称/邮箱/标签 tag + chevron）→ 手动同步行（icon 转圈 syncing / 「上次同步 Xm ago」）→ 菜单列表（我的训练计划 / 训练状态 / 赛事中心 / 我的比赛 / 意见反馈[副标题「产品路线也在这里 · 每条我们都会看」+ 未读红点]）
- 端点：`GET /api/users/me/watch`（last_sync_at）services/watch.ts:28；`POST /api/{user}/sync` + `GET /api/pipelines/{id}` 轮询 services/sync.ts:23/31；`GET /api/users/me/feedbacks`（total_unread 红点）services/feedback.ts:135
- 交互：手动同步（触发→轮询→成功/失败 toast，页面卸载取消轮询）；onShow 刷新红点与上次同步时间（失败静默保留现值）
- 三态：未登录兜底「请先登录」toast；同步失败 toast（超 15 字截断）

---

## 3. 记录域（1 页）

### 3.1 pages/activity-detail/activity-detail（活动详情）
- 入口：activities / index 今日活动 / my-races 成绩行（均 navigateTo ?labelId=）；支持分享卡冷开（canBack=false 显示小房子）
- UI（自上而下）：顶栏 → 头部（运动类型 chip + 活动名 + 日期时间 + 训练类型 + 体感 emoji）→ 轨迹地图（原生 `<map>` 腾讯底图：polyline 三着色切换 无/心率/配速（活动相对绿→橙→红渐变，8 点 chunk 均值）；起终点 marker（绿▶/红■）+ 圈号徽标（RQ 风格，恢复圈不计）；pause 间隙分段；抽稀 ≤600 点；四周 10% padding 自适应视野；<20 有效点不渲染）→ 主指标网格（跑步 9 项：距离/均配/均心率/负荷/时长/最大心率/步幅/步频/爬升；力量 4 项）→ 心率区间卡（区间条%+时长+uCharts 心率走势曲线带基线带，触摸 tooltip）→ 配速区间卡（COROS 7→6 区归一化合并阈值区；走势曲线）→ 圈速表（圈号/时长/距离/配速/心率/步频；最快最慢行高亮；配速·心率环比趋势箭头；恢复圈标记）→ 力量分组表（动作/组数/时长/均心率，力量活动替代圈速表）→ 天气行（温度体感/湿度/风速）→ 运动/体感备注 → AI 点评（commentary，有则显示）
- 端点：`GET /api/{user}/activities/{labelId}?include=timeseries` services/activities.ts:30
- 交互：地图着色 segmented 切换（重建 polyline）；曲线触摸 tooltip
- 三态：loading；notFound（404 与网络失败统一「未找到」空态，无重试）；室内/无 GPS 隐藏地图；分段/曲线数据不足逐块隐藏

---

## 4. 训练域（3 页）

### 4.1 pages/workout-detail/workout-detail（课表详情）
- 入口：index 今日训练卡（navigateTo ?date&workoutId&title）；分享卡冷开
- UI：顶栏 → hero（类型 chip[间歇/节奏/变速/有氧/渐进/长距离/力量 启发式推导] + 课名 + 来源标签 自建/手表 + 日期周几）→ 指标行（跑课=距离/总时长/负荷[配速中值估时兜底]；力量=预计时长/动作数/总组数）→ 跑课分段组（blocks→steps 缩进结构）→ 力量动作行（动作/组数×次数/负重）→ 课表备注 spec.note → 教练备注（weekly 源回联周计划 session notes_md → 计划级备注，首行截断 200 字）→ 自建课分享 pill（open-type=share，仅 custom 源）
- 端点：`GET /api/users/me/plan/sessions?from=&to=`（按 workout_id 找行）services/plan.ts:83；`GET /api/{user}/plan/weeks/{week}`（教练备注回联）plan.ts:44
- 交互：自建课定制分享卡（title=课名，path=`/pages/workout-share?user=&workout=`，canvas 5:4 深色封面预生成[顶线+品牌 label+课名两行+双指标色块]，失败回落默认截图）
- 三态：loadState loading / ready / notfound / error（错误态带重试按钮）

### 4.2 pages/training-plan/training-plan（我的训练计划 · 备赛旅程）
- 入口：profile「我的训练计划」
- UI：顶栏 → 目标条（eyebrow「已启用」/ 赛名 / 距离档 5K·10K·半马·全马 / 比赛日 / 目标成绩 + 派生目标配速 / 倒计时 N 天）→ lede 行（起止日期 · 共 N 周 · 当前第 N 周 · 当前阶段重点）→ 训练周期图（周柱图，km/dose 指标切换；阶段色带 span 条；已完成/当前/未来三态柱；当前周粉红高亮「当前」；点柱出详情行[Wxx · 日期段 · 计划 vs 实际 ±配速心率]）→ 旅程时间轴（阶段块：类型色标/名称/周区间 W01-Wxx/日期段/周跑量区间/重点/节奏/关键课/监控触发条件/关键课型 chips/已完成阶段小结+心率分布/当前阶段教练备注/里程碑行[type 图标+日期+目标或实测+下一个标记+N 天后]；展开显示周行：日期段/计划 km/实际 km+均配均心/比赛周·减量周·调整周 tag）→ 本周关键课（当前周展开行：类型 icon/用途/距离或时长）→ 训练原则编号列表 → 底部 CTA「和教练调整计划」
- 端点：`GET /api/users/{user}/master-plan/current`（404→null 空态；content_version 1/2 分流）services/master-plan.ts:196
- 交互：km/dose 切换重绘；点柱详情；阶段展开/收起（默认全收起）；空态与 CTA 均 switchTab coach（生成入口）；retry
- 三态：loadState loading / ready / empty（无启用计划，CTA 去教练）/ v1（旧 markdown 计划，提示去网页）/ error

### 4.3 pages/training-status/training-status（训练状态）
- 入口：profile「训练状态」
- UI（自上而下）：顶栏 → 四指标卡（静息心率+基线 / 心率变异性+正常区间 / 阈值配速+置信度 / 阈值心率+置信度，均带最近日期·手表读数）→ 竞技状态 readiness 条（readiness_gate 色带 + 原因列表）→ 负荷统计 6 格（训练负荷/急性负荷/慢性负荷/竞技状态 form±/负荷比/状态标签）→ 趋势窗口切换（14d/30d/60d/90d segmented）→ RHR 趋势折线（带基线）→ HRV 趋势折线（带正常区间带）→ 每日训练剂量柱图 → 慢性/急性负荷双折线 → Form 竞技状态柱图（五区逐柱配色 + 图例：比赛就绪/维持/提升/过度负荷/减量过多）→ 周剂量折线 → 16 周训练热力图（月分组周×日格子五档色；点格展开当日详情：日期周几+剂量+当天活动摘要行；休息日/无记录/未确认三态）→ 脚注（当前 CTL ±阈值注记 / Calibration 日期·STRIDE 自研算法 / load latest）
- 端点（5 并行）：`GET /api/{user}/health?days=90` services/health.ts:23；`GET /api/{user}/hrv?days=90` health.ts:30；`GET /api/{user}/stride/zones` health.ts:37；`GET /api/{user}/stride/training-load?days=112` health.ts:16；`GET /api/{user}/activities`（200/页循环拉满 16 周窗口）activities.ts:18
- 交互：窗口切换重渲染（含图表重建）；6 张 uCharts 触摸 tooltip；热力图点选/再点收起
- 三态：loading；error 行；各图数据不足逐块隐藏（hasXxxChart 门控）；负荷区整体仅 hasLoad 时渲染

---

## 5. 赛事域（6 页）

### 5.1 pages/race-center/race-center（赛事中心密表）
- 入口：profile「赛事中心」；my-races 空态/「去找替代赛事」；strategy-share 底部 CTA
- 导航出：行 → detail（navigateTo ?id=）；「我的赛事」→ my-races
- UI：顶栏（返回/小房子 + 标题 + 「我的赛事」入口）→ 筛选栏（年份 picker[去年/今年/明年] / 项目类型 picker[全部/全马/半马/10K] / 省份 picker[全部+34 省] / 收藏 ☆ 开关）→ 月份分组密表（月头；行=日期/赛事名（中文优先）/城市/田协认证徽章/世田联标牌徽章/项目类型缩写/星标）→ 空态文案（三分：收藏空 / 筛选空 / 年份·省份无数据）
- 端点：`GET /api/race-calendar?year=&scope=all&province=&page=&per_page=100`（整年翻页拉全，≤50 页防死循环）services/race-center.ts:61；`POST /api/users/me/race-favorites/{raceId}/toggle` race-center.ts:66
- 交互：下拉刷新；onShow 每次重拉真值（不跨页缓存，收藏跨页同步前提）；同键静默刷新（旧列表先行不闪屏）+ 请求序号防过期响应；年份/省份切换=服务端过滤；类型/收藏=客户端过滤即点即生效；星标乐观更新失败回滚+toast
- 三态：首拉 loading；首拉失败错误条+清空；静默刷新失败保留旧列表
- 分享：定制卡「砺跑 · 全年路跑赛事日历」落本页（朋友圈无 path）

### 5.2 pages/race-center/detail（赛事详情）
- 入口：race-center 行；my-races 官方卡名；strategy-share CTA；分享卡冷开（query id）
- UI（自上而下）：顶栏 → 头区（名称+星标 / 田协·世田联双徽章）→ 三宫格（天后开赛 / 比赛日 / 报名制式）→ 报名时间轴（报名起止/抽签/出签日/缴费截止，完成态按今天计算）→ 报名按钮（「未报名」或「全马 · 想报名」等 → 底部 sheet 报名选择器：项目 chips + 状态单选 [想报名/已报名(等抽签)/已中签/未中签/确认参赛/未报名=删]）→ tab 行：概要（项目表：距离/起终点/赛道文字/关门时间/报名渠道[web=复制链接 / qrcode=标注形态 / 无 url=照常展示]/领物窗口）· 项目 · 出行 → 赛道 tab（赛道文字+难点站点卡展开/收起，无内容时 tab 缺席并从概要回退）→ 比赛策略卡（仅 strategy_available 赛事显示；未生成=CTA 文案+箭头；已生成=摘要[目标+版本数+更新日期]点击进报告页）
- 端点：`GET /api/race-calendar/{raceId}`（404=不存在或已下架）services/race-center.ts:165；`GET /api/users/me/race-plans`（整表找本场计划；无单场查询端点）services/race-plans.ts:65；`PUT /api/users/me/race-plans/{raceId}`（项目+状态成对提交，hotel/transit 缺省保留）race-plans.ts:73；`DELETE /api/users/me/race-plans/{raceId}` race-plans.ts:81；`POST /api/users/me/race-favorites/{id}/toggle`；`GET /api/users/me/race-strategies/{raceId}`（策略摘要，失败按未生成展示）services/race-strategy.ts:71
- 交互：下拉刷新；onShow 自愈（登录回来/分享进入补拉）；星标乐观+作废在途刷新；选择器点状态即提交（同态纯确认不发写；删除 404 幂等收尾）；复制链接（成功不 toast，系统自带）；策略未生成 CTA → setPendingCoachContext(kind=race + kickoff「我想和你聊聊…」) + reLaunch coach；已生成 → navigateTo strategy
- 三态：loading；error（未登录/404/5xx 分文案，整页错误条）；计划拉取失败不阻塞详情（按钮按未报名显示）
- 分享：定制卡「{赛名} · {日期} 开跑」query id；坏链（id=0）回落赛事中心

### 5.3 pages/race-center/strategy/strategy（比赛策略报告页）
- 入口：detail 策略卡（已生成）；coach 聊天 race-strategy 卡片 tap（草稿模式，pendingStrategyDraft storage 交接）；?target= 指定初始版本
- UI：顶栏 → hero（赛名/项目/比赛日/目标成绩大字 + 主 CTA「和教练调整」+ 次「分享」「配速卡」）→ 版本 pills（按目标成绩多版本，目标最快在前；当前选中高亮）→ 策略摘要 summary → 五列配速表（分段/本段配速/本段用时/累计用时/说明；配速·说明可编辑，用时=距离×配速自动重算）→ 补给计划行（时间点+内容，可增删改）→ 补给打包清单（品类/数量/用法提示，只读）→ 赛道提示列表 → 天气提示列表 → 制定依据 note → 底部动作（已保存：保存[dirty 时可用]/删除；草稿：应用并保存）
- 端点：`GET /api/race-calendar/{raceId}`；`GET /api/users/me/race-strategies/{raceId}`（全版本）services/race-strategy.ts:71；`PUT /api/users/me/race-strategies/{raceId}`（保存/应用，按 target 键控覆盖）race-strategy.ts:153；`DELETE /api/users/me/race-strategies/{raceId}?target=`（删指定目标版本）race-strategy.ts:161
- 交互：版本切换（dirty 先 modal 确认丢弃）；行内编辑 blur 落值+dirty；补给增删；保存后同步版本时间戳；删除 modal 确认（删空回未生成态文案）；配速卡 canvas 海报（600×动态高，黄绿顶线+目标+分段表）→ previewImage 长按保存；「和教练调整」→ pendingCoachContext(race + kickoff 带现有目标) + reLaunch coach
- 分享：已落库版本 → `/pages/race-center/strategy-share/strategy-share?user=&id=&version=`（owner+race+version 三元组只读页，#506）；草稿/无版本 → 落 detail 页；朋友圈 query id 落回本页
- 三态：loading；error（空列表「策略尚未生成：回到赛事详情，和教练聊一聊」/5xx 通用）；dirty 脏标记；saving/applying/deleting 防双击

### 5.4 pages/my-races/my-races（我的比赛 · 双 tab）
- 入口：profile「我的比赛」；race-center「我的赛事」入口
- 导航出：官方卡名 → race-center/detail；成绩行 → activity-detail；＋/编辑 → custom-race-form（编辑经 eventChannel 传全字段行）；空态「去赛事中心逛逛」（上页是列表页则 navigateBack）
- UI：顶栏（返回 + 标题 + 「＋」）→ tab 行（我的赛事 plans 默认 / 我的成绩 results）→ plans：混排卡列表（官方计划卡=项目徽章+状态徽章+赛名可点+日期·城市+开赛倒计时+状态 chips 流转+行程勾选 🏨酒店/🚄火车票·机票；赛事下架 offboarded 灰卡不可交互；自定义卡=「自定义」粉徽章+类型徽章+名称不可点+想跑↔已报名 chips+···菜单[编辑/删除]；已结束（比赛日过）灰化沉底）→ 空态（未结束在前升序，已结束沉底）→ results：汇总行（共 N 场·全马 N·半马 N）+ 成绩行（档位徽章/显示名链 官方→手编→活动→档位兜底/日期/距离/净用时/配速/均心率/爬升/同档最快金杯 PB 徽章/田协·世田联徽章）
- 端点：`GET /api/users/me/my-races`（官方+自定义聚合）services/custom-races.ts:80；`GET /api/{user}/races`（成绩）services/races.ts:50；`PUT /api/users/me/race-plans/{raceId}`（状态流转/行程勾选，显式传值覆盖）services/race-plans.ts:73；`PUT /api/users/me/custom-races/{id}`（全量更新须带聚合全字段）custom-races.ts:88；`DELETE /api/users/me/custom-races/{id}` custom-races.ts:93；`PATCH /api/{user}/races/{labelId}`（手输名，空串=清除）races.ts:55；`DELETE /api/{user}/races/{labelId}/calendar-match`（清除日历识别）races.ts:63
- 交互：下拉刷新（刷新当前 tab）；onShow 双 tab 重拉；状态 chips/行程勾选乐观更新+失败回滚（在飞补丁防并发读打回）；长按成绩行 ActionSheet（未识别行：输入/修改比赛名字[editable modal]·恢复活动名；自动识别行：「这不是这场比赛」modal 二次确认后清除识别且回落活动名）；删除自定义 modal「记录不可恢复」；tab 切换回顶
- 三态：双 tab 独立 loading/error（带请求序号防过期）；各自空态 CTA

### 5.5 pages/custom-race-form/custom-race-form（自定义比赛表单）
- 入口：my-races「＋」（新建）/ 卡「···→编辑」（navigateTo eventChannel emit('race', 全字段行) 回显）
- UI：名称 input（必填）→ 日期 picker（必填；无上下限，过去=补录）→ 类型 chips 七值（默认越野跑 Trail；选越野/超长越野高亮建议填爬升）→ 距离 km input（可选）→ 爬升 m input（可选）→ 城市 input → 官网 input → 备注 textarea → 状态 chips（想跑/已报名）→ 保存按钮
- 端点：`POST /api/users/me/custom-races` services/custom-races.ts:84；`PUT /api/users/me/custom-races/{id}`（全量，缺省可选项被清空→显式传 null/空串）custom-races.ts:88
- 交互：前端校验（名称/日期必填；距离正数 ≤99999.9；爬升非负整数）；保存成功 navigateBack（列表 onShow 聚合刷新）；编辑态改导航栏标题
- 三态：saving 防双击；错误 toast（服务端 detail 透传）

### 5.6 pages/race-center/strategy-share/strategy-share（策略只读落地页 · 分享域）
- 入口（只列）：strategy 页已落库版本分享卡 path `?user=&id=&version=`（免登录公开端点 `GET /api/race-strategies/shared/{user}/{race}/{version}` services/race-strategy.ts:93）；冷开免强制登录（PUBLIC_ENTRY_PAGES）
- 展开决策归「分享、海报与深链」票：纯只读渲染分享者那一版 + 底部 CTA「生成我的比赛策略」（已登录→detail，未登录→登录流）；缺参/版本已删→「该分享已失效」

---

## 6. 分享落地域（2 页 · 仅列入口，不展开）

### 6.1 pages/workout-share/workout-share（训练课表分享落地页）
- 入口：workout-detail / index 今日卡 自建课分享卡 path `?user=<A_uuid>&workout=<id>`（免登录公开端点 `GET /api/workouts/shared/{user}/{workout}` services/plan.ts:167）；冷开免强制登录（app.ts 白名单 #702）
- 形态决策归「分享、海报与深链」票：V1 沉浸课卡 + 双 CTA（保存到我的课表[±7 天选日+save_token 幂等] / 推送手表[先存后推+绑表检查 modal→watch 页回来自动续推]）；未登录 CTA → login?redirect=本页；缺参/404→「该分享已失效」，5xx 可重试

### 6.2 pages/coach-share/coach-share（教练对话分享阅读端）
- 入口：coach 页多选转发分享卡 path `?sid=`（免登录公开端点 `GET /api/coach-shares/{sid}` services/coach.ts:367，30 天过期 410/404 分流空态）；支持小程序码 scene 直达；冷开免强制登录
- 形态决策归「分享、海报与深链」票：浅色气泡对话流只读 + 策略卡静态摘要降级 + 底部品牌条（wxacode 码图 fail-soft + 再转发同 sid path）

---

## 7. 反馈路线域（5 页）

### 7.1 pages/feedback/feedback（意见反馈 · 双 tab）
- 入口：profile「意见反馈」；深链 `?tab=roadmap` 直达路线 tab
- 导航出：会话行 → feedback-chat（?id=）；悬浮 + → feedback-form；「已采纳」角标 → 切路线 tab；路线行 → roadmap-detail
- UI：顶栏 → tab 行（意见反馈默认 / 产品路线）→ 反馈 tab：会话行列表（类型 emoji 头像 + 标题[内容截断] + 已采纳角标 + 相对时间 / 末条预览「官方：/我：」 + 未读红点）→ 隐私脚注 → 右下悬浮 + 球 CTA；路线 tab：roadmap-panel（三区平铺不折叠：最近上线时间线[绿点+日期+标题+概述+「由 N 位跑友投票促成」票数快照] / 正在做[+预计上线 chip] / 投票池[票数降序+toggle 投票 pill ▲/✓+NEW 标] + 投票规则常显；首切挂载 hidden 切换状态不丢）
- 端点：`GET /api/users/me/feedbacks`（含 total_unread）services/feedback.ts:135；roadmap-panel：`GET /api/roadmap` services/roadmap.ts:96、`POST /api/roadmap/features/{id}/vote` roadmap.ts:106、`DELETE /api/roadmap/features/{id}/vote` roadmap.ts:111
- 交互：onShow 重拉（聊天页读即清后红点自然消失）；投票乐观更新+本地重排不重拉列表（#553）；失败回滚+静默重拉对齐服务端；同想法连点 in-flight 串行化；tab 切换回顶
- 三态：loading（无数据时）/loadError+重试；空列表直接空版式

### 7.2 pages/feedback-form/feedback-form（提交反馈表单）
- 入口：feedback 悬浮 +；feedback-chat「提交新反馈」
- UI：类型分段（🐞 Bug 反馈 / 💡 产品建议，联动 textarea 占位文案）→ 描述 textarea（必填才点亮提交）→ 图片四列格（wx.chooseMedia 相册/拍摄 0-9 张，单张 >10MB 跳过+toast；点缩略图 previewImage；删除角标）→ 提交按钮
- 端点：`POST /api/users/me/feedback-images`（wx.uploadFile multipart `file`，逐张换 cos_key）services/feedback.ts:90；`POST /api/users/me/feedbacks`（≤9 图 cos_key；client_version=`wxmp/{version}` 静默注入页面零展示）feedback.ts:124
- 交互：两段式提交（任一张上传失败即中止，保留本地图可重试）；成功 toast「已提交 · 我们会尽快回复」→ 600ms 后 navigateBack
- 三态：submitting 禁双击；错误 toast（>15 字截断）

### 7.3 pages/feedback-chat/feedback-chat（反馈线程聊天）
- 入口：feedback 会话行（?id=）
- 导航出：已采纳横幅「去投票 ›」→ product-roadmap；禁言条「提交新反馈」→ feedback-form
- UI：顶栏 → chat-head（类型 tag + 状态 tag[待处理/已回复/已关闭] + 已采纳 tag）→ 已采纳横幅（🏆 + 关联路线标题 + 去投票）→ 首卡（原文 + 图片九宫格 previewImage + 时间）→ 气泡流（官方左「STRIDE 团队」白底 / 本人右，多轮，相对时间）→ 常驻输入条（草稿非空点亮发送）；closed 禁言条替代输入（「该反馈已关闭，如有问题请提交新反馈」）
- 端点：`GET /api/users/me/feedbacks/{id}`（服务端读即清官方回复未读——红点清零的服务端真相）services/feedback.ts:140；`POST /api/users/me/feedbacks/{id}/replies`（closed → 409 feedback_closed）feedback.ts:145；`GET /api/roadmap`（adopted_feature_id 反查标题，失败不阻塞仅隐藏）
- 交互：发送追问（成功追加气泡+滚底 scroll-into-view；409 feedback_closed → 前端同步置禁言态）；图片点击 previewImage
- 三态：loading/loadError+重试；closed 禁言；无回复时空气泡流

### 7.4 pages/product-roadmap/product-roadmap（产品路线 · 深链薄壳）
- 入口：feedback-chat「去投票」；旧路径/分享深链保活
- UI：顶栏 + roadmap-panel 容器（与 feedback 二级 tab 同一组件，attached/onShow 各自拉取）
- 端点：同 roadmap-panel（GET /api/roadmap + vote/unvote）
- 说明：2026-10-18 拍板产品路线并入反馈页二级 tab 后，本页仅为路径兼容薄壳

### 7.5 pages/roadmap-detail/roadmap-detail（路线想法详情）
- 入口：roadmap-panel 三区行点击（?id=）；分享卡冷开
- UI：顶栏 → 标题 → markdown 描述正文（mp-html 深色，列表行只显示 ≤50 字概述、正文仅此处渲染）
- 端点：`GET /api/roadmap/features/{id}`（draft 404）services/roadmap.ts:101
- 分享：定制卡「【产品路线】{标题}」path 本页 ?id=
- 三态：loading；404「这个想法不存在或已下线」/「加载失败，请稍后重试」

---

## 8. 手表域（1 页）

### 8.1 pages/watch/watch（手表管理）
- 入口：profile-edit「手表绑定」行；onboarding 绑表步（绑定成功后本页 redirectTo onboarding 看同步进度）；workout-share 推送前未绑 modal「去绑定」；支持 `?provider=coros|garmin` 直达品牌表单
- UI：顶栏 → 已绑态（品牌名/账号邮箱/设备/上次同步时间/能力标签列表 + 成功横幅 + 解绑按钮 → 自绘确认弹层[确认/取消]）→ 未绑态：品牌网格（COROS / GARMIN 卡）→ 品牌登录表单（邮箱/密码/区域 picker[中国区/国际区]/绑定按钮/返回品牌）
- 端点：`GET /api/users/me/watch` services/watch.ts:28；`POST /api/users/me/watch/login`（provider/email/password/region）watch.ts:41；`DELETE /api/users/me/watch`（解绑，已同步数据保留）watch.ts:46；绑定成功后 fire-and-forget `ensureSync`（POST sync 链）
- 交互：绑定成功 → toast + fetchWatch 回读 + 不等待地触发同步 + redirectTo onboarding（进度交给 onboarding 页续跑）；解绑确认；onShow 回读状态
- 三态：loading；「加载手表信息失败」；登录失败友好文案（Go error 字段透传）

---

## 9. 个人域（1 页）

### 9.1 pages/profile-edit/profile-edit（个人资料设置）
- 入口：profile 用户卡
- 导航出：手表绑定行 → watch；隐私与权限行 → privacy；退出登录 → reLaunch login
- UI：顶栏 → 身份段（button open-type=chooseAvatar 头像（选完即传）/ 昵称 input type=nickname 失焦自动保存 / 邮箱只读）→ 身体段（性别 picker / 生日 picker / 身高 cm input 失焦保存 / 体重 kg input 失焦保存 / 跑龄档 picker；profile 未建立时显示「完善身体数据」入口展开整表+保存按钮）→ 手表绑定行 → 隐私与权限行 → 退出登录（modal 确认）
- 端点（ADR 0013 双面拆分）：身份 `GET/PATCH /api/users/me`（auth-service）services/profile.ts:81/76；`POST /api/users/me/avatar`（wx.uploadFile；微信头像 CDN URL 先 downloadFile 转本地再传）profile.ts:43；身体 `GET /api/users/me/profile` profile.ts:147、`POST`（未建立整表）profile.ts:152、`PATCH`（已建立逐字段）profile.ts:157
- 交互：头像/昵称即时保存（auth-service）；身体字段失焦逐字段 PATCH（失败回读服务端值防「界面停在未保存态」）；未建立 profile 整表 POST（display_name 取当前昵称）
- 三态：loading；错误 toast（detail/code 友好化）；saving 防并发

---

## 10. 死页（2 页 · 确认零引用，不迁移）

- **pages/plan/plan**：app.json:9 注册外全仓零导航引用（grep 验证：无 navigateTo/switchTab/reLaunch/redirectTo 指向，无分享 path）。功能（周计划渲染 + 计划课推送）已被 index（今日卡）与 workout-detail 取代。含 `GET /api/{user}/plan/weeks/{weekName}` 与 push 弹层逻辑。
- **pages/health/health**：app.json:12 注册外零引用。功能（健康趋势四图）已被 training-status 取代。含 health/hrv/zones/training-load 端点调用。
- parity 处置：iOS 侧不实现这两页；其端点在活跃页仍被消费（plan/health 服务文件是共享的），死的是页面不是服务。

---

## 11. 推送/订阅消息使用面（供地图 Not yet specified 决策）

**结论：小程序端推送/订阅消息使用面 = 零。**

- 全仓 grep `wx.requestSubscribeMessage` / subscribeMessage / 模板消息 / uniform message：**0 处**（pages/services/utils/components/app.ts 全覆盖）。
- 代码中所有「推送」字样均指「课表推送到手表」（COROS/Garmin watch push 端点），非消息推送。
- 官方反馈回复的用户触达链路是**纯 pull 模型**：「我」tab 红点（GET /feedbacks 的 total_unread，profile.ts onShow 刷新）→ 反馈列表未读点 → 聊天页打开时服务端读即清。无任何服务端主动触达。
- 教练回复、同步完成、比赛日提醒等均无任何小程序侧通知机制。
- 对 iOS 1.0 的含义：**APNs 不做也不构成 parity 缺口**（小程序本来就没有推送）；若做 APNs 属纯增量功能，需另立产品决策（后端改造量另计）。

---

## 12. 后端端点总表（64 个）

### 12.1 auth-service（AUTH_BASE_URL，6 个）
| 方法 | 路径 | 用途 | 定义 |
|---|---|---|---|
| POST | /oauth/token | 微信免密/绑定/手机验证码登录（token_exchange、wechat_phone_bind grants） | services/auth.ts:86 |
| POST | /api/auth/sms/send | 发送 bind_phone 验证码 | services/auth.ts:149 |
| POST | /api/auth/refresh | 刷新 token | services/request.ts:178 |
| GET | /api/users/me | 当前用户（会话验证/登录后拉取） | services/auth.ts:101 |
| PATCH | /api/users/me | 更新身份昵称/头像 URL | services/profile.ts:76 |
| POST | /api/users/me/avatar | 头像上传（wx.uploadFile multipart → COS） | services/profile.ts:43 |

### 12.2 stride-api 数据面（API_BASE_URL，54 个）
| 方法 | 路径 | 用途 | 定义 |
|---|---|---|---|
| GET | /api/{user}/activities | 活动列表（limit/offset/date_from/date_to，monthly_summaries） | services/activities.ts:18 |
| GET | /api/{user}/activities/{labelId} | 活动详情（?include=timeseries） | services/activities.ts:30 |
| GET | /api/{user}/races | 已确认比赛成绩列表 | services/races.ts:50 |
| PATCH | /api/{user}/races/{labelId} | 手输名（空串=清除） | services/races.ts:55 |
| DELETE | /api/{user}/races/{labelId}/calendar-match | 清除日历识别 | services/races.ts:63 |
| GET | /api/{user}/plan/weeks/{weekName} | 周计划详情 | services/plan.ts:44 |
| POST | /api/{user}/plan/sessions/{date}/{idx}/push | 计划课推送到手表 | services/plan.ts:65 |
| GET | /api/users/me/plan/sessions | 统一课表行（三源，from/to） | services/plan.ts:83 |
| POST | /api/users/me/custom-workouts | 自建课 upsert（save_token 幂等） | services/plan.ts:118 |
| POST | /api/users/me/custom-workouts/{id}/push | 自建课推送手表 | services/plan.ts:143 |
| POST | /api/users/me/custom-workouts/{id}/move | 自建课改期（best-effort 重推） | services/plan.ts:107 |
| DELETE | /api/users/me/custom-workouts/{id} | 软删自建课 | services/plan.ts:88 |
| GET | /api/workouts/shared/{user}/{workout} | 分享课公开读（免登录） | services/plan.ts:167 |
| GET | /api/users/me/profile | 数据面档案 + onboarding 状态 | services/profile.ts:147 |
| POST | /api/users/me/profile | 整表建档 | services/profile.ts:152 |
| PATCH | /api/users/me/profile | 逐字段更新 | services/profile.ts:157 |
| POST | /api/users/me/onboarding/complete | 标记 onboarding 完成（幂等） | services/onboarding.ts:58 |
| POST | /api/{user}/sync | 触发同步 pipeline（Idempotency-Key） | services/sync.ts:23 |
| GET | /api/pipelines/{runId} | run 状态（轮询） | services/sync.ts:31 |
| GET | /api/users/{user}/pipelines | 用户 run 列表（认领续跑） | services/sync.ts:40 |
| GET | /api/users/me/watch | 手表状态 | services/watch.ts:28 |
| POST | /api/users/me/watch/login | 绑定手表 | services/watch.ts:41 |
| DELETE | /api/users/me/watch | 解绑手表 | services/watch.ts:46 |
| GET | /api/race-calendar | 赛事日历（year/scope/province/分页） | services/race-center.ts:61 |
| GET | /api/race-calendar/{raceId} | 赛事详情 | services/race-center.ts:165 |
| POST | /api/users/me/race-favorites/{id}/toggle | 收藏切换 | services/race-center.ts:66 |
| GET | /api/users/me/race-plans | 参赛计划列表 | services/race-plans.ts:65 |
| PUT | /api/users/me/race-plans/{raceId} | 计划 upsert（项目+状态+行程） | services/race-plans.ts:73 |
| DELETE | /api/users/me/race-plans/{raceId} | 取消追踪 | services/race-plans.ts:81 |
| GET | /api/users/me/race-strategies/{raceId} | 策略全版本 | services/race-strategy.ts:71 |
| PUT | /api/users/me/race-strategies/{raceId} | 保存/应用（按目标键控） | services/race-strategy.ts:153 |
| DELETE | /api/users/me/race-strategies/{raceId}?target= | 删除目标版本 | services/race-strategy.ts:161 |
| GET | /api/race-strategies/shared/{user}/{race}/{version} | 策略分享公开读（免登录） | services/race-strategy.ts:93 |
| GET | /api/users/me/my-races | 我的赛事聚合（官方+自定义） | services/custom-races.ts:80 |
| POST | /api/users/me/custom-races | 创建自定义比赛 | services/custom-races.ts:84 |
| PUT | /api/users/me/custom-races/{id} | 全量更新 | services/custom-races.ts:88 |
| DELETE | /api/users/me/custom-races/{id} | 物理删除 | services/custom-races.ts:93 |
| GET | /api/roadmap | 路线三区（一次拉全） | services/roadmap.ts:96 |
| GET | /api/roadmap/features/{id} | 想法详情（markdown） | services/roadmap.ts:101 |
| POST | /api/roadmap/features/{id}/vote | 投票（幂等） | services/roadmap.ts:106 |
| DELETE | /api/roadmap/features/{id}/vote | 撤销投票（幂等） | services/roadmap.ts:111 |
| POST | /api/users/me/feedback-images | 反馈图上传（wx.uploadFile，≤10MB/张） | services/feedback.ts:90 |
| POST | /api/users/me/feedbacks | 提交反馈（≤9 图 cos_key + client_version） | services/feedback.ts:124 |
| GET | /api/users/me/feedbacks | 反馈会话列表（total_unread） | services/feedback.ts:135 |
| GET | /api/users/me/feedbacks/{id} | 线程详情（读即清未读） | services/feedback.ts:140 |
| POST | /api/users/me/feedbacks/{id}/replies | 追问（closed 409） | services/feedback.ts:145 |
| GET | /api/declarations/{docType} | 合规声明（公开免登录） | services/declarations.ts:32 |
| GET | /api/{user}/health?days | 健康记录+HRV 快照+RHR 基线 | services/health.ts:23 |
| GET | /api/{user}/hrv?days | 逐日 HRV | services/health.ts:30 |
| GET | /api/{user}/stride/zones | 阈值+配速/心率区间 | services/health.ts:37 |
| GET | /api/{user}/stride/training-load?days | STRIDE 训练负荷序列 | services/health.ts:16 |
| GET | /api/users/{user}/master-plan/current | 当前赛季计划（404→null） | services/master-plan.ts:196 |
| POST | /api/users/{user}/master-plan/apply | 应用计划（apply_token 幂等+替换确认） | services/master-plan.ts:234 |
| GET | /api/coach-shares/{sid} | 教练对话分享快照（公开免登录，30 天过期） | services/coach.ts:367 |

### 12.3 coach_agent_api（COACH_BASE_URL，4 个）
| 方法 | 路径 | 用途 | 定义 |
|---|---|---|---|
| POST | /api/users/me/coach/chat | 对话一轮（SSE 流式；target 挂 session/week/race 上下文） | services/coach.ts:202 |
| GET | /api/users/me/coach/sessions/{id}/messages | 会话历史（含 card 信封恢复） | services/coach.ts:315 |
| GET | /api/users/me/coach/sessions | 会话列表 | services/coach.ts:337 |
| POST | /api/users/me/coach/sessions/{id}/share | 创建分享快照（indices ≤30） | services/coach.ts:393 |

### 12.4 统计与特殊通道
- 总计 64：GET 30 / POST 21 / PUT 3 / PATCH 3 / DELETE 7
- 免登录公开端点 4：workouts/shared、race-strategies/shared、coach-shares/{sid}、declarations/{docType}
- SSE 流式 1：coach chat（enableChunked + onChunkReceived + utils/sse 解析器；事件 status/narration/text_delta/done/error）
- 文件上传 2：avatar（auth-service→COS）、feedback-images（cos_key 两段式）
- 轮询 1：pipelines/{runId}（2s 间隔，60min 上限，可取消）
- 跨页 storage 交接 3：coach.pendingContext / pendingStrategyDraft / custom-race-form eventChannel

---

## 13. parity 对照使用说明

1. iOS 实现每页时，对照本文对应小节逐项勾选：入口/导航、UI 块、端点、交互、三态五列。
2. 任何有意偏差（平台差异/产品决策）记入 `ios-app/docs/parity/LEDGER.md`，不静默漏项。
3. 端点消费以 §12 总表为准（iOS 复用现有 Go/TS 契约，地图 #746 Out of scope 约定不加新端点）。
4. 死页（§10）与推送面（§11）是两条已定事实，不需要 iOS 侧找对应实现。
