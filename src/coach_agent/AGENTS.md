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


# Code Style
use biome for code formatter. use `npm run format`, `npm run check` to format and check code styles.
