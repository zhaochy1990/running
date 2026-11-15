# 训练画像文件 POC

本分支是供审阅的 throwaway POC，不合并或部署为正式功能。按用户最新范围，独立 `src/training_profile` Node package 以 TS 生成画像，结果只保存本地 JSON／Markdown；不包含 Go 服务、数据库、任务调度或 Coach／训练计划接入。

范围与验收见[训练画像最小闭环 POC：独立 TS 包生成、本地保存与内容质量验证](https://github.com/zhaochy1990/stride-devops/issues/981)。正式 Go／TS 职责和持久化决议仍留待后续落实，本轮文件保存不替代正式方案。

## 包边界

```text
已有只读资料快照
  → @stride/training-profile
      → 完整窗口描述统计 + 已有 Go 校准估计 + 可确认的本人原文
      → @stride/common buildModel → 候选综合认识
      → 本地 profile.json / profile.md / layered.json / metrics.json
```

画像包不依赖 Coach Agent、worker 或数据库驱动。共享模型客户端和上海日期工具分别来自 `@stride/common`、`@stride/contract`。没有新增个人基线算法。现有快照采集沿用生产只读接口／storage；本包只消费已取得的文件，不持有生产数据凭据。

统计明确识别 `run_outdoor`、`run_track`、`run_indoor`，其他运动不混入跑量；未知 sport 不靠距离猜测。活动可能分段，记录条数不等于独立训练课。缺失与无记录不解释为休息、零负荷、无伤病或偏好。

## 分层实验

每条结论分别记录三个轴：

- `kind`：记录／统计事实、已有算法估计、本人原文、系统综合观察／候选。
- `lifecycle`：历史事件、相对稳定的长期认识、滚动观察、未知。统计汇总随窗口滚动，单次事件归历史；历史可以更正，长期不代表永久或最高支持。
- `dimension`：训练经历、能力、主观体验等开放主题。

`layered.json` 只重排 `profile.json` 中同一批条目，不重写结论。完整证据标识和副本内容摘要保存在JSON中；候选另保存 `derivedFromFactIds`，多个汇总引用同一原始来源不能算成多份独立证据。来源日期与结论有效期不同。长期层没有依据就为空。

PB也要区分历史成绩记录与“目前最好成绩”：前者保留历史，后者会因新成绩或更正而改变。本POC只有带标签的活动记录，不冒充完整参赛史或正式PB。

## 运行

使用 Node 24 和 pnpm。真实输入、结果与模型环境变量放在 Git 外，禁止提交到 tracker 或PR。运行前已有本地快照；本命令不查询数据库。

```sh
pnpm install --frozen-lockfile
pnpm --filter @stride/training-profile... build
# 从仓库根执行；输出目录必须尚不存在，其父目录应为私人目录。
pnpm prototype:training-profile /absolute/private/snapshot.json /absolute/private/run-1 /absolute/repo/config/coach.local.yaml deepseekv4flash
# 对快照副本更新后重新评估；可传入同一用户的上轮结果。
pnpm prototype:training-profile /absolute/private/snapshot-copy.json /absolute/private/run-2 /absolute/repo/config/coach.local.yaml deepseekv4flash /absolute/private/run-1/profile.json
pnpm --filter @stride/training-profile test
pnpm exec biome check src/training_profile/src
```

模型密钥经所选模型配置的 `api_key_env` 取得，例如 `DEEPSEEK_API_KEY`；不需要 MySQL 凭据、Docker 或 Go。需要从环境文件载入时可使用 Node 的 `--env-file` 执行编译后 `src/training_profile/dist/cli.js`。私有运行不要开启外部 tracing。

文件目录权限700、输出文件600，拒绝覆盖已有目录／文件。模型原始响应先保存，解析失败不会生成一份假成功画像；失败重试用新目录。接口未提供金额时只记录用量，不虚构单价。

## 验证边界

本轮用真实180天快照检查数值、来源归属、分层、候选内容质量，并在副本撤回来源后重新生成。`validConclusions` 检查旧条目的完整来源引用是否仍有效，不改写历史文件；生成始终按当前快照重算事实。离线旧文件没有实时保护能力，不能直接作为当前有效接口；正式来源变更协议、并发发布、自动更新、删除清理及稳定跨版条目身份尚未实现。

内容审查与实测结果见 [TAKEAWAYS.md](TAKEAWAYS.md)。技术成功和引用存在只能证明链路可检查，不能证明推断真实或有用。
