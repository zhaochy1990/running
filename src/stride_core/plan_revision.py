"""Plan revision fingerprints — optimistic-concurrency handles for apply.

A ``base_revision`` lets an ``/apply`` request declare which plan snapshot the
diff was proposed against. The server recomputes the current fingerprint and
rejects (409) when it no longer matches — the plan changed under the user's
feet since the proposal was surfaced.

* Weekly plans have no monotonic version, so the fingerprint is a content hash
  of the canonical ``WeeklyPlan.to_dict`` JSON (``sort_keys=True`` makes it
  key-order independent).
* Master plans carry a monotonic ``version`` int, so the ``base_revision`` for
  a master apply is simply ``str(version)`` — no hashing needed.
"""

from __future__ import annotations

import hashlib
import json

from .plan_spec import WeeklyPlan

__all__ = ["weekly_plan_fingerprint"]


def weekly_plan_fingerprint(plan: WeeklyPlan) -> str:
    """SHA-256 hex digest of the canonical ``WeeklyPlan`` JSON.

    Key-order independent (``sort_keys=True``) so two structurally-equal plans
    always hash identically regardless of how they were constructed.
    """
    canonical = json.dumps(
        plan.to_dict(), sort_keys=True, ensure_ascii=False, separators=(",", ":")
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
