"""TargetRef — which plan / week / session a turn is acting on.

Resolved by the Resolver (§4.1) out-of-band from the conversation messages and
carried as typed turn state (§5.4). ``kind`` selects which identifier fields are
meaningful:

* ``master``  → ``plan_id``
* ``week``    → ``folder`` (+ optional ``date`` for a specific day)
* ``session`` → ``folder`` + ``date`` (+ optional ``session_index`` within a day)
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


TargetKind = Literal["master", "week", "session"]


class TargetRef(BaseModel):
    """Stable handle for the plan object a turn targets.

    Only the fields relevant to ``kind`` are populated; the rest stay ``None``.
    This is system state (handles for code), so per §5.4 it travels on the
    out-of-band typed channel and never enters the LLM message stream.
    """

    kind: TargetKind
    plan_id: str | None = None
    folder: str | None = None
    date: str | None = None
    session_index: int | None = None
