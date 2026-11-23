# 训练计划分布式离线测评平台 v1

设计草案 · 2026-11-23 · [查看架构图和实体属性图](2026-11-23-plan-eval-diagrams.html)

平台通过浏览器提供训练计划测评。评测人员上传已脱敏的历史快照、用例清单和候选计划，再使用规则或 LLM 打分。“离线测评”指输入在运行前冻结，整个过程独立于生产数据和计划生成系统。平台内部使用网络通信，LLM 检查可以调用配置的模型 API。

## 1. 界面与分布式运行架构

Web 界面、可水平扩展的无状态测评 API、可跨机器部署的 worker 池独立运行。所有人通过同一个界面查看有权访问的用例与历史报告。浏览器关闭后任务继续执行，重新打开可凭运行 ID 查看进度。

| 界面 | 用户看到什么 | 可以做什么 |
|---|---|---|
| 用例库 | 用例名称、周计划或总计划、启用的评分项 | 从本机导入一个用例目录或整套目录，选择一个或多个用例 |
| 用例详情 | 跑者目标、数据截止日、训练历史、训练约束、待评计划及评分标准 | 核对输入；单用例可为本次运行选择另一份计划文件；点击「运行测评」 |
| 测评结果 | 运行中显示已完成用例数；结束后显示通过、未通过、执行错误的用例数 | 展开用例查看每项分数、门槛和理由，点击证据定位到本次快照或计划的字段，导出 JSON |

### 一次运行如何完成

1. **导入用例。** API 在所选上传目录内解析引用，校验清单与快照，按输入原始字节计算 SHA-256，保存不可变版本和文件内容。缺文件在导入界面报错；修改快照或评分标准产生新用例版本。API 按调用者权限校验用例、上传计划和报告访问。
2. **提交测评。** API 在同一事务里创建测评运行和每个选中用例对应的一条任务，锁定用例版本、实际计划版本、运行器版本与模型设置。界面获得 run_id 即可离开。一次提交使用唯一请求键，网络重发可取回同一运行，主动再次测评则生成新运行。
3. **并行执行。** worker 从内部 API 原子领取一条用例任务和租约，读取冻结输入，对该用例逐项评分。同一批用例可分给多台机器。worker 只经内部 API 读取与写回测评数据；模型密钥由服务端注入。规则运行只需平台内网，LLM 评分按配置访问模型服务。
4. **中断与接管。** worker 定期续租。租约过期，其他 worker 可凭新租约接管；写回按租约代次判定，旧持有者的迟到结果被拒绝。每个任务、检查组合最多持久化一份结果；接管时跳过已落库检查。若模型已响应、worker 在保存前中断，接管可能再次调用模型。连续丢失租约达配置上限时任务终结为执行错误。
5. **查看结果。** 全部任务终结后，API 依据已保存的逐项结果汇总；以 run_id 唯一键保存一份最终报告。终结触发或后续巡检可幂等重试汇总。页面从 API 查询进度及报告，并在点击证据时读取该任务所锁定的输入版本。

第一版建议用独立的**测评 MySQL 库**存储版本、运行状态、任务、检查结果和报告。冻结输入量小时也以原始字节存入该库。任务表同时充当持久队列；由 Go API 的 storage 层负责领取、续租、幂等提交和汇总。各副本共享这一份状态，无需共享磁盘。可以从一个 API 副本与两个 worker 验证跨节点执行；具体副本数按负载配置。

```mermaid
flowchart LR
    UI["浏览器 · 测评工作台"]
    subgraph EVAL["分布式测评平台"]
      API["测评 API 副本 · 导入、提交、查询、汇总"]
      DB["独立测评库 · 冻结输入、任务队列、结果与报告"]
      W["worker 池 · 按用例领取、续租、写回"]
      RULE["规则 judge"]
      LLM["LLM judge"]
      API <--> DB
      W <-->|内部 API| API
      W --> RULE
      W --> LLM
    end
    UI <-->|提交任务、查询结果| API
    LLM <-->|按需调用| MODEL["模型 API"]
```

