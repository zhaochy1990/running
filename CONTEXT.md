# STRIDE 训练教练

STRIDE 围绕运动员的赛季目标、周训练执行与日常训练判断，提供可审阅、可确认的教练建议。

## Language

**日常 Coach 问答**：
运动员向 Coach 提问、请求解释或复盘的对话；它可以引用计划，但不会直接改变计划。
_Avoid_: 计划调整、计划审阅

**赛季训练计划**：
围绕目标比赛组织阶段、里程碑和长期训练结构的已启用计划。同一份计划存在两个内容版本——**v1（markdown 文档版）**是早期形态，仅老用户仍在用；**v2（结构化版）**是当前形态——是同一产物的不同表示，随迁移收敛到 v2。
_Avoid_: Master Plan、赛季总纲、训练总纲、草稿

**赛季训练计划修订号（revision）**：
结构化赛季训练计划每次内容变更后递增的并发控制标识；Markdown 文档版没有修订号。
_Avoid_: version、内容版本（后者表示 Markdown 或结构化格式）

**本周课表**：
某一自然周内可执行的跑步、力量、恢复和营养安排。
_Avoid_: Weekly Plan、周计划草稿

**周名称（week_name）**：
上海自然周的规范化可读标识，格式为 `YYYY-MM-DD_MM-DD`，表示上海时区下从周一到周日的自然周；跨年周仍只在起始日期包含年份，例如 `2026-12-28_01-03`。它可以标识课表、运动记录或周反馈所在的周；阶段、周期或周序号不属于周名称，不允许附加 `(P1W3)` 等后缀。
_Avoid_: folder、week_folder、周文件夹、带阶段后缀的周标识

**周反馈（Weekly Feedback）**：
运动员针对一个上海自然周记录的整周反馈；每名运动员每个自然周至多一条，空白正文表示没有周反馈，但反馈记录仍使该自然周存在。它属于自然周而非该周某个本周课表版本，因此本周课表被替换、归档或缺失时仍保持独立。
_Avoid_: 单次活动反馈、feedback.md、绑定到 plan_id 的反馈

**本周课表调整窗口**：
以上海自然周为边界，只有当前周和未来周的本周课表可以调整；自然周已经结束的本周课表是只读历史记录，无论其内容是 Markdown 还是结构化格式都不再允许调整。
_Avoid_: 修改历史课表、补改过去计划

**本周课表状态**：
本周课表可处于 `draft`、`active` 或 `archived` 状态。`draft` 表示内容完整、已经持久化但尚未启用的候选课表；`active` 表示该自然周当前生效的课表；`archived` 表示同一自然周的旧 active 在新 draft 启用后留下的历史快照。赛季训练计划归档不会改变其下任何本周课表的状态。
_Avoid_: 用 draft 表示不完整内容、同周多个 active

**调整方案**：
Coach 针对赛季训练计划或本周课表提出、但尚未生效的一组完整变更。
_Avoid_: 已调整计划、草稿

**计划审阅工作区**：
运动员查看当前计划、审阅一个调整方案并决定是否启用的工作区；计划内容是主任务，Coach 对话用于解释和反馈。
_Avoid_: 日常 Coach 问答、聊天页

**启用计划**：
运动员确认整份调整方案，使调整后的计划成为新的当前计划。
_Avoid_: 应用变更、采纳部分调整、完成

**赛季影响**：
本周课表调整与当前赛季训练计划阶段目标之间的偏离程度。

**实质赛季影响**：
本周调整会移除或替换阶段关键课、使周量明显低于目标下限，或令阶段关键目标无法达成的赛季影响；启用前必须由运动员明确确认。
_Avoid_: 普通提醒、轻微偏差

**对话回执**：
计划启用、放弃或被新方案替代后写入 Coach 对话的可信结果记录。
_Avoid_: Coach 回复、用户消息

### 异步任务系统（Async Job Worker）

（Go 重写的后台任务基础设施所用词汇；实现设计见 `docs/adr/0001`–`0003`。）

**Async Job（异步任务）**：
一个可独立执行、可重试的后台工作单元；由 `job_type` 绑定到一个 handler，状态持久化在 MySQL。
_Avoid_: task、message、消息

**Job Handler（任务处理器）**：
绑定到某个 `job_type` 的执行函数；在至少一次投递语义下必须幂等。
_Avoid_: worker、processor

**Pipeline（任务流水线）**：
一个具名的、线性的 job 步骤序列（如 onboarding：full_sync → onboarding_compute）。
_Avoid_: workflow、DAG、job chain

**Pipeline Run（流水线运行）**：
某个 pipeline 针对某个 partition 的一次执行实例。
_Avoid_: pipeline instance、execution

