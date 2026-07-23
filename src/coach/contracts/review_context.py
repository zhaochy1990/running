"""ReviewContext — the unapplied draft a review turn is anchored to (§4, §5.4).

When the user is reviewing a proposal the coach just produced (a not-yet-applied
weekly-create draft in the Review workspace), a follow-up question like "这个课表
的训练逻辑是什么" must be answered against *that draft* — which is not yet a saved
plan. This carries the draft on the out-of-band typed channel so the specialist
answers from it instead of reading a (non-existent) persisted week plan.

Pure core layer: reuses the ``stride_core`` weekly-create proposal primitive
only; no infrastructure imports.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, model_validator

from stride_core.weekly_plan_proposal import WeeklyPlanCreateProposal


# Canonical key used to carry the typed review draft in ScopedContext.data.
# Core and adapter specialists import these constants so the handoff cannot drift.
REVIEW_CONTEXT_KEY = "review_context"
MAX_REVIEW_CONTEXT_BYTES = 64 * 1024


class WeeklyCreateReviewContext(BaseModel):
    """A not-yet-applied weekly-create draft under review.

    ``proposal`` is the authoritative source for any question about the drafted
    week's content / logic; the specialist must NOT fall back to a saved plan.
    """

    model_config = ConfigDict(frozen=True)

    kind: Literal["weekly_create"] = "weekly_create"
    proposal: WeeklyPlanCreateProposal

    @model_validator(mode="after")
    def _payload_fits_checkpoint_and_prompt(self) -> "WeeklyCreateReviewContext":
        size_bytes = len(self.model_dump_json().encode("utf-8"))
        if size_bytes > MAX_REVIEW_CONTEXT_BYTES:
            raise ValueError(
                f"review_context exceeds the {MAX_REVIEW_CONTEXT_BYTES}-byte limit"
            )
        return self


# Discriminated on ``kind`` so future review contexts (weekly_diff, master_diff)
# extend the union without changing the wiring.
ReviewContext = WeeklyCreateReviewContext
