"""LangChain orchestration for the STRIDE coach agent."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Literal

from stride_core.db import Database
from stride_core.plan_spec import PlannedNutrition, WeeklyPlan
from stride_core.source import DataSource

from ..deps import parse_week_dates
from .context import load_coach_context, summarize_context
from .model import get_chat_model, get_generated_by


SYSTEM_PROMPT = """你是 STRIDE 的高级马拉松训练 Agent。

你要基于用户的真实训练数据、健康负荷、周计划、反馈、InBody 和能力模型给出高质量建议。
默认使用中文，语气直接、专业、可执行。
这是成人耐力跑训练与健康生活方式建议，不是医疗诊断或治疗。你可以生成安全、保守、循序渐进的跑步/力量/营养/恢复计划；如果出现疼痛、伤病风险或异常健康信号，要降低训练负荷并建议必要时咨询医生或物理治疗师，不要直接拒答。

关键规则：
- 不虚构数据；没有数据就明确说缺失。
- 判断训练状态时综合 fatigue、ATI/CTI、TSB、RHR、HRV、近期训练、用户反馈，不依赖单一指标。
- 周计划必须覆盖跑步、力量/灵活性、营养与恢复。
- 不要写"已推送到 COROS 手表的训练"章节。
- 临时调整计划必须保守、说明原因，并保留训练周期目标。
- 除非调用 apply 接口，所有计划调整都只是草稿/预览，不代表已保存。
- 如果 sync 失败或用户未登录 COROS，要说明数据可能不是最新。
"""


# ─────────────────────────────────────────────────────────────────────────────
# Structured-plan prompt fragments
# ─────────────────────────────────────────────────────────────────────────────


_STRUCTURED_SCHEMA_HINT = """
# 结构化输出要求 (除 markdown 外必须追加)

最后必须再输出一个 ```json``` 代码块,内容是与本周 markdown 等价的结构化计划,
schema 要与 stride_core/plan_spec.WeeklyPlan.to_dict() 一致:

```jsonc
{
  "schema": "weekly-plan/v1",
  "week_folder": "<本周文件夹名,例如 2026-04-20_04-26(W0)>",
  "sessions": [
    {
      "schema": "plan-session/v1",
      "date": "YYYY-MM-DD",
      "session_index": 0,        // 0 = 当天第一节,如有早晚双 session 第二节为 1
      "kind": "run" | "strength" | "rest" | "cross" | "note",
      "summary": "<短描述,例如 6×800m 间歇>",
      "spec": null | <NormalizedRunWorkout JSON> | <NormalizedStrengthWorkout JSON>,
      "notes_md": null | "<可选,该 session 的 markdown 注释>",
      "total_distance_m": null | number,
      "total_duration_s": null | number,
      "scheduled_workout_id": null
    }
  ],
  "nutrition": [
    {
      "schema": "plan-nutrition/v1",
      "date": "YYYY-MM-DD",
      "kcal_target": number | null,
      "carbs_g": number | null,
      "protein_g": number | null,
      "fat_g": number | null,
      "water_ml": number | null,
      "meals": [
        {"name": "早餐", "time_hint": "7:30", "kcal": 600, "carbs_g": 80,
         "protein_g": 30, "fat_g": 15, "items_md": "燕麦 80g + 鸡蛋 2 个"}
      ],
      "notes_md": null | "<可选>"
    }
  ],
  "notes_md": null | "<本周整体注释>"
}
```

NormalizedRunWorkout 形如:
```jsonc
{
  "schema": "run-workout/v1",
  "name": "Easy 10K",
  "date": "YYYY-MM-DD",
  "note": null,
  "blocks": [
    {
      "repeat": 1,
      "steps": [
        {"step_kind": "work",
         "duration": {"kind": "distance_m", "value": 10000},
         "target": {"kind": "pace_s_km", "low": 360, "high": 330},
         "note": null}
      ]
    }
  ]
}
```