单个用例可仅启用规则、仅启用 LLM，或两者同时启用。每个已配置的检查都要执行。规则用例无需模型配置。缺少模型配置仅使对应 LLM 检查出错，同一用例仍执行规则。

新增同类案例只需添加清单、脱敏快照和待评计划。多个案例可以通过相对路径引用同一份快照。已用于评测的快照按版本保留，修正事实时新增文件并更新清单。真实数据由维护者预先整理，仅保留评测所需事实；仓库示例使用虚构数据。每次调用外部模型前须确保该用例的数据允许发送给所选服务。

## 2. 用例格式

三个输入均为 UTF-8 JSON。清单中的文件名相对于清单所在目录解析；本次替换的计划使用界面选定的文件。导入时只解析上传包内的文件。用例标识在本次套件内唯一，检查标识在用例内唯一。

**case.json**

```json
{
  "schema": "plan-eval-case/v1",
  "id": "return-week",
  "athlete": "athlete.json",
  "plan": "plan.json",
  "plan_type": "weekly",
  "checks": [
    {"id": "frequency", "kind": "rule", "rule": "weekly-run-days/v1", "min_score": 1},
    {"id": "distance", "kind": "llm", "question": "周一跑课距离与近期最长跑及本周目标是否相符？",
     "anchors": ["明显冲突", "存在较大偏差且缺少依据", "证据有限，安排尚可解释", "有训练记录支持，仅有小幅疑点", "训练记录和本周目标均明确支持"],
     "min_score": 4}
  ]
}
```

清单字段均必填，`checks` 至少一项。v1 拒绝未知字段、版本、类型和规则。规则通过带版本的名称绑定本地实现；示例规则只适用于周计划，使用其他计划类型属于用例配置错误。LLM 每项只有一个评分问题，五个非空锚点按 1 至 5 分排列。规则门槛固定为 1，LLM 门槛是 1 至 5 的整数。

**athlete.json**

```json
{
  "schema": "plan-eval-athlete/v1",
  "as_of": "2026-08-16",
  "goal": "本周轻松恢复跑，单次距离保持在近期已经完成过的范围内。",
  "constraints": {"max_run_days_per_week": 2},
  "history": [
    {"date": "2026-08-09", "fact": "过去四周最长跑为 8 公里。"}
  ]
}
```

快照必填 `schema/as_of/goal/constraints/history`。日期均为跑者当地日历日（YYYY-MM-DD）；`as_of` 表示截至该日末已知。每条历史证据含日期和非空事实，日期不得晚于截止日；数据提供者负责核对事实确为当时可见。`goal` 为非空文本。`history` 可为空，代表无记录；`constraints` 可为 {}，已有上限时填写整数 1–7。频率规则要求上限存在，缺值属于用例错误。其他事实可通过新增有日期的记录补充。

**plan.json** 保存一份原样的待评计划。清单的 `plan_type` 取 `weekly` 或 `master`，分别用服务内随版本发布的 [WeeklyPlanSchema](../../../src/coach_contract/src/weekly_plan/schema.ts) 或 [MasterPlanSchema](../../../src/coach_contract/src/master_plan/schemas.ts) 解析。运行器可使用打包进工具的共享契约，无需加载生成器。示例计划可从[周计划契约样本](../../../tests/fixtures/weekly_plan_contract.json)提取，包含周一 8 公里轻松跑、周二力量训练和周三休息：

```sh
jq '.base' tests/fixtures/weekly_plan_contract.json > cases/return-week/plan.json
```

## 3. Judge 接口

运行器负责解析输入、选择 judge、核对输出并应用门槛。下列 TypeScript 签名表达调用边界。WeeklyPlan 和 MasterPlan 指上文对应契约的解析结果；Athlete 是上文的快照。传入 judge 的数据只读。

