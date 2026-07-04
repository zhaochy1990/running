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

JUDGE_PROMPT_VERSION = "s1-v8"


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
- season_structure           — base / build / peak / taper 阶段是否齐全、顺序合理、时长平衡；recovery phase 只在 season_window 覆盖赛后日期时才要求出现
- goal_realism               — plan 路径能否合理通向 target_race.goal_time_s（考虑 PB 起点、phase 长度、peak 周量）；不现实时是否有显式说明
- peak_timing                — peak→taper 边界是否与比赛日期匹配；FM 最大专项彩排可在 race - 3..4 weeks，只要随后有吸收周且 peak phase 在 race - 2 weeks 左右结束
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
- FM 评估中不要把“最大 30K+ 专项彩排在 race - 4 weeks 且后一周 deload”判为 peak_timing 缺陷；这通常是合理吸收安排。peak_timing 主要看 peak phase 的结束点、taper phase 长度、race 周是否清爽
- 如果 fixture.season_window.end_date 等于或早于 target_race.race_date，不要因为缺少赛后 recovery phase 扣 season_structure 分；此时赛后恢复不在本次 master plan 的时间窗口内。只要求赛前结构（base/build/peak/taper）完整、顺序合理，并且 plan/principles 可提到赛后恢复建议。
- schema_validity 只评估可解析结构与字段一致性。已完成的 carry-over phase 若标记 `is_completed:true`，它应只作为时间线背景，不要求也不鼓励为该阶段输出 weeks；不要因为 weeks 从当前 active phase 的 week_index（如第 9 周）开始而扣 schema_validity 分。
- 如果 plan 同时输出 `weeks` 与 `weekly_key_sessions` 且二者内容一致，这是兼容旧/新字段的正常冗余，不是 schema_validity 缺陷。
- volume_progression 评估周量递增时，应像 L1 一样跨过 recovery/taper 周，比较相邻 load weeks。典型 `74 -> 44 recovery -> 81` 是从 74 到 81 的约 9.5% 递增，不能按 44 到 81 误判为大跳。recovery 周高值若是对应 phase `weekly_distance_km_low` 的 70-80%（如 build low=55, recovery high=44；peak low=70, recovery high=56），这是正确降量，不要因“看起来偏低”扣 volume_progression 分。若 L1 `weekly_volume_ramp` 和 `long_run_distance_share` 都通过、且恢复周后第一个 load week 相比前一个 load week 没超过 10%，不要仅因 recovery→load 的视觉回弹扣到 4。伤后 FM 回归若从 30-34km 起步、相邻 load week 高值均 ≤10%、每第4周 recovery、非例外负荷周 ≤63km，且唯一 64-65km 周绑定 28km 彩排并随后恢复/减量，volume_progression 可给 5；不要因高50/低60km 平台期或“每4周约10%”理想字面扣到4。
- 春节/holiday race fixture 的 intermediate FM 例外：若 history peak around 58km、PB 3:15 -> 3:10 这类现实小幅 PB 目标，fixture 期望 peak `65-72km`。如果 plan 使用 controlled `65-72km` peak、最大长跑在出行窗口前、只有一个 protected `28km / 72km` max rehearsal，且随后 recovery/deload、假期 taper 短课友好，则不要仅因 72km 高于历史 58km 或 `28/72` 略高于 35% 把 volume_progression 从 5 扣到 4；这是该 fixture 的显式 holiday volume exception。
- data-gap/no-recent-race FM 例外：若 history peak around 52km、最近一年无比赛但历史 PB/周量可信，fixture 期望 peak `55-65km` 并用 tune-up 校准配速。若 plan 从约 30km 渐进到 55-65km，L1 `weekly_volume_ramp` / `long_run_distance_share` 已通过，且只有一个 protected `28km / 58-65km` FM rehearsal（约 60km 也可）并随后 recovery/deload，不要仅因 `28/60` 略高于 35% 把 volume_progression 从 5 扣到 4；这是数据缺口场景的保护性专项演练。
- goal_realism 评估有条件 A 目标时，要看完整 gate 组合，不要只看单个 HM/10K gate。若 plan 明确默认执行 B、A 需要目标等价 HM/10K gate + 30-32km MP rehearsal + injury/HR/RPE gate 同时通过，则稍慢 HM/10K 单项只能算观察门，不应单独扣 goal_realism。若同一个 plan 的 race milestone 写了更严格 A gate，而较早 HM/10K milestone 明确写作 B/观察门，应按组合 gate 判断，不要因观察门偏宽而扣 goal_realism。zhaochaoyi fixture 中，若 7月 HM 明确写作 `观察/B+` 且 race milestone/principle 用 `31km/22km MP + VO2max + HR/RPE + 跟腱` 开 A，可给 goal_realism=5。若用户提到 VO2max/RHR/高原/跟腱等信号，plan 在原则、milestone 或 monitoring trigger 中把这些作为 A 通道观察/降级条件即可；不要求每个信号都出现在 race milestone 的同一句话里。
- aggressive HM fixture 口径：PB `1:27:42` -> `1:20` 约 8.8%-9% 提升，本身激进但 fixture 明确写作 `aggressive but possible for advanced`。若 plan 明确写出提升幅度/风险、默认日常按 `1:21-1:22` 或 B 目标训练，并且 race milestone/principles 把 A=sub-1:20 绑定到 `10K<=37:00` + `20-22km` 长跑含 `12-16km HMP` + HR/RPE 正常等多重 gate，则 goal_realism 应给 5；不要仅因当前/近期 10K 约 40 分或“目标本身跨度大”把分数从 5 扣到 4。只有当 A 目标无条件化、10K gate 宽到 `<=38:00/39:00` 仍称 A-opening，或缺少 HMP 长跑/HR/RPE gate 时才扣分。
- MasterPlan schema 的 `goal.target_time` 只能容纳一个时间，常会填用户的 A 目标。若 plan 在 `training_principles`、race milestone 或 phase notes 中明确“默认执行 B 目标，A 目标仅在多重 gate 全过时开放”，不要因为 `goal.target_time` 仍是 A 目标而判定 A 目标无条件化，也不要仅因此把 goal_realism 从 5 降到 4。
- volume_progression 中，马拉松专项 peak 可以连续 2-3 个高位 load weeks，只要没有超过 L1 递增上限，并在最大 30-32km rehearsal 后安排 recovery/deload，或在高位块中插入 lighter long-run buffer（如 24-27km、无 MP）吸收；不要仅因“8-9月高位周多”扣分。
- 5K 计划受自然周 schema 约束时，race week 可能以一个周一到比赛日的 taper/race phase 表达。若该 phase 只有 `race` 一个结构化 key session、周量明显下降、且 `focus`/`rhythm`/`coach_note` 说明真正减量集中在赛前 3-5 天或只保留短激活，不要把“整周 phase”当作 7 天 taper 缺陷；season_structure 与 peak_timing 可以给 5。只有当 final week 安排额外结构化强度/长跑，或明确写成 7 天完整 taper，才因 5K taper 过长扣分。
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