间歇用 RepeatGroup 表示,如 6×800m @ 4:00/km + 60s 慢跑:
```jsonc
{
  "schema": "run-workout/v1",
  "name": "6x800m",
  "date": "YYYY-MM-DD",
  "blocks": [
    {"repeat": 6, "steps": [
      {"step_kind": "work",
       "duration": {"kind": "distance_m", "value": 800},
       "target": {"kind": "pace_s_km", "low": 245, "high": 235}},
      {"step_kind": "recovery",
       "duration": {"kind": "time_s", "value": 60},
       "target": {"kind": "open"}}
    ]}
  ]
}
```

如果 work step 同时给了**配速目标 + HR 上限**(例如 "3K×4 @ 4:05-4:10/km, HR ≤167"),
配速进 `target`,HR 上限单独写到 `hr_cap_bpm` 字段(整数 bpm)。
**不要**把 HR 上限放在 note 文本里——下游 UI / 强度分类 / 推送翻译都看不到 note 里的数字。
```jsonc
{
  "step_kind": "work",
  "duration": {"kind": "distance_m", "value": 3000},
  "target": {"kind": "pace_s_km", "low": 250, "high": 245},
  "hr_cap_bpm": 167,
  "note": "硬下限 4:05;HR 超 167 立即退到 4:10"
}
```
仅当计划没显式 HR 上限时,才省略 `hr_cap_bpm`(不写 / 写 null 都行)。
warmup / cooldown / recovery 步骤通常不写 hr_cap_bpm,即使有 HR 区间——
那些 HR 区间是热身/放松的*目标*,放进 `target`(kind=hr_bpm)。

变速跑 (warmup → 多段不同配速 work → cooldown) 用单 block + 多 step,repeat=1:
```jsonc
{"blocks": [
  {"repeat": 1, "steps": [
    {"step_kind": "warmup", "duration": {"kind": "distance_m", "value": 1500},
     "target": {"kind": "pace_s_km", "low": 420, "high": 380}},
    {"step_kind": "work", "duration": {"kind": "distance_m", "value": 2000},
     "target": {"kind": "pace_s_km", "low": 280, "high": 260}},
    {"step_kind": "work", "duration": {"kind": "distance_m", "value": 2000},
     "target": {"kind": "pace_s_km", "low": 260, "high": 250}},
    {"step_kind": "cooldown", "duration": {"kind": "distance_m", "value": 1500},
     "target": {"kind": "pace_s_km", "low": 420, "high": 380}}
  ]}
]}
```

NormalizedStrengthWorkout 形如:
```jsonc
{
  "schema": "strength-workout/v1",
  "name": "Core 30min",
  "date": "YYYY-MM-DD",
  "exercises": [
    {"canonical_id": "plank_basic", "display_name": "平板支撑",
     "sets": 3, "target_kind": "time_s", "target_value": 45, "rest_seconds": 30}
  ]
}
```

双 session 日 (早跑 + 晚力量) 用同一 date 但 session_index=0/1 两条:
```jsonc
{"sessions": [
  {"date": "2026-04-22", "session_index": 0, "kind": "run", "summary": "Easy 10K", "spec": {...}},
  {"date": "2026-04-22", "session_index": 1, "kind": "strength", "summary": "Core 30min", "spec": {...}}
]}
```