```ts
type Plan = {type: "weekly", value: WeeklyPlan} | {type: "master", value: MasterPlan};
type Input = {athlete: Athlete, plan: Plan};
type RuleCheck = {id: string, kind: "rule", rule: "weekly-run-days/v1", min_score: 1};
type LlmCheck = {id: string, kind: "llm", question: string, anchors: string[], min_score: number};
type Evidence = {source: "athlete" | "plan", pointer: string};
type Grade = {score: number, reason: string, evidence: Evidence[]};
type JudgeResult = {grade: Grade} | {error: {code: string, message: string}};
interface Judge<C> {
  evaluate(input: Readonly<Input>, check: Readonly<C>): Promise<JudgeResult>;
}
type RuleJudge = Judge<RuleCheck>;
type LlmJudge = Judge<LlmCheck>;
```

- **规则 judge** 对 `weekly-run-days/v1` 取该周 `sessions` 中 `kind=run` 的不同日期数，同日两跑计一天。实际天数小于等于上限得 1 分，否则得 0 分。理由给出实测值和上限，证据定位至快照约束与计划排课。规则只读本次任务的冻结输入。
- **LLM judge** 每个检查调用一次模型 API。适配器使用版本化提示词，把快照、计划、问题和五档量表传给模型。快照及计划作为待分析数据传入。模型返回一个 Grade JSON，不接收其他检查的结论；门槛由运行器使用。服务名、模型名从运行配置注入，密钥通过环境变量或密钥管理器提供。
- **共同约束**：分数为该 judge 量表内整数，理由非空。至少一条证据；LLM 评分须各引用一条跑者和计划证据。指针用 RFC 6901 JSON Pointer，基于对应输入文档的根，必须能解析；可引用空数组表达缺少记录。API 超时、鉴权失败、模型输出格式错误、指针不存在或 judge 异常均产生执行错误。一次正常执行中每项调用一次；错误写回后继续其余检查。中断接管按上文处理。评分完成时 `score >= min_score` 即通过。

## 4. 报告格式与界面状态

示例对应上面的用例。模型名称及评分用于说明报告格式。run_id 和 task_id 分别定位本次运行及其用例任务。三个 SHA-256 对应示例文件的实际字节（两个内嵌 JSON 块含末尾换行，计划使用上文 jq 命令导出）。

```json
{
  "schema": "plan-eval-report/v1",
  "run_id": "run-001",
  "runner_version": "0.1.0",
  "status": "pass",
  "summary": {"pass": 1, "fail": 0, "error": 0},
  "errors": [],
  "cases": [{
    "task_id": "task-001",
    "manifest": "return-week/case.json",
    "case_id": "return-week",
    "inputs_sha256": {"manifest": "53bcdeaf2a40229184d8c644b5208f100407c9272d7a8bf2ff6f70760f05a4f6", "athlete": "118ee39e356b4a93e1f5f60ad1b09513c02ee0844b5b7bcc2efac291aed6c436", "plan": "a12d6ca3125fc0821704c42121ce645bfa2348d27660b0dada3bb5bb1715c619"},
    "status": "pass",
    "errors": [],
    "checks": [
      {"id": "frequency", "kind": "rule", "judge": {"rule": "weekly-run-days/v1"},
       "status": "pass", "score": 1, "min_score": 1, "reason": "1 个跑步日，上限 2 天。",
       "evidence": [{"source": "athlete", "pointer": "/constraints/max_run_days_per_week"}, {"source": "plan", "pointer": "/sessions"}]},
      {"id": "distance", "kind": "llm", "judge": {"provider": "example", "model": "example-model", "prompt_version": "plan-grade/v1"},
       "status": "pass", "score": 5, "min_score": 4, "reason": "周一为 8 公里轻松跑，与近四周最长跑相同，符合本周目标。",
       "evidence": [{"source": "athlete", "pointer": "/history/0/fact"}, {"source": "athlete", "pointer": "/goal"}, {"source": "plan", "pointer": "/sessions/0"}]}
    ]
  }]
}
```

