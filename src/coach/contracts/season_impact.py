"""SeasonImpact — deterministic assessment of how a plan change touches the
active season (master) plan (§4.4 ProposalCard enrichment).

Pure typed value: the *evaluation* lives in :mod:`coach.season_impact`; this
module only defines the shape that rides on a :class:`ProposalCard`.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

SeasonImpactLevel = Literal["none", "advisory", "material"]


class SeasonImpact(BaseModel):
    """How a proposed weekly/master change relates to the season plan.

    * ``none``     — no active master, or the change stays within the phase's
      intended envelope.
    * ``advisory`` — a noticeable but tolerable deviation (informational).
    * ``material`` — the change breaks the phase's intent (volume far below the
      target band, key session removed/replaced, structure not preserved). A
      material *weekly* apply requires an explicit acknowledgement.
    """

    level: SeasonImpactLevel = "none"
    reasons: list[str] = Field(default_factory=list)
    metrics: dict[str, float] = Field(default_factory=dict)