注意:
- date 全部用 ISO YYYY-MM-DD,不能用 "周一"/"04/22" 之类
- 配速单位是 seconds-per-km,不是 min/km。例如 4:00/km = 240
- 时长单位是秒,距离单位是米
- 当 kind=rest/cross/note 时 spec 必须是 null
- 当配速尚未确定 (e.g. "Easy,配速 TBD") 时 spec 也可以是 null,session 仍按 kind=run 标记 (aspirational)
- 餐次的 kcal 总和应当与 daily kcal_target 偏离不超过 10%
"""


_PARSE_PROMPT = """你需要把一份已经存在的 markdown 训练计划反向解析成结构化 JSON。
仅输出一个 ```json``` 代码块,不要输出 markdown 摘要、不要解释。
如果某天的 session 信息不全或无法识别,允许把 spec 设成 null,kind 用最贴切的枚举,summary 写出可读描述。
schema 与 weekly_plan 任务一致。
"""


# ─────────────────────────────────────────────────────────────────────────────
# Result type
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class AgentResult:
    content: str
    model: str
    context_summary: dict[str, Any]
    sync: dict[str, Any]
    # New (Step 2): structured plan parsed out of the model's JSON code block.
    # `None` when the task does not request structured output, when no JSON was
    # emitted, or when the JSON failed schema validation. `parse_error` carries
    # a human-readable reason in the failure case.
    structured: WeeklyPlan | None = None
    parse_error: str | None = None
    source: str = "fresh"
    llm_calls: int = 0
    schema_version: int | None = None

    # Backwards-compat alias used by existing callers/tests.
    @property
    def content_md(self) -> str:
        return self.content


def _message_content(response: Any) -> str:
    content = getattr(response, "content", response)
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                parts.append(str(item.get("text") or item.get("content") or ""))
            else:
                parts.append(str(item))
        return "\n".join(p for p in parts if p).strip()
    return str(content or "").strip()


def _invoke_model(messages: list[tuple[str, str]], chat_model: Any | None = None) -> str:
    model = chat_model or get_chat_model()
    response = model.invoke(messages)
    return _message_content(response)


def _context_json(context: dict[str, Any]) -> str:
    return json.dumps(context, ensure_ascii=False, default=str)


# ─────────────────────────────────────────────────────────────────────────────
# JSON-block extraction + structured parse
# ─────────────────────────────────────────────────────────────────────────────


_JSON_BLOCK_RE = re.compile(r"```(?:json|jsonc)?\s*(\{.*?\})\s*```", re.DOTALL | re.IGNORECASE)


def _extract_last_json_block(text: str) -> str | None:
    """Return the contents of the *last* fenced ```json``` block, or None."""
    matches = _JSON_BLOCK_RE.findall(text)
    if not matches:
        return None
    return matches[-1]


def _strip_json_block(text: str) -> str:
    """Remove fenced ```json``` blocks from ``text``.

    Used for `task=weekly_plan` so the markdown stored as `content_md` is the
    pure plan markdown — the JSON code block is metadata, not authored content.
    """
    return _JSON_BLOCK_RE.sub("", text).rstrip()


def _validate_nutrition_macros(plan: WeeklyPlan) -> WeeklyPlan:
    """Annotate any PlannedNutrition where meals.kcal totals deviate >10% from
    kcal_target. The row is *not* dropped; structured_status still reflects
    schema validation only.
    """
    if not plan.nutrition:
        return plan
    new_nutrition = []
    changed = False
    for n in plan.nutrition:
        if n.kcal_target is None or not n.meals:
            new_nutrition.append(n)
            continue
        meal_kcals = [m.kcal for m in n.meals if m.kcal is not None]
        if not meal_kcals:
            new_nutrition.append(n)
            continue
        total = sum(meal_kcals)
        target = max(n.kcal_target, 1.0)
        if abs(total - n.kcal_target) / target > 0.10:
            warning = (
                f"[parse_warning] meals 总和 {total:.0f} kcal 与 daily "
                f"kcal_target {n.kcal_target:.0f} 偏离 >10%"
            )
            existing = (n.notes_md or "").rstrip()
            new_notes = f"{existing}\n{warning}".strip() if existing else warning
            new_nutrition.append(
                PlannedNutrition(
                    date=n.date,
                    kcal_target=n.kcal_target,
                    carbs_g=n.carbs_g,
                    protein_g=n.protein_g,
                    fat_g=n.fat_g,
                    water_ml=n.water_ml,
                    meals=n.meals,
                    notes_md=new_notes,
                )
            )
            changed = True
        else:
            new_nutrition.append(n)
    if not changed:
        return plan
    return WeeklyPlan(
        week_folder=plan.week_folder,
        sessions=plan.sessions,
        nutrition=tuple(new_nutrition),
        notes_md=plan.notes_md,
    )


def _validate_session_dates(
    plan: WeeklyPlan, folder: str | None,
) -> str | None:
    """Reject plans whose session dates fall outside the week's date range.

    Why: the LLM occasionally hallucinates dates from outside the week (e.g.
    placing a session in next week's Sunday); without this guard, a prompt
    injection could also coerce sessions onto far-future dates and starve
    the calendar UI. Returns ``None`` if all dates are within bounds, or a
    human-readable reason on the first violation.

    When ``folder`` is ``None`` or unparseable we skip the check — same
    failure-tolerant posture as ``parse_week_dates`` callers elsewhere.
    """
    if not folder:
        return None
    bounds = parse_week_dates(folder)
    if bounds is None:
        return None
    d_from, d_to = bounds
    for s in plan.sessions:
        if not (d_from <= s.date <= d_to):
            return (
                f"session date {s.date!r} outside week {folder!r} "
                f"({d_from} .. {d_to})"
            )
    return None


def _parse_structured(
    raw: str, *, folder: str | None = None,
) -> tuple[WeeklyPlan | None, str | None]:
    """Pull the last ```json``` block out of ``raw`` and validate it.

    Returns ``(plan, None)`` on success or ``(None, reason)`` on any failure.
    Failure reasons cover: no JSON block found, malformed JSON, schema
    rejection by ``WeeklyPlan.from_dict`` (KeyError / ValueError /
    TypeError), or any session date falling outside the parent week's
    range (when ``folder`` is supplied).
    """
    blob = _extract_last_json_block(raw)
    if blob is None:
        return None, "no JSON code block in model output"
    try:
        data = json.loads(blob)
    except json.JSONDecodeError as e:
        return None, f"invalid JSON: {e}"
    try:
        plan = WeeklyPlan.from_dict(data)
    except (KeyError, ValueError, TypeError) as e:
        return None, f"schema validation failed: {e}"
    date_violation = _validate_session_dates(plan, folder)
    if date_violation is not None:
        return None, date_violation
    plan = _validate_nutrition_macros(plan)
    return plan, None


# ─────────────────────────────────────────────────────────────────────────────
# Top-level entry point
# ─────────────────────────────────────────────────────────────────────────────


_TaskName = Literal["chat", "weekly_plan", "plan_adjustment", "parse_plan"]


def run_agent(
    user: str,
    *,
    task: _TaskName,
    user_message: str,
    folder: str | None = None,
    source: DataSource | None = None,
    sync_before: bool = True,
    chat_model: Any | None = None,
    md_text: str | None = None,
) -> AgentResult:
    # `parse_plan` is a pure markdown→JSON transform; it does not need the
    # full coach context (no DB sync, no health rollup). All other tasks load
    # the standard context.
    if task == "parse_plan":
        if md_text is None:
            raise ValueError("task=parse_plan requires md_text")
        if folder is None:
            raise ValueError("task=parse_plan requires folder")
        messages = [
            ("system", SYSTEM_PROMPT),
            (
                "user",
                "\n\n".join(
                    [
                        f"# 任务类型\n{task}",
                        f"# 周文件夹\n{folder}",
                        f"# 指令\n{_PARSE_PROMPT}",
                        f"# 结构化要求\n{_STRUCTURED_SCHEMA_HINT}",
                        f"# 待解析的 markdown\n{md_text}",
                    ]
                ),
            ),
        ]
        raw = _invoke_model(messages, chat_model=chat_model)
        plan, parse_error = _parse_structured(raw, folder=folder)
        return AgentResult(
            content="",
            model=get_generated_by(),
            context_summary={},
            sync={},
            structured=plan,
            parse_error=parse_error,
        )

    context = load_coach_context(user, folder=folder, source=source, sync_before=sync_before)
    context_summary = summarize_context(context)

    if task == "weekly_plan":
        instruction = """请生成一份完整的本周训练计划 Markdown。
要求：
1. 明确周目标、疲劳/负荷判断、跑步安排、力量/灵活性、营养与恢复。
2. 每天给出训练内容、强度/RPE、配速或心率目标、注意事项。
3. 结合当前训练阶段、近期训练执行、健康负荷、InBody 和用户目标。
4. 不要包含"已推送到 COROS 手表的训练"章节。
5. 输出可直接保存为 plan.md 的 Markdown,然后再追加结构化 JSON 代码块。"""
    elif task == "plan_adjustment":
        instruction = """请根据用户反馈生成"临时调整后的完整周计划"草稿。
要求：
1. 先保护恢复和伤病风险，再保留关键训练目的。
2. 调整幅度要保守，并说明哪些训练被降级、替换或移动。
3. 输出完整 Markdown，可用于用户确认后保存为 DB 计划覆盖。
4. 不要声称已经保存；这是草稿。"""
    else:
        instruction = """请回答用户的日常训练问题。
如果问题涉及当前状态、疲劳、负荷、是否能上强度，必须基于同步状态和上下文给出判断。
需要计划调整时，给出建议和草稿方向，但提醒用户需要确认后再保存。"""

    user_parts = [
        f"# 任务类型\n{task}",
        f"# 指令\n{instruction}",
        f"# 用户输入\n{user_message}",
        f"# STRIDE 上下文 JSON\n{_context_json(context)}",
    ]
    if task == "weekly_plan":
        user_parts.append(f"# 结构化输出说明\n{_STRUCTURED_SCHEMA_HINT}")

    messages = [
        ("system", SYSTEM_PROMPT),
        ("user", "\n\n".join(user_parts)),
    ]
    raw = _invoke_model(messages, chat_model=chat_model)

    structured: WeeklyPlan | None = None
    parse_error: str | None = None
    content = raw
    if task == "weekly_plan":
        structured, parse_error = _parse_structured(raw, folder=folder)
        content = _strip_json_block(raw)

    return AgentResult(
        content=content,
        model=get_generated_by(),
        context_summary=context_summary,
        sync=context.get("sync") or {},
        structured=structured,
        parse_error=parse_error,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Persistence
# ─────────────────────────────────────────────────────────────────────────────


_StructuredSource = Literal["fresh", "backfilled", "parse_failed", "authored"]


def apply_weekly_plan(
    user: str,
    folder: str,
    content: str,
    *,
    generated_by: str | None = None,
    structured: WeeklyPlan | None = None,
    structured_source: _StructuredSource = "fresh",
    commit: bool = True,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    """Persist a weekly plan markdown + (optional) structured layer.

    Markdown always lands in `weekly_plan.content_md` (the canonical source).
    When ``structured`` is supplied we additionally upsert the planned_session
    + planned_nutrition rows for ``folder`` and stamp ``structured_status``
    (``fresh`` for live LLM output, ``backfilled`` for historical re-parse).
    When ``structured`` is ``None`` we mark the row ``parse_failed`` so the UI
    can show a "重新解析" affordance.

    Default behavior (``commit=True, conn=None``): all writes go through a
    single SQLite transaction (``with db._conn:`` block + ``commit=False``
    on each helper). The block commits on clean exit and rolls back on any
    exception, so a mid-call failure never leaves partial state — either
    every row landed or none did.

    Promote/select callers pass ``commit=False, conn=<dedicated immediate-txn>``
    so this whole apply lives inside the caller's larger transaction; the
    caller is then responsible for the final ``commit()``/``rollback()``.
    """
    db = Database(user=user)
    try:
        author = generated_by or get_generated_by()
        md_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()

        def _do_writes(_c: sqlite3.Connection | None) -> None:
            db.upsert_weekly_plan(folder, content, generated_by=author,
                                  commit=False, conn=_c)
            if structured is not None:
                db.upsert_planned_sessions(
                    folder, list(structured.sessions), commit=False, conn=_c,
                )
                db.upsert_planned_nutrition(
                    folder, list(structured.nutrition), commit=False, conn=_c,
                )
                db.set_weekly_plan_structured_status(
                    folder, status=structured_source,
                    parsed_from_md_hash=md_hash, commit=False, conn=_c,
                )
            else:
                # Wipe any prior structured rows so we don't leave stale
                # data claiming to belong to this week.
                db.upsert_planned_sessions(folder, [], commit=False, conn=_c)
                db.upsert_planned_nutrition(folder, [], commit=False, conn=_c)
                db.set_weekly_plan_structured_status(
                    folder, status="parse_failed",
                    parsed_from_md_hash=md_hash, commit=False, conn=_c,
                )

        if conn is not None:
            # Caller (e.g. promote/select) owns the txn boundary on the
            # dedicated immediate-txn connection.
            _do_writes(conn)
        elif commit:
            with db._conn:
                _do_writes(None)
        else:
            # commit=False with no conn = run on db._conn but do not
            # commit. Caller is responsible for committing db._conn later.
            _do_writes(None)

        row = db.get_weekly_plan_row(folder)
        return dict(row) if row else {"week": folder, "content_md": content, "generated_by": author}
    finally:
        db.close()
