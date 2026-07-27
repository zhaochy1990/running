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
一个具名的、线性的 job 步骤序列（如 onboarding：full_sync → calibration → backfill）。
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