- `manifest` 为相对发现根目录的路径。单用例直接指向用例目录时值为 `case.json`。`inputs_sha256` 对实际读取的字节取小写十六进制摘要，在界面替换待评计划时记录替换后的计划。规则版本、模型请求标识和提示词版本用于追溯；模型 API 的同配置重跑可能有波动。
- 已评分的检查完整保留分数、门槛、理由和证据。检查执行错误时保留标识、kind、judge、门槛，置 `status="error", score=null, evidence=[]`，以 `error:{code,message}` 替代 reason。错误信息经过脱敏；报告省略凭证、原始提示词和模型原始响应。
- 已入库的清单、快照或计划在执行时无法读取，错误记在用例的 `errors`（元素均为 `{code,message}`），该用例的 `checks=[]`，继续其他有效用例。报告从已提交的任务读取 case_id 和冻结版本摘要。文件可读但候选计划不是合法 JSON 或未通过所声明计划的契约校验，视为候选产物失败，记用例 `fail`，`errors` 记录 `invalid_plan`，跳过该用例所有 judge。先验证清单与快照，确保不会把输入配置错误算在候选头上。
- 用例内、套件内均按 **error > fail > pass** 汇总，保留各检查原始状态；所有检查均为必过项。summary 按用例最终状态计数。空选择、重复用例 ID 或批量覆盖计划在提交前反馈给界面，不创建运行。顶层 errors 保留运行级错误。界面分别显示「通过」「未通过」「执行错误」。运行中为临时展示状态；报告尚未持久化时显示「汇总中」；保存失败时显示「保存失败，待重试」。

例如，混合用例中模型服务和模型名均未配置时，该检查的报告记录如下；频率规则仍保留自己的分数。

```json
{"id":"distance","kind":"llm","judge":{"provider":null,"model":null,"prompt_version":"plan-grade/v1"},
 "status":"error","score":null,"min_score":4,"evidence":[],
 "error":{"code":"model_config_missing","message":"缺少模型服务和模型名。"}}
```

## 5. 用例与运行结果的实体关系

下图给出平台的逻辑实体、主要属性、标识和基数。PK 表示主键，FK 表示关联键。快照与清单保留上传时的原始字节，校验时按原始字节而非 JSON 再序列化结果计算摘要。JSON 报告是对已完成运行的导出视图。