**Partition Key（分区键）**：
job 与 pipeline run 的归属作用域；通常是 user_id，跨用户的全局任务用 `Global`。
_Avoid_: tenant、scope、user id（后者只是其取值之一）

**Poison（毒信任务）**：
重试次数耗尽后被投入死信队列并置为终态 `failed` 的 job。
_Avoid_: dead-letter（沿用作队列名 DLQ，但任务语义统一叫 poison）

### 用户 Onboarding

（Go 侧新用户建档流程；实现设计见 `docs/adr/0011`（watch_sync）、`0012`（cmd/api）、`0015`（compute port）。）

**Onboarding 流水线（onboarding pipeline）**：
为一名新用户建档的 Go pipeline：`sync`（全量 watch sync）→ `calibration`（个人基线）→ `compute`（派生指标与历史）。Web 由 `POST /api/{user}/sync` 的 `mode:"full"` 启动，返回的 `run_id` 由 `GET /api/pipelines/{run_id}` 轮询。
_Avoid_: 把 pipeline `done` 叫作 onboarding 完成、onboarding_compute（已废弃运行时名称）

**Onboarding 完成（onboarding finalization）**：
pipeline `done` 只表示可完成；用户点击 **Enter STRIDE** 后才以该成功 `run_id` 调用 `POST /api/users/me/onboarding/complete`。服务端验证归属、pipeline、终态、profile 与手表就绪后写 completion marker；不会启动、重试或关联任务。`GET /api/users/me/sync-status` 是 legacy/read-only associated-run API，不用于 Web 轮询。
_Avoid_: pipeline success = onboarding complete、sync-status poll

## 手表数据同步

**手表数据源**：
STRIDE 能同步运动与健康数据的一个手表平台（如 COROS、Garmin）；每个用户绑定唯一一个数据源。代码层同义词 provider / adapter 均可使用（Go 侧契约包即命名 `internal/provider`）。
_Avoid_: 集成、厂商

**手表原生区间**：
手表自身上报的心率/配速/功率区间分布，取决于手表端配置、编码易漂移。
_Avoid_: zoneList、区间、校准区间

**校准区间**：
用 STRIDE 校准的个人心率/配速模型在同步后算出的每次活动 time-in-zone，与训练状态页一致。
_Avoid_: 手表原生区间、zoneList、watch zones

**STRIDE 自研指标**：
由 STRIDE 自研算法从同步数据算出的派生量——校准阈值/区间、训练负荷（dose / acute / chronic / form / readiness）等；接口挂在 `/stride/*` 下，与手表透传字段刻意分开。
_Avoid_: 厂商指标、COROS 分值、watch metrics

**手表透传字段**：
直接透传手表原始读数、未经 STRIDE 重算的量——RHR、HRV、以及厂商自己算的 ATI/CTI/训练负荷比等；由 `/health`、`/hrv` 提供。
_Avoid_: STRIDE 自研指标、校准值

**影子存储**：
一份与线上手表数据并行维护、但暂不被任何产品功能读取的副本；只用于逐行比对、验证新同步管线的产出与现有数据一致。
_Avoid_: 备份、镜像库、双写

**STRIDE 用户 UUID**：
用户在 STRIDE 内的唯一标识（= JWT `sub`）；所有手表数据都以它标识归属，跨数据源保持一致。
_Avoid_: COROS userId、账号 ID、provider_user_id

**COROS 账号 ID**：
COROS 平台侧的账号标识，仅用于向 COROS 发起请求；不代表也不替代 STRIDE 用户身份。
_Avoid_: user_id、STRIDE UUID

**手表同步任务（watch_sync）**：
在异步 worker 中运行一名用户手表数据同步的任务；以用户 UUID 作分区键，按 payload 决定全量/增量与内容范围，进度写回任务行。Go runtime 的 onboarding pipeline 使用 `sync → calibration → compute`；Python compatibility worker 仍单独使用 `onboarding_full_sync → onboarding_calibration → onboarding_backfill`。
_Avoid_: 把 Python compatibility topology 当作 Go catalog、coros_sync、同步 handler

**同步游标（Sync Cursor）**：
记录某用户上次已同步到的位置（末次活动的 label_id）的标记；增量同步据此止于已知活动，失败重试据此断点续传。
_Avoid_: offset、书签、last_label_id（列名）

**全量同步 / 增量同步（Full / Incremental Sync）**：
全量重扫全部历史活动；增量只拉取游标之后的新活动。同一 watch_sync 任务由 payload `mode` 选择，缺省全量。
_Avoid_: 首次同步、resync、backfill

**最后同步时间（last_sync_time）**：
记录某用户最近一次成功手表同步完成时刻（UTC RFC3339）的 sync_meta 标记；手表状态展示据此显示「最后同步」。与游标 `last_label_id` 是不同的 key。
_Avoid_: last_label_id（那是位置游标）、last_sync（列名）

