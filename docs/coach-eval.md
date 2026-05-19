# Coach Agent Evaluation — Framework

**何时读**：要读 coach eval 框架级概念（L1/L2/L3 三层栈、Judge graph 设计、fixture 通用 envelope、CLI、目录约定）时必读。Scope-specific 内容（fixture 字段、coverage 场景、L1 规则、judge axes）请按 scope 跳转：

- [`coach-eval_S1.md`](coach-eval_S1.md) —— S1 赛季备战计划
- [`coach-eval_S2.md`](coach-eval_S2.md) —— S2 周训练计划
- [`coach-eval_S3.md`](coach-eval_S3.md) —— S3 每日问答

**范围**：本文档定义的是 **offline evaluation framework** —— 用户在本地手动跑 fixture 拿 deterministic + LLM-judge 分数，对比历史 baseline 看有没有退化。**不包含** production runtime 接入、CI 自动触发、observability dashboard、用户面 thumbs-up 反馈等问题；那些等离线框架稳了、有了 baseline signal 后再单独立项。

## S1 / S2 / S3 是什么

Coach agent 三个 scope，对应三类用户场景。每个 scope 在 `src/coach/graphs/conversation/graph.py` 里走不同的 system prompt（`_SCOPE_PROMPTS`），但共享同一个 LangGraph 骨架。

| Scope | 中文名 | 输入 | 输出 | 调用频率 | Code path |
|-------|--------|------|------|---------|-----------|
| **S1** | 赛季备战计划 | 用户目标比赛、当前能力、可用训练时长、周期化偏好 | `MasterPlan` 结构（含 base / build / peak / taper / recovery 阶段，每阶段周量与强度框架） + 配套 markdown | 一个赛季 1 次（夏训 / 冬训 / 备赛周期开始时） | `master_chat` prompt；当前 generation 在 `stride_server/master_plan_generator.py:run_generate_job`（self-contained，**Phase 1 refactor 后接入 `build_generation_graph`**，详见 [`coach-eval_S1.md`](coach-eval_S1.md) Pipeline / Roadmap） |
| **S2** | 周训练计划 | 当前 master plan 阶段、上周 feedback.md、最近身体信号（HRV/RHR/sleep/PMC）、用户文字 request | `WeeklyPlan` 结构（每日 run / strength / rest / nutrition session） + `plan.md` + `plan.json` | 每周 1 次（下周开始前） | `week_chat` prompt + `build_generation_graph` |
| **S3** | 每日问答 | 用户自由文字问题（"今天该跑长 run 吗"、"为什么 HRV 在掉"、"明天下雨怎么办") + 当前周 plan + DB grounding | 文字回答（**read-only**，不生成 / 不改 plan） | 每天 N 次 | `qa` prompt + conversation graph only（没有 generation pipeline） |

**关键区别**：
- **S1 / S2 同时有 conversation 和 generation 两条路径**：
  - **Conversation 路径** —— 用户多轮聊天讨论调整（`master_chat` / `week_chat` scope）。AI 工具 emit typed `PlanDiff` / `MasterPlanDiff`，server 经 **Pattern Y** 落盘。
  - **Pattern Y** = "stateless propose → apply"：AI 在 propose 阶段只产出 typed diff（结构化、schema-validated 的字段级 patch），不直接改 DB；server 在 propose 和 apply endpoint 之间 **不留任何内存中的 pending-diff 状态**，diff 经 HTTP request body 由前端在 apply 调用时送回。完整性靠 path-match validation（`diff.folder == path_folder`、`accepted_op_ids ⊆ diff.ops.id`）+ post-apply rule_filter rerun + schema validation 保证。完整定义见 [`coach-agent.md`](coach-agent.md) § v1 architectural patterns。
  - **Generation 路径** —— 一次性整体生成。S2 已走 `build_generation_graph`（`load_context → generator → rule_filter → reviewer → verdict`，输出 schema-可校验的完整 plan）；**S1 当前 self-contained 在 `stride_server/master_plan_generator.py:run_generate_job`，Phase 1 refactor 后统一到 `build_generation_graph(plan_type="master")`**。
  - **Eval 优先评估 generation 路径** —— 它是 plan 的 source；conversation 只是基于 generation 输出做字段级微调。
