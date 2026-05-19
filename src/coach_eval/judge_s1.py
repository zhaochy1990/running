"""S1 master plan judge — see ``docs/coach-eval_S1.md`` § S1 L2 Judge Axes.

Builds a :class:`JudgeScore` from a generated MasterPlan dict + fixture
expectation. Uses a langchain ``BaseChatModel`` so the actual provider
binding (GPT-5.4 via AzureChatOpenAI) lives in the adapter / runtime layer,
not in ``coach.*``.

Prompt version bumps (``JUDGE_PROMPT_VERSION``) invalidate old baselines —
the runner stores the version alongside each ``JudgeScore`` so a future
``diff`` command can refuse to compare across versions.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from typing import Literal, get_args

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage

from coach.runtime.messages import extract_text

from .schemas import AxisScore, JudgeScore

logger = logging.getLogger(__name__)

JUDGE_PROMPT_VERSION = "s1-v1"


# S1 axis set (9 axes — 8 + request_handling, which is N/A when no user_intent).
S1Axis = Literal[
    "schema_validity",
    "season_structure",
    "goal_realism",
    "peak_timing",
    "volume_progression",
    "frequency_respect",
    "injury_safety",
    "phase_nutrition_strategy",
    "request_handling",
]
S1_AXES: tuple[str, ...] = get_args(S1Axis)


S1_JUDGE_SYSTEM_PROMPT = """你是 STRIDE 训练 master plan 评估员。

给定一个生成出的 master plan，对以下 9 个 axis 各打 1-5 分（或 null = N/A）：

- schema_validity            — MasterPlan 数据结构是否完整、字段类型是否正确
- season_structure           — base / build / peak / taper / recovery 阶段是否齐全、顺序合理、时长平衡
- goal_realism               — plan 路径能否合理通向 target_race.goal_time_s（考虑 PB 起点、phase 长度、peak 周量）；不现实时是否有显式说明
- peak_timing                — peak phase 是否准确放在 race - 1..3 weeks，taper 长度是否与距离匹配（fm 通常 2 周，hm 1 周，10k 3-5 天）
- volume_progression         — 跨 phase 的周量曲线是否渐进，是否有合理 recovery week 间隔
- frequency_respect          — 每周训练频次是否尊重 weekly_run_days_max，在受限频次下保持质量 + 长课 + 基础
- injury_safety              — strategic-level 处理伤病约束（base 延长、禁用动作、回归曲线保守）
- phase_nutrition_strategy   — 营养策略是否随 phase 调整（base 维持，build 加 carb，peak carb-cycling，taper 维持，recovery 修复）
- request_handling           — 响应 user_intent_md；缺省时此 axis 输出 score=null（N/A）

评分约定：
- 5 = 完全满足该 axis 的所有评估点
- 4 = 满足主要评估点，少量小问题
- 3 = 满足部分但有明显缺失
- 2 = 多处不达标
- 1 = 严重违反 / 灾难
- null = axis 不适用（例如 user_intent_md 缺省时的 request_handling）

每个 axis 必须给出 1-2 句中文 rationale 解释打分理由。

overall_verdict 取值：
- "pass"     — 所有适用 axis ≥ fixture.expected.soft_rubric 中各 axis 的 min_score，且无 anti_pattern
- "marginal" — 部分 axis 低于 min_score 但训练上不致危险
- "fail"     — schema_validity invalid / 触发 anti_pattern / peak_timing < 3 / goal_realism < 2 / injury_safety < 3

S1 特别提醒：
- 评估时间尺度是月 / 赛季，不是周 —— 一两周细节波动可忽略
- target_race.goal_time_s 与 PB 的 gap 是 goal_realism 的核心判据
- 受限训练频次（weekly_run_days_max）是 HARD 约束，违反 = frequency_respect 必须 < 3
- "pushback" 是 S1 plan 的合理行为，不是缺陷
- 场景 2（db_history_weeks 低 + prs/hr_zones 是 user-reported）→ plan 必须信 user-reported 数据，不能因 DB 稀疏而降到"新手 base"才高分

输出必须是严格 JSON（用 `---BEGIN_JUDGE---` 和 `---END_JUDGE---` 哨兵包裹）：

---BEGIN_JUDGE---
{
  "axes": [
    {"axis": "schema_validity", "score": 5, "rationale": "...", "anti_patterns_hit": []},
    {"axis": "season_structure", "score": 4, "rationale": "...", "anti_patterns_hit": []},
    {"axis": "goal_realism", "score": 3, "rationale": "...", "anti_patterns_hit": []},
    {"axis": "peak_timing", "score": 4, "rationale": "...", "anti_patterns_hit": []},
    {"axis": "volume_progression", "score": 4, "rationale": "...", "anti_patterns_hit": []},
    {"axis": "frequency_respect", "score": 5, "rationale": "...", "anti_patterns_hit": []},
    {"axis": "injury_safety", "score": 5, "rationale": "...", "anti_patterns_hit": []},
    {"axis": "phase_nutrition_strategy", "score": 3, "rationale": "...", "anti_patterns_hit": []},
    {"axis": "request_handling", "score": null, "rationale": "user_intent_md 缺省 → N/A", "anti_patterns_hit": []}
  ],
  "overall_verdict": "pass",
  "overall_rationale": "1-3 句总体说明"
}
---END_JUDGE---

