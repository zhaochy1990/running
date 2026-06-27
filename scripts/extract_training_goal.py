"""LLM-driven training-goal extractor for the master-plan migration.

Replaces the hand-written ``DEFAULT_GOAL`` in migrate_master_plan.py: reads a
user's legacy authoring artifacts (``TRAINING_PLAN.md`` + ``profile.json``) and
asks the coach LLM (gpt-5.5, config/coach.local.toml) to emit a structured
``TrainingGoal``. The output is validated against the real ``TrainingGoal``
pydantic model so a malformed extraction fails loudly rather than silently
producing a bad goal. Generalises to any legacy user — no per-user hardcoding.

Run from the worktree that holds the user's data dir:
    PYTHONPATH=src STRIDE_CONFIG_ENV=local python scripts/extract_training_goal.py \
        --profile f10bc353-01ab-4db1-af9f-d9305ea9a532
    # -> prints validated goal JSON to stdout; --out writes it to a file.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# Repo layout: scripts/ is at repo root; src/ holds the packages.
_REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO / "src"))

SYSTEM_PROMPT = """\
你是 STRIDE 训练数据迁移助手。任务：从用户的 legacy 训练计划文档中，提取出**主目标赛事**的结构化信息，用于生成赛季 master plan。

只输出一个 JSON 对象，用哨兵包裹，哨兵之间是可被 json.loads() 解析的纯 JSON，不要任何额外文字：

---BEGIN_GOAL---
{
  "type": "race",
  "race_name": "<目标赛事全名，如 '2026 西安马拉松'>",
  "race_date": "<YYYY-MM-DD>",
  "race_distance": "<5K|10K|HM|FM|trail 之一>",
  "target_finish_time": "<H:MM:SS；纯完赛无目标成绩时用 null>",
  "weekly_training_days": <3-6 的整数，每周跑步天数>
}
---END_GOAL---

抽取规则：
- 文档若列多个赛事，选**主目标赛 / A 目标 / 目标赛事**；备选赛事忽略。
- race_date 必须是未来日期（今天之后）。若主目标赛日期已过，选文档中最近的未来目标赛。
- target_finish_time 取 **A 目标 / 主目标成绩**（H:MM:SS）；若只求完赛、无成绩目标，用 null。
- distance 映射：全程马拉松=FM，半程马拉松=HM，10公里=10K，5公里=5K，越野=trail。
- weekly_training_days：从计划的每周跑步频率推断（只数跑步日，不含纯力量/休息日），落在 3-6。
- 只依据文档内容，不要编造文档没有的赛事。"""


def _parse_goal(raw: str) -> dict:
    m = re.search(r"---BEGIN_GOAL---(.*?)---END_GOAL---", raw, re.DOTALL)
    blob = m.group(1).strip() if m else None
    if blob is None:
        # fallback: first { .. last }
        i, j = raw.find("{"), raw.rfind("}")
        if i != -1 and j > i:
            blob = raw[i : j + 1]
    if not blob:
        raise SystemExit(f"could not locate JSON in LLM output:\n{raw[:500]}")
    return json.loads(blob)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default="f10bc353-01ab-4db1-af9f-d9305ea9a532",
                    help="user UUID (data/<uuid>/ must hold TRAINING_PLAN.md)")
    ap.add_argument("--out", default=None, help="write validated goal JSON here")
    args = ap.parse_args()

    data_dir = _REPO / "data" / args.profile
    tp_path = data_dir / "TRAINING_PLAN.md"
    if not tp_path.exists():
        raise SystemExit(f"missing {tp_path}")
    training_plan = tp_path.read_text(encoding="utf-8")

    profile_path = data_dir / "profile.json"
    profile_blob = profile_path.read_text(encoding="utf-8") if profile_path.exists() else "{}"

    from stride_core.timefmt import today_shanghai
    today = today_shanghai().isoformat()

    user_msg = (
        f"今天是 {today}（Asia/Shanghai）。下面是用户的 legacy 训练资料，请据此提取主目标赛事。\n\n"
        f"=== TRAINING_PLAN.md ===\n{training_plan}\n\n"
        f"=== profile.json ===\n{profile_blob}\n"
    )

    from stride_server.llm_client import LLMClient
    client = LLMClient()
    raw = client.chat_sync(
        SYSTEM_PROMPT,
        [{"role": "user", "content": user_msg}],
        max_tokens=4096,
        reasoning_effort="low",
    )
    goal = _parse_goal(raw)

    # Validate against the real prod model — fail loudly on a bad extraction.
    from stride_server.routes.training_goal import TrainingGoal
    validated = TrainingGoal(**goal)
    out_json = json.dumps(validated.model_dump(exclude_none=True), ensure_ascii=False, indent=2)

    print(out_json)
    if args.out:
        Path(args.out).write_text(out_json, encoding="utf-8")
        print(f"\n[written] {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