- **S3 只走 conversation graph** —— `reason → tools? → reason`，输出自由文字（无 schema 可校验，evaluation 必须靠 hallucination check + LLM judge）
- **S1 / S2 偶发**，**S3 高频** —— eval coverage 重心不同：S1 / S2 追深度（每条 fixture 验证细节），S3 追覆盖（多条 fixture 验证不出 hallucination）

## Source of truth

| 概念 | 代码 |
|------|------|
| Plan schema (S2) | `src/stride_core/plan_spec.py` (`WeeklyPlan.from_dict`) |
| Master plan schema (S1) | `src/stride_core/master_plan.py` (pydantic `MasterPlan`) |
| 现有 rule filter (S2) | `src/coach/graphs/generation/rule_filter.py` |
| Reviewer 输出 schema | `src/coach/schemas/review.py` (`ReviewReport`) |
| Generation pipeline | `src/coach/graphs/generation/graph.py` |
| Conversation pipeline (S3) | `src/coach/graphs/conversation/graph.py` |

文档落后于代码时 **信代码**。

## 三层评估栈

| Layer | 谁判 | 输出 | 成本 |
|-------|------|------|------|
| **L1: rule filter** | 纯 Python | `pass` / `error` + violation list | 0 USD，30 秒跑完全部 fixture |
| **L2: LLM judge** | GPT-5.4（≠ reviewer model） | N 维 1-5 + rationale + overall verdict | 每 fixture ~1-3 美分，全量 30 条 ~1 USD |
| **L3: human spot-check** | 用户 | accept / reject + 自由备注 | 每条 5-15 分钟人工 |

三层都是离线跑 —— 用户起 `python -m coach.eval` 命令触发，结果写到本地 JSON / markdown。不接 CI、不接 prod runtime。

**L1 抓不到的**：训练学合理性（"对一个 HRV 下行的用户排两个质量课在周一周三"通过所有规则但训练学不合理）→ 留给 L2。
**L2 抓不到的**：风格、tone、用户体感 → 留给 L3。
**L3 抓不到的**：覆盖度 → L1+L2 解决。三层互补，单层都不够。

各 scope 的 L1 规则、L2 axis 集合在 scope-specific doc 里。

## Fixture 通用规范

### 目录结构

```
tests/fixtures/coach_eval/
    s1/                          # master plan fixtures
        s1-summer-base-build.json
        s1-winter-from-injury-return.json
        ...
    s2/                          # weekly plan fixtures
        s2-hrv-drop-keep-volume.json
        s2-recovery-week-after-race.json
        ...
    s3/                          # daily Q&A fixtures
        s3-why-easy-pace-feels-hard.json
        ...
    spot_checks/                 # L3 人工审过的 sample（追加）
        2026-05-18_s2-hrv-drop-keep-volume.md
```

文件名规则：`{scope}-{kebab-case-scenario}.json`，**不带日期** —— fixture 是 timeless contract。

### Fixture JSON Envelope（所有 scope 共享）

```json
{
  "fixture_id": "<unique slug, == 文件名去 .json>",
  "scope": "s1" | "s2" | "s3",
  "description": "一句话场景描述（给 human reviewer 看）",
  "tags": ["recovery_signal", "user_pushback", ...],
  "input": { /* scope-specific —— 见各 _S 文档 */ },
  "expected": {
    "hard_constraints": { /* scope-specific —— L1 必过项 */ },
    "soft_rubric": { /* axis -> { min_score: 1-5, behavior: str } */ },
    "anti_patterns": [ /* 显式不允许的行为 */ ]
  }
}
```

### 通用字段含义

| 字段 | 必需 | 含义 |
|------|------|------|
| `fixture_id` | ✅ | 唯一，文件名去 `.json` 同值 |
| `scope` | ✅ | `"s1"` / `"s2"` / `"s3"` |
| `description` | ✅ | 一句话场景描述 |
| `tags` | ✅ | 用于 fixture coverage 统计 |
| `input.*` | scope-specific | 见 `coach-eval_S{1,2,3}.md` |
| `expected.hard_constraints` | ✅ | L1 rule filter 必须全过的 deterministic 约束 |
| `expected.soft_rubric` | ✅ | L2 judge 每维 `min_score`（1-5）+ `behavior` 描述 |
| `expected.anti_patterns` | optional | 显式不允许的行为，judge prompt 会列出来 |

### 冻结原则（HARD）

