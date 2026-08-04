# STRIDE 训练教练

STRIDE 围绕运动员的赛季目标、周训练执行与日常训练判断，提供可审阅、可确认的教练建议。

## Language

**日常 Coach 问答**：
运动员向 Coach 提问、请求解释或复盘的对话；它可以引用计划，但不会直接改变计划。
_Avoid_: 计划调整、计划审阅

**赛季训练计划**：
围绕目标比赛组织阶段、里程碑和长期训练结构的已启用计划。
_Avoid_: Master Plan、赛季总纲、草稿

**本周课表**：
某一自然周内可执行的跑步、力量、恢复和营养安排。
_Avoid_: Weekly Plan、周计划草稿

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
为一名新用户建档的两步 pipeline —— `full_sync`（跑 watch_sync 全量同步手表数据）→ `onboarding_compute`（算出个人基线与历史）。经 `POST /pipelines/onboarding` 触发，是用户可发起的。
_Avoid_: full_sync → calibration → backfill（Python 的三步旧形态）、首次建档

**Onboarding Compute（onboarding_compute）**：
把一名用户已同步的手表数据一次性算成派生结果的合并计算步骤：校准基线（HRmax / LTHR / 阈值配速 / RHR / 临界功率 / 区间）+ 个人最好成绩 + 训练负荷历史（CTL/ATL/Form）+ 能力快照。仅内部可发起（用户发起的是整条 pipeline，不是这步）。
_Avoid_: calibration、backfill（这是两者合并后的单步）

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
在异步 worker 中运行一名用户手表数据同步的任务；以用户 UUID 作分区键，按 payload 决定全量/增量与内容范围，进度写回任务行。
_Avoid_: onboarding_full_sync、coros_sync、同步 handler

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