**断开手表（Disconnect Watch）**：
运动员主动解除与手表数据源的绑定：删除其凭据行并清除 watch_ready，但**保留**已同步的手表数据（仍可访问，重新绑定同一账号即复用历史）。
_Avoid_: 注销、删除账号、清空数据、logout（provider 层用语）

## 入门流程与档案（Onboarding & Profile）

（面向用户的账号/入门表层词汇；Go `cmd/api` 的实现设计见 `docs/adr/0013`。）

**入门流程（Onboarding）**：
新用户进入应用前必须完成的一次性设置——连接一个手表数据源、填写基础档案；完成后才进入训练仪表盘。
_Avoid_: 注册、引导页、新手引导

**手表已连接（watch_ready）**：
用户已成功验证并绑定一个手表数据源的标记；与具体厂商无关（COROS、Garmin 均置位）。
_Avoid_: coros_ready

**基础档案（Profile）**：
运动员在入门流程填写的身份与体型信息（显示名、出生日期、性别、身高、体重）；不含赛季目标或训练计划目标。
_Avoid_: 训练目标、race goal、个人资料

**跑步档案（Running Profile）**：
运动员主动声明、无法可靠地从手表活动推导的跑步背景，概念上包括跑龄区间和伤病记录；伤病记录是独立资源，并非基础档案字段。不含个人最好成绩或当前周跑量，后两者由已同步的手表活动推导。
_Avoid_: 基础档案、把个人最好成绩或当前周跑量作为用户声明字段

**跑龄区间（Running Age Range）**：
运动员持续进行跑步训练的时长分组，而非精确起跑日期；取值为未知、少于 6 个月、6 个月至 1 年、1 至 3 年或 3 年以上。
_Avoid_: 年龄、开始跑步日期

**伤病记录（Injury Record）**：
运动员的一段伤病历史，由自然语言描述、恢复状态与当前跑步限制共同表达；同一运动员可以有多条记录。
_Avoid_: 单一伤病文本、用一个状态同时表达恢复程度和跑步能力

**恢复状态（Recovery Status）**：
一条伤病记录当前处于持续中或已经恢复；它不表达运动员能否跑步。已经恢复的记录必须没有跑步限制。
_Avoid_: 跑步限制、把可慢跑视为已经恢复

**跑步限制（Running Restriction）**：
一条伤病记录对当前跑步能力的限制：无限制、仅可轻松跑或不可跑；它不表达伤病是否已经恢复。持续中的伤病必须限制为仅可轻松跑或不可跑。
_Avoid_: 恢复状态、训练建议

**显示名（display_name）**：
运动员的展示用名字；以 STRIDE 侧为准（source of truth），变更后尽力回写镜像到 Auth 服务的 `name`。
_Avoid_: 用户名、昵称、Auth name（后者只是其镜像）

## 赛季目标（Race Goal）

（运动员为赛季设定的目标比赛；Go `cmd/api` + MySQL 的实现设计见 `docs/adr/0019`。）

**赛季目标（Race Goal）**：
运动员为某一目标比赛设定的完赛目标——一场具名比赛、其日期与距离、可选的目标完赛时间，连同为其训练的每周可用度偏好。每名运动员同时至多一个处于**活跃（active）**状态，赛季训练计划即围绕当前活跃目标组织；重新设定会归档当前活跃目标，历史目标全部保留。
_Avoid_: 训练目标、training goal、比赛类型以外的目标（fat_loss/health/maintain 暂不建模）

（前端从 Python 后端剥离为独立服务/容器的表层词汇；设计与取舍见 `docs/adr/0017`。）

**stride-web**：
承载浏览器前端的独立服务与容器 —— 静态 SPA + 前端 BFF 合一，是用户流量的唯一前门；与只服务 `/api` 的后端 `stride-app` 相对。
_Avoid_: 前端容器、frontend app（后者只是其一部分）

**前端 BFF（Backend-for-Frontend）**：
`stride-web` 内的 Node/Hono 服务端层：服务静态资源，并把浏览器发来的同源 `/api/*`（含 `/api/auth/*`）按路由表转发到某个上游；页面仍客户端渲染，它不做 SSR。
_Avoid_: SSR 服务、网关、nginx 代理

**API 路由表**：
前端 BFF 里版本化的 path→上游映射（前缀/glob，缺省 Python）；把一个 endpoint 从 Python 切到 Go 就是改这张表一行 + 配套前端 contract 改动。它是 Python→Go strangler 的切换点。
_Avoid_: 反向代理规则、nginx location、gateway route

**上游（Upstream）**：
前端 BFF 转发目标之一：`PYTHON_API_URL`（stride-app）、`GO_API_URL`（stride api）、`AUTH_UPSTREAM_URL`（auth-service）。
_Avoid_: 后端、origin、target