Fixture 一旦 commit，`input.*` **不可再改**。要测新场景就建新 fixture。这是 regression test —— input 漂移 = signal 漂移 = 无法对比。

如果发现 fixture 标注有 bug（`expected` 写错），允许改 `expected.*` + 在 commit message 解释原因，但 `input.*` 永远 frozen。

## L2: Judge graph 设计

### 新增模块

```
src/coach/graphs/evaluation/
    __init__.py
    graph.py                     # build_evaluation_graph(...)
    judge_s1.py                  # S1 judge node + prompt
    judge_s2.py                  # S2 judge node + prompt
    judge_s3.py                  # S3 judge node + prompt
    state.py                     # EvalState TypedDict
src/coach/schemas/
    evaluation.py                # JudgeScore, EvalReport (通用)
src/stride_server/coach_adapters/
    eval_runner.py               # 加载 fixture，注入 LLM，跑 graph，写报告
scripts/
    eval_coach.py                # CLI entrypoint
```

`coach/graphs/evaluation/*` 受 import-linter 约束 —— 只允许 import `coach.*`、`stride_core.*`、`langgraph`、`langchain-*`、`pydantic`。具体 LLM 实例化、fixture 加载、DB context 重建走 adapter 层。

### Flow

```
fixture_input → load_frozen_context → generate (复用 build_generation_graph)
                                          ↓
                                       final_artifact
                                          ↓
                                       judge_node ←─ judge_prompt（含 fixture.expected）
                                          ↓
                                       JudgeScore + per-axis rationale
                                          ↓
                                       aggregate_node → EvalReport
```

- `load_frozen_context` 把 fixture 的冻结 input 注入成 `GenState.context`，**不调任何 DB**。这是 fixture 冻结原则的执行点。
- generate 阶段完全复用 `build_generation_graph`（**S2 已可复用；S1 Phase 1 refactor 后可复用 —— 在此之前 eval 对 S1 不可用**）—— 同样的 rule_filter 同样的 reviewer，eval 不是替换 pipeline 而是套一层 judge。S3 直接走 conversation graph。
- judge_node 调 GPT-5.4（**不**用 Claude Opus 4.7，避免 reviewer↔judge self-bias）。

### JudgeScore schema (通用)

```python
# src/coach/schemas/evaluation.py
from typing import Literal
from pydantic import BaseModel, Field

# Axis 是 scope-specific —— S1/S2/S3 各自的 axis Literal 在 scope-specific 模块定义
# JudgeScore 用 str 持 axis name 而不是固定 Literal，保持 schema 通用

class AxisScore(BaseModel):
    axis: str                       # axis name (scope-specific enum 在 judge_s{1,2,3}.py 校验)
    score: int | None = Field(default=None, ge=1, le=5)  # None = N/A
    rationale: str
    matches_expected: bool          # axis 是否达到 fixture.expected.soft_rubric[axis].min_score；N/A 时 True
    anti_patterns_hit: list[str] = []

class JudgeScore(BaseModel):
    fixture_id: str
    scope: Literal["s1", "s2", "s3"]
    axes: list[AxisScore]
    overall_verdict: Literal["pass", "marginal", "fail"]
    overall_rationale: str
    judge_model: str
    judge_prompt_version: str       # 改 prompt 就 bump（"v1" → "v2"），让历史 score 可比

class EvalReport(BaseModel):
    run_id: str                     # ISO timestamp + git sha
    git_sha: str
    fixtures_total: int
    fixtures_passed: int            # all hard + every axis >= min_score
    fixtures_marginal: int          # hard pass 但有 axis < min_score
    fixtures_failed: int            # hard 违反 或 schema_validity < 5
    per_axis_avg: dict[str, float]  # 聚合时跳过 score=None 的 axis；分母只算有效样本数
    per_fixture: list[JudgeScore]
```

`judge_prompt_version` 是关键 —— prompt 改了等于"换了考官"，旧分数和新分数不能直接比。用户改 prompt 时应当手动 bump version、重跑所有 fixture、把新报告作为新 baseline 单独存档，不要混合两个版本的分数做趋势分析。

## CLI 用法