仅输出哨兵包裹的 JSON 块，不要其他文字。
"""


def _parse_judge_output(raw: str) -> dict | None:
    """3-tier parse: sentinel → fenced → balanced-braces."""
    m = re.search(r"---BEGIN_JUDGE---(.*?)---END_JUDGE---", raw, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1).strip())
        except json.JSONDecodeError:
            pass
    m = re.search(r"```(?:json)?\s*(.*?)```", raw, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1).strip())
        except json.JSONDecodeError:
            pass
    fb = raw.find("{")
    lb = raw.rfind("}")
    if fb != -1 and lb > fb:
        try:
            return json.loads(raw[fb : lb + 1])
        except json.JSONDecodeError:
            pass
    return None


def _model_name(llm: BaseChatModel) -> str:
    """Best-effort: surface a human-readable model id for the report."""
    for attr in ("deployment_name", "model_name", "model"):
        v = getattr(llm, attr, None)
        if v:
            return str(v)
    return type(llm).__name__


def _matches_expected(
    axis: str, score: int | None, expected: dict
) -> bool:
    """True iff ``score >= expected.soft_rubric[axis].min_score`` (or axis is N/A)."""
    if score is None:
        return True
    rubric = (expected.get("soft_rubric") or {}).get(axis)
    if not isinstance(rubric, dict):
        return True  # no min_score set → no constraint to violate
    min_score = rubric.get("min_score")
    if not isinstance(min_score, (int, float)):
        return True
    return score >= min_score


def _build_user_message(generated_plan: dict, fixture: dict) -> str:
    inp = fixture.get("input") or {}
    user_profile = inp.get("user_profile") or {}
    season_window = inp.get("season_window") or {}
    training_history = inp.get("training_history_summary") or {}
    user_intent_md = inp.get("user_intent_md") or "<autonomous: no user intent>"
    expected = fixture.get("expected") or {}
    scenario = fixture.get("description", "")

    def _json(obj: object) -> str:
        return json.dumps(obj, ensure_ascii=False, indent=2)

    return (
        f"<scenario>\n{scenario}\n</scenario>\n\n"
        f"<user_profile>\n{_json(user_profile)}\n</user_profile>\n\n"
        f"<season_window>\n{_json(season_window)}\n</season_window>\n\n"
        f"<training_history>\n{_json(training_history)}\n</training_history>\n\n"
        f"<user_intent>\n{user_intent_md}\n</user_intent>\n\n"
        f"<expected>\n{_json(expected)}\n</expected>\n\n"
        f"<draft_master_plan>\n{_json(generated_plan)}\n</draft_master_plan>\n"
    )


def make_s1_judge(llm: BaseChatModel) -> Callable[[dict, dict], JudgeScore]:
    """Build a :data:`JudgeFn` for S1 bound to ``llm``.

    Returns a ``(generated_plan, fixture) -> JudgeScore`` callable that:
    1. Renders the system + user prompt.
    2. Invokes ``llm`` synchronously.
    3. Parses the JSON output (3-tier sentinel / fenced / balanced).
    4. Validates each axis against ``S1_AXES`` (unknown axes silently dropped).
    5. Returns a structured :class:`JudgeScore`.

    Parse failures don't raise — they return a ``JudgeScore`` with
    ``overall_verdict='fail'`` and an explanatory rationale, so the eval
    suite reports a fail instead of crashing.
    """

    judge_model_label = _model_name(llm)

    def judge(generated_plan: dict, fixture: dict) -> JudgeScore:
        fixture_id = fixture.get("fixture_id", "<unknown>")
        expected = fixture.get("expected") or {}

        user_msg = _build_user_message(generated_plan, fixture)

        try:
            resp = llm.invoke(
                [
                    SystemMessage(content=S1_JUDGE_SYSTEM_PROMPT),
                    HumanMessage(content=user_msg),
                ]
            )
        except Exception:  # noqa: BLE001 — judge boundary; runner captures
            raise

        raw = extract_text(resp.content)

        parsed = _parse_judge_output(raw)
        if parsed is None:
            logger.warning(
                "judge_s1 parse failed fixture=%s raw_len=%d", fixture_id, len(raw)
            )
            return JudgeScore(
                fixture_id=fixture_id,
                scope="s1",
                axes=[],
                overall_verdict="fail",
                overall_rationale=f"judge_output_parse_failed (raw_len={len(raw)})",
                judge_model=judge_model_label,
                judge_prompt_version=JUDGE_PROMPT_VERSION,
            )

        axes_list: list[AxisScore] = []
        for ax in parsed.get("axes") or []:
            if not isinstance(ax, dict):
                continue
            axis_name = ax.get("axis")
            if axis_name not in S1_AXES:
                continue
            score = ax.get("score")
            if isinstance(score, bool):  # JSON parsing edge: True/False parsed as bool
                score = None
            if score is not None and not isinstance(score, int):
                try:
                    score = int(score)
                except (TypeError, ValueError):
                    score = None
            axes_list.append(
                AxisScore(
                    axis=axis_name,
                    score=score,
                    rationale=str(ax.get("rationale", "")),
                    matches_expected=_matches_expected(axis_name, score, expected),
                    anti_patterns_hit=list(ax.get("anti_patterns_hit") or []),
                )
            )

        verdict = parsed.get("overall_verdict", "fail")
        if verdict not in ("pass", "marginal", "fail"):
            verdict = "fail"

        return JudgeScore(
            fixture_id=fixture_id,
            scope="s1",
            axes=axes_list,
            overall_verdict=verdict,
            overall_rationale=str(parsed.get("overall_rationale", "")),
            judge_model=judge_model_label,
            judge_prompt_version=JUDGE_PROMPT_VERSION,
        )

    return judge
