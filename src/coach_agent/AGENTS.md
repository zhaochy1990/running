# 规则

1. 在使用langchain/langgraph/deepagent框架的时候，不要通过prompt来维护context或者state

# Think-Calculate-Adjust 架构（HARD）

结构化训练计划生成统一采用“思考-计算-调整（Think-Calculate-Adjust）”流程。结构化输出和工具调用必须分轮执行：本场景中二者存在双向依赖，不能合并到同一次模型调用，也不能把负荷计算器暴露为模型可调用工具。

1. **Think（Model 思考）**：模型通过结构化输出生成初步训练计划 JSON。
2. **Calculate（代码计算）**：Graph 截获并校验该 JSON，由确定性负荷计算节点计算 session dose、周负荷、CTL、ATL、Form、负荷比和安全信号。
3. **Adjust（Model 调整）**：Graph 把计算结果作为隐式反馈传回模型，例如具体日期的负荷过高、目标区间偏差或安全风险；模型据此生成修订后的结构化计划。
4. **Finalize（最终输出）**：仅当最新结构化计划已经过负荷计算并满足确定性门禁时，才输出最终周计划。

实现约束：
- 调整轮必须基于紧邻上一版计划的计算结果；模型修改计划后必须重新计算，旧计算结果不得用于新计划。


# DeepSeek Responses API 踩坑（HARD）

`buildModel`（`src/stride-common/src/llm/models.ts`）走 DeepSeek Responses API + `json_schema` 结构化输出。下列坑已由发线前净化器 `jsonSchemaSanitizingFetch` 统一处理；**新增模型直连、绕过 `buildModel`、或升级 langchain/openai SDK 时必须逐条复核**（2026-10 master kernel E2E 实测踩过，11 轮迭代定位）：

1. **不支持 `oneOf`**：400 报错文案却写 ``field `anyOf`: one of `type`, `anyOf`, `$ref` field is required``——文案有误导性，别按字面排查 anyOf。净化器统一 oneOf→anyOf（判别并集语义等价）。
2. **strict 模式要求 `required` 覆盖全部 properties**：OpenAI 惯例是可选性写成 anyOf-null + 全量 required，zod 直出的 schema 不是这个形状，报 ``Required properties must match all properties in the object``。净化器补全 required 并可空化可选属性。
3. **嵌套 anyOf 不收**：anyOf 分支不能是另一个无 `type` 的组合子（报 ``field `anyOf`: missing field `type` ``）。可空化必须**扁平追加** `{type:"null"}` 分支，不能套娃。
4. **`$ref`/`$defs` 在组合子分支里同样被挑剔**：净化器统一内联（zod 对重复子 schema 去重产生的引用，内联是纯等价改写）。
5. **结构化输出会以文本 echo 回流**：ToolStrategy/json_schema 输出可能整块（race_strategy 场景，PR #516 过滤）或 **token 级碎片**（kernel 内部模型，master kernel 曾泄漏 ~2500 个 text_delta 把整段 JSON 打进客户端打字机）echo 进流。整块前缀过滤对 token 碎片无效——流转发必须按来源过滤（`coach_agent_api/src/routes/stream.ts` 的 `REPLY_TEXT_NODES` 允许清单）。
6. thinking 模型不支持 forced `tool_choice`（400）；`stream_options` 只能在 `stream: true` 时携带——`buildModel`/`buildChatModel` 已内置规避，改动时别弄丢。

**排查手法**：hook `globalThis.fetch` 抓真实发线请求体（注意 langchain responses 适配器把 format 摊平成 `text.format = {type:"json_schema", schema, name, strict}`），再用原生 fetch 把变体直接 POST `/responses` 离线二分——比跑整条 E2E 快两个数量级。

# Code Style
use biome for code formatter. use `npm run format`, `npm run check` to format and check code styles.