```bash
# 跑某一 scope 的全部 fixture
PYTHONIOENCODING=utf-8 python -m coach.eval --scope s1

# 跑指定 fixture
python -m coach.eval --fixture s1-summer-base-build

# 跑全部 scope
python -m coach.eval --scope all

# 只跑 L1（不调 LLM，快速反馈 / 改 rule_filter 后立即验证）
python -m coach.eval --scope all --layer L1

# 输出报告
# - stdout: 表格汇总
# - file: .omc/eval/reports/{run_id}.json (EvalReport)
# - file: .omc/eval/reports/{run_id}.md  (human-readable diff vs 上次)
```

退出码：
- `0` = 所有 fixture pass
- `1` = 有 fail
- `2` = 有 marginal 但没 fail
- `64` = LLM 不可用 / config 缺失（区别于 eval failure）

## L3: Human spot-check 流程

用户随时挑某条 fixture 跑 `python -m coach.eval --fixture <id> --emit-spot-check`，得到一个 markdown：

```
tests/fixtures/coach_eval/spot_checks/2026-05-18_s2-hrv-drop-keep-volume.md
---
fixture_id: s2-hrv-drop-keep-volume
run_at: 2026-05-18T10:00:00+08:00
generated_plan_json: <full>
l2_judge_score: <full>
human_verdict: pending           # accept | reject | mixed
human_notes: |

```

用户填完 `human_verdict` + `human_notes` commit。Spot check 文件做两件事：
1. 如果人工 verdict 跟 L2 verdict 不一致 → 触发 judge prompt 调优（bump version）
2. 累积成"已审过的 ground truth" 数据集，未来可拿来 fine-tune judge

## 不在 v1 范围（明确 out of scope）

本文档只覆盖 **offline eval**。以下都是后续阶段的工作，v1 不做：

- **CI / PR 自动触发**：先用 CLI 手动跑，等 fixture 稳定、baseline 建立后再考虑 PR auto-run
- **Production runtime 接入**：runtime metrics、token cost dashboard、reviewer verdict 分布、prod 流量回放 —— 需要先有 prod 流量信号
- **A/B 多模型 variant 评估**：`multi-variant.md` 已有架构，eval framework v1 暂不复用它
- **User-facing eval（"喜欢/不喜欢" 按钮）**：先把内部 eval 跑稳，再考虑 thumbs UI
- **Fine-tune judge / self-improvement loop**：等 `spot_checks/` 累到 ≥ 50 条再说

## Why not X

| 选择 | 拒绝的原因 |
|------|-----------|
| 复用 reviewer (Claude Opus 4.7) 当 judge | Self-confirmation bias —— reviewer 已经在 pipeline 里 sign-off 过一次 |
| Baseline 用 `live_local_db` mode（直接读真实 DB） | live mode 是 exploratory 工具：探索性看真实数据下 plan 方向、采样生成 fixture 候选。**不能作 baseline** —— SQLite 同步 / 用户继续训练让 cutoff 之后的 row 漂移，跨天分数不可比。Baseline 必须用 `frozen_fixture` mode（纯读 commit 过的 fixture inline context）。详见 [`coach-eval_S1.md`](coach-eval_S1.md) § S1 Offline Test Modes |
| 用 LangSmith / Phoenix 当 eval backend | 先 minimal local JSON，等 fixture > 30 条 + 用户每天跑再考虑 |
| 在 Azure App Insights 直接跑 eval | 那是 prod observability，不是 dev-loop |
| 跳过 L1 直接做 L2 | L1 30 秒跑完且 $0；L2 需要 LLM call，慢且贵 —— 没理由让 LLM judge 浪费 budget 给 schema invalid 的 draft |
| Judge 输出自由文本 | 自由文本无法 aggregate、无法 regression diff —— 必须结构化 1-5 分 |
| S1 / S2 / S3 用同一套 axis | 三个 scope 训练学语义差太多 —— S1 看赛季结构 / 目标达成可行性；S2 看周内 HRV 响应；S3 看 hallucination —— 共享 axis 会让分数失去信息 |

## 跟其他 doc 的关系

- `coach-agent.md` —— eval framework **不**改变 coach 架构、不动 Pattern X/Y/A/P，纯 read-only 加一层
- `plan-json-schema.md` —— S2 L1 `schema_validity` 就是跑 `WeeklyPlan.from_dict`，和 plan reparse 用同一个 gate
- `multi-variant.md` —— variants 评估目前由用户在 UI 4 维 slider 完成，跟 fixture-based eval 是两条独立轨道；未来可能合并，v1 不强求
- `working-model.md` —— eval 在 local author 环境跑（Claude Code 这边），不进 prod path
