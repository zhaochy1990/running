# Coach Agent（已迁移到 TypeScript）

> **DEPRECATED**：本文档过去描述的是 **已废弃的 Python Coach Agent**（`src/coach/*` + `src/stride_server/coach_*`）。该实现**已不再使用**，相关内容已删除。

现行 Coach Agent 是 **TypeScript 版**：

| 部分 | 路径 |
|------|------|
| 核心（LangGraph graph / tools / schemas） | `src/coach_agent/` —— 先读 [`src/coach_agent/AGENTS.md`](../src/coach_agent/AGENTS.md) |
| HTTP 服务（`/api/users/me/coach/*`） | `src/coach_agent_api/` |
| 后台 worker（训练计划 job） | `src/coach_agent_worker/` |
| 架构 / 场景文档 | [`docs/coach_agent/`](coach_agent/)（`architecture.md` · `scenarios.md` · `concepts.md` · `master_plan_langgraph.md` · `master_plan_rules.md`） |

**改 / 读 / 评审 Coach Agent 一律以 TS 版为准**，不要再参考或修改 Python 版（`src/coach/`，已标记待删除）。
