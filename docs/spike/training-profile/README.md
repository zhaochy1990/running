# 训练画像文件 POC

当前入口是[十维混合计算／子Agent POC](TEN-DIMENSION-POC.md)。以下保留前几轮演进记录；当前支持一次输入多个已审阅历史profile文件，逐条保留、复核或显式处置，不再从零覆盖画像。

本分支是供审阅的 throwaway POC，不合并或部署为正式功能。按用户最新范围，独立 `src/training_profile` Node package 以 TS 生成画像，结果只保存本地 JSON／Markdown；不包含 Go 服务、数据库、任务调度或 Coach／训练计划接入。

范围与验收见[训练画像最小闭环 POC：独立 TS 包生成、本地保存与内容质量验证](https://github.com/zhaochy1990/stride-devops/issues/981)。正式 Go／TS 职责和持久化决议仍留待后续落实，本轮文件保存不替代正式方案。

## 包边界

```text
已有只读资料快照
  → @stride/training-profile
      → 自主提出假设 → 读取资料／编写计算 → 找反例／修订
      → @stride/common buildModel（仅Flash）+ 独立假设账本
      → 本地 profile.json / profile.md / layered.json / analysis.json / metrics.json
```

画像包不依赖 Coach Agent、worker 或数据库驱动。共享模型客户端和上海日期工具分别来自 `@stride/common`、`@stride/contract`。没有新增个人基线算法。现有快照采集沿用生产只读接口／storage；本包只消费已取得的文件，不持有生产数据凭据。

统计明确识别 `run_outdoor`、`run_track`、`run_indoor`，其他运动不混入跑量；未知 sport 不靠距离猜测。活动可能分段，记录条数不等于独立训练课。缺失与无记录不解释为休息、零负荷、无伤病或偏好。

## 分层实验

每条结论分别记录三个轴：

- `kind`：记录／统计事实、已有算法估计、本人原文、系统综合观察／候选。
- `lifecycle`：历史事件、相对稳定的长期认识、滚动观察、未知。统计汇总随窗口滚动，单次事件归历史；历史可以更正，长期不代表永久或最高支持。
- `dimension`：训练经历、能力、主观体验等开放主题。

`layered.json` 只重排 `profile.json` 中同一批条目，不重写结论。完整证据标识和副本内容摘要保存在JSON中；个体认识以 `kind: insight` 和 `planningUse` 保存，另存本POC的观察支持描述；分析统计仍保留各自知识类型。认识另保存 `derivedFromFactIds`，多个汇总引用同一原始来源不能算成多份独立证据。来源日期与结论有效期不同。长期层没有依据就为空。

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
# 多轮已有认识可同时输入；输入与输出文件保持独立。
pnpm prototype:training-profile /absolute/private/snapshot.json /absolute/private/run-3 /absolute/repo/config/coach.local.yaml deepseekv4flash /absolute/private/reviewed-a/profile.json /absolute/private/reviewed-b/profile.json
pnpm --filter @stride/training-profile test
pnpm exec biome check src/training_profile/src
```

模型密钥经所选模型配置的 `api_key_env` 取得，例如 `DEEPSEEK_API_KEY`；不需要 MySQL 凭据、Docker 或 Go。需要从环境文件载入时可使用 Node 的 `--env-file` 执行编译后 `src/training_profile/dist/cli.js`。私有运行不要开启外部 tracing。

文件目录权限700、输出文件600，拒绝覆盖已有目录／文件。模型原始响应先保存，解析失败不会生成一份假成功画像；失败重试用新目录。接口未提供金额时只记录用量，不虚构单价。

## 验证边界

本轮用真实180天快照检查数值、来源归属、分层、候选内容质量，并在副本撤回来源后重新生成。`validConclusions` 检查旧条目的完整来源引用是否仍有效，不改写历史文件；生成始终按当前快照重算事实。离线旧文件没有实时保护能力，不能直接作为当前有效接口；正式来源变更协议、并发发布、自动更新、删除清理及稳定跨版条目身份尚未实现。

内容审查与实测结果见 [TAKEAWAYS.md](TAKEAWAYS.md)。技术成功和引用存在只能证明链路可检查，不能证明推断真实或有用。

## 第二轮：从统计摘要改为有规划用途的认识

上一轮虽通过技术测试，用户明确指出没有达到画像目标：大部分内容只是统计与不确定说明。该轮不作为内容验收通过。

新输入沿用180天窗口并通过既有只读 `DataProvider.getActivityDetail` 补齐分段，保存为新快照，原文件不覆盖。列表接口的空laps不是“手表未记录分段”；必须核验读取能力。生成包依然只读本地文件，不依赖数据库或Coach运行时。

`comparisons.ts` 提供跨记录证据：近期与高量期的周结构、长跑首末10公里、配速和距离相近的天气配对、测试与同期长跑的表现差异。不是新建HRmax、阈值等个人基线。长跑区块按距离分配分段交叠，心率按时间加权；过粗或覆盖不全的分段不冒充10公里测量。天气配对先按配速／日期距离选择，保留全部候选及反例，不复用活动、不按心率结果挑选。匹配条件是本轮探索方案，不冒充已确认的正式方法门槛。

模型读取对照证据后，给出个人特点、依据和定性规划用途。新关联仍遵守已决用途限制；暂不输出精确修正系数。正文展示认识和用途，原始统计、未成立方向与详细条件保存在 `analysis.json`／画像JSON中。空层不填占位内容，schema通过或条目数不再标为质量目标已达成。

本轮依旧不生成或修改训练计划；`planningUse`用于检验画像将来是否有可引用的内容。

## 模型约束

用户明确要求只用 `deepseek-flash` 做后续模型测试。生成入口在调用共享客户端前拒绝任何其他模型；早先两次Pro试验只作为历史错误与调试记录，不能算Flash效果证据。

本轮默认 `PROFILE_MAX_OUTPUT_TOKENS=32768`、`PROFILE_REASONING_EFFORT=high`；可通过这两个环境变量调整输出预算及low／medium／high推理强度。每轮metrics保存实际model、参数、用量与耗时。参数调整不改变模型。

负荷分析引用已有daily load的完整周与峰值日前后值，比较周内剂量集中，而不是用单日负荷比或HRV范围放行维持／加量。天气正文可查看全部备选，但来源引用覆盖所有可见候选并去重；不复用主分析与共享对照备选分别计数。

## 第三轮：独立评估Agent

用户认可前轮部分认识，并要求开放自主探索。默认生成入口现改为LangChain `createAgent`工具循环，不调用旧的 `describeSnapshot`／`buildComparisons` 来预先选择分析方向，也不把旧画像放进起始上下文。旧对照代码与本地结果仅作为外部比较基线。首次真实运行使用Deep Agents；独立review后移除了隐式摘要、虚拟文件和委派，仅保留本轮所需的单Agent与显式工具，避免摘要调用绕过调用预算和用量记录。

Agent可查看数据目录、分页读原始记录、读活动分段、编写同步JavaScript计算，以及提出／修订假设。计算在QuickJS WebAssembly解释器内使用只读快照副本，不安装宿主Node、文件、网络或密钥接口，限时限内存。它使用的是同一份固定本地资料，不查询或写入数据库。

计算的来源依赖由宿主保守绑定整份有效快照，不接受Agent代码返回的来源清单。输入依赖条数不是支持样本数；实际筛选、样本和反例在计算代码及结果中。本轮来源变化可能使更多条目失效，这是文件POC的保守选择，不是正式局部失效协议。

`record_hypothesis`保存问题、反证方案、支持／反证计算receipt、状态和修订历史。每条保留认识都必须绑定已完成的支持计算和一次不同代码的反例检查。这个检查证明过程材料存在，不自动证明统计方法或结论正确；本轮仍要审阅内容。

最终通过 `submit_training_profile`提交；成功后由runtime结束循环。结果仍是本地JSON／Markdown；另保存 `agent-trace.jsonl` 和 `analysis.json`，可检查假设如何形成、查了什么、有哪些反例、为什么保留或放弃。日志含私人数据，仅在本地保留，不入Git或外部tracing。默认32个决策轮次、每次计算2.5秒／96MiB、整轮20分钟，达到上限而未提交则失败，不保存成假成功画像。

工具失败也写入本地journal，并返回给Agent修正，失败不算反证或成功receipt。不同代码的反证只代表执行了另一项检查，不能自动证明设计独立、统计有效或最终文字忠实；内容审查保留原稿与人工校正副本，不能混为自动生成已通过。

框架与计算工具参考：[LangChain Agents官方说明](https://docs.langchain.com/oss/javascript/langchain/agents)、[QuickJS-emscripten](https://github.com/justjake/quickjs-emscripten)。模型继续严格限定DeepSeek Flash；本轮沿用high和32768输出预算，可按既有环境变量调整。