def _clean_compact(value: object) -> object:
    """Drop empty/null/default noise from the judge-only compact view."""
    if isinstance(value, dict):
        out: dict[str, object] = {}
        for key, val in value.items():
            cleaned = _clean_compact(val)
            if cleaned is None or cleaned == [] or cleaned == {}:
                continue
            out[str(key)] = cleaned
        return out
    if isinstance(value, list):
        return [cleaned for item in value if (cleaned := _clean_compact(item)) is not None]
    return value


def _json_compact(obj: object) -> str:
    """Render prompt JSON exactly as the judge user message does."""
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _compact_generated_plan(generated_plan: dict) -> dict:
    """Build a smaller judge view without mutating the generated artifact.

    L2 judge needs the athlete-facing plan content, not UUID metadata or the
    legacy ``weekly_key_sessions`` alias that duplicates ``weeks``. Phase IDs
    are resolved to names so milestones/weeks remain understandable after IDs
    are removed.
    """
    if not isinstance(generated_plan, dict):
        return generated_plan

    phases = generated_plan.get("phases") or []
    phase_name_by_id = {
        str(phase.get("id")): phase.get("name")
        for phase in phases
        if isinstance(phase, dict) and phase.get("id") and phase.get("name")
    }

    compact: dict[str, object] = {}
    for key in (
        "goal", "start_date", "end_date", "total_weeks", "training_principles",
    ):
        if key in generated_plan:
            compact[key] = generated_plan[key]

    compact_phases: list[dict[str, object]] = []
    for phase in phases:
        if not isinstance(phase, dict):
            continue
        item = {
            key: phase.get(key)
            for key in (
                "name", "phase_type", "start_date", "end_date", "focus",
                "weekly_distance_km_low", "weekly_distance_km_high",
                "key_session_types", "rhythm", "key_workouts",
                "monitoring_triggers", "coach_note", "summary",
            )
            if key in phase
        }
        if phase.get("is_completed") is True:
            item["is_completed"] = True
        compact_phases.append(_clean_compact(item))
    compact["phases"] = compact_phases

    compact_milestones: list[dict[str, object]] = []
    for milestone in generated_plan.get("milestones") or []:
        if not isinstance(milestone, dict):
            continue
        item = {
            key: milestone.get(key)
            for key in (
                "type", "date", "target", "metric", "target_value", "comparator",
            )
            if key in milestone
        }
        phase_name = phase_name_by_id.get(str(milestone.get("phase_id")))
        if phase_name:
            item["phase_name"] = phase_name
        compact_milestones.append(_clean_compact(item))
    compact["milestones"] = compact_milestones

    compact_weeks: list[dict[str, object]] = []
    for week in generated_plan.get("weeks") or []:
        if not isinstance(week, dict):
            continue
        item = {
            key: week.get(key)
            for key in (
                "week_index", "week_start", "target_weekly_km_low",
                "target_weekly_km_high",
            )
            if key in week
        }
        if week.get("is_recovery_week") is True:
            item["is_recovery_week"] = True
        if week.get("is_taper_week") is True:
            item["is_taper_week"] = True
        phase_name = phase_name_by_id.get(str(week.get("phase_id")))
        if phase_name:
            item["phase_name"] = phase_name
        sessions: list[dict[str, object]] = []
        for session in week.get("key_sessions") or []:
            if not isinstance(session, dict):
                continue
            sessions.append(_clean_compact({
                key: session.get(key)
                for key in ("type", "distance_km", "duration_min", "intensity", "purpose")
                if key in session
            }))
        item["key_sessions"] = sessions
        compact_weeks.append(_clean_compact(item))
    compact["weeks"] = compact_weeks

    return _clean_compact(compact)