```mermaid
erDiagram
    "跑者快照" {
        string snapshot_id PK "快照版本"
        date as_of "数据截止日"
        text goal "训练目标"
        json constraints "训练约束"
        json history "有日期的训练事实"
        hash sha256 "原始输入摘要"
    }
    "用例版本" {
        string case_version_id PK "用例版本"
        string case_id "稳定用例标识"
        string snapshot_id FK "跑者快照"
        string default_plan_id FK "默认计划"
        hash manifest_sha256 "清单摘要"
    }
    "检查定义" {
        string check_def_id PK "定义标识"
        string case_version_id FK "所属版本"
        string check_id "用例内标识"
        enum kind "rule 或 llm"
        json criteria "规则名或问题与量表"
        int min_score "通过门槛"
    }
    "待评计划" {
        string plan_id PK "计划版本"
        enum plan_type "周计划或总计划"
        bytes content "上传原文"
        hash sha256 "原文摘要"
    }
    "用例任务" {
        string task_id PK "任务标识"
        string run_id FK "所属运行"
        string case_version_id FK "冻结用例"
        string actual_plan_id FK "实际计划"
        enum state "排队、执行或终态"
        int lease_epoch "租约代次"
        time lease_until "租约截止时间"
    }
    "检查结果" {
        string result_id PK "检查结果"
        string task_id FK "所属任务"
        string check_def_id FK "评分依据"
        enum status "通过、未通过或错误"
        int score "分数，可空"
        json detail "理由或错误，judge 版本"
    }
    "测评报告" {
        string run_id PK,FK "每次运行一份"
        enum status "整次评测判定"
        json summary "用例状态计数"
        json content "最终报告正文"
    }
    "测评运行" {
        string run_id PK "一批用例"
        string created_by "提交人"
        string request_key "提交幂等键"
        string runner_version "评分实现版本"
        json model_config "模型和提示词版本"
        enum state "排队、执行、汇总或完成"
    }
    "证据引用" {
        string result_id PK,FK "所属检查结果"
        int position PK "结果内序号"
        enum source "快照或计划"
        string pointer "JSON Pointer"
    }
    "跑者快照" ||--o{ "用例版本" : "提供事实"
    "待评计划" ||--o{ "用例版本" : "默认计划"
    "用例版本" ||--|{ "检查定义" : "配置"
    "用例版本" ||--o{ "用例任务" : "冻结版本"
    "待评计划" ||--o{ "用例任务" : "实际计划"
    "测评运行" ||--|{ "用例任务" : "派发"
    "用例任务" ||--o{ "检查结果" : "得到"
    "检查定义" ||--o{ "检查结果" : "评分依据"
    "检查结果" ||--o{ "证据引用" : "引用"
    "测评运行" ||--o| "测评报告" : "最终形成"
```

同一用例版本锁定快照、默认计划和检查定义。一次运行内每个选中用例创建一个任务；若界面临时换了计划，任务的 actual_plan_id 指向替代版本。每条证据通过所属任务定位输入：source 为 athlete 时读用例版本的 snapshot_id，为 plan 时读任务的 actual_plan_id。更新用例库或更换 worker 后，旧报告仍指向原始证据。

约束：同一提交人的 request_key 唯一；同一运行的用例版本唯一；同一用例版本的 check_id 唯一；每个 (task_id, check_def_id) 只保存一份检查结果，且检查定义必须属于该任务的用例版本。证据以 (result_id, position) 作复合主键。运行中报告数量为零，完成时恰好一份。任务调度状态和计划质量判定分别记录。

## 6. 实现验收

| 操作 | 可观察结果 |
|---|---|
| 仅配置频率规则，移除模型凭证并禁用公网出口，保留平台内网 | 示例通过；再加两个不同日期的跑课，达到 3 个跑步日，分数从 1 变为 0；同日双跑只计一天 |
| 从界面导入用例，临时替换计划，执行后重新打开报告并点击证据 | 定位到本次使用的输入字段，原用例和已有报告保持完整 |
| 仅配置 LLM，测试适配器依次返回带有效证据的 3 分和 4 分 | 门槛为 4 时分别 fail、pass；适配器收到该用例的快照、候选计划和量表 |
| 同时配置两种 judge，让规则失败、LLM 通过 | 用例 fail，报告保留两项分数；替换输入只影响本次报告 |
| 注入 API 超时、缺失证据指针、运行中冻结输入不可读、损坏的候选计划 | 前三种 error，损坏计划 fail；批量继续执行后续有效用例 |
| 复制用例并换成新的唯一 ID 和快照 | 一次运行报告两个用例，无需改运行器或 judge |
| 使用允许发给外部服务的虚构用例及已配置的模型 API | 单独验证鉴权和结构化输出，报告记录服务和模型；日常契约测试可使用固定 API 响应 |
| 两台 worker 领取同一运行里的不同用例，关闭浏览器后从另一客户端打开 run_id | 可查询同一运行的进度与结果，无需原浏览器或上传者的机器在线 |
| worker 写入一项检查后丢失租约，由另一 worker 接手；随后旧 worker 迟到写回 | 已保存的检查可复用，迟到写回被拒，每项结果和最终报告各一份 |