def _build_user_message(generated_plan: dict, fixture: dict) -> str:
    inp = fixture.get("input") or {}
    user_profile = inp.get("user_profile") or {}
    season_window = inp.get("season_window") or {}
    training_history = inp.get("training_history_summary") or {}
    user_intent_md = inp.get("user_intent_md") or "<autonomous: no user intent>"
    expected = fixture.get("expected") or {}
    scenario = fixture.get("description", "")

    compact_plan = _compact_generated_plan(generated_plan)

    return (
        f"<scenario>\n{scenario}\n</scenario>\n\n"
        f"<user_profile>\n{_json_compact(user_profile)}\n</user_profile>\n\n"
        f"<season_window>\n{_json_compact(season_window)}\n</season_window>\n\n"
        f"<training_history>\n{_json_compact(training_history)}\n</training_history>\n\n"
        f"<user_intent>\n{user_intent_md}\n</user_intent>\n\n"
        f"<expected>\n{_json_compact(expected)}\n</expected>\n\n"
        "<draft_master_plan_compact note=\"UUID metadata, null fields, and "
        "duplicate weekly_key_sessions identical to weeks are omitted; evaluate "
        "the generated plan content below\">\n"
        f"{_json_compact(compact_plan)}\n</draft_master_plan_compact>\n"
    )


def build_s1_judge_prompt_metadata(generated_plan: dict, fixture: dict) -> dict[str, int]:
    """Return prompt-size metadata for the exact S1 judge prompt inputs."""
    compact_plan = _compact_generated_plan(generated_plan)
    return {
        "judge_system_prompt_chars": len(S1_JUDGE_SYSTEM_PROMPT),
        "judge_user_prompt_chars": len(_build_user_message(generated_plan, fixture)),
        "judge_compact_plan_chars": len(_json_compact(compact_plan)),
        "judge_original_plan_chars": len(_json_compact(generated_plan)),
    }


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
