"""Likes storage — public interface (Tier A).

``LikeEntity`` is the result shape; ``LikesBackend`` is the Protocol every
backend (JSON file / Azure Table) satisfies. Pure typing — no I/O import.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class LikeEntity:
    team_id: str
    owner_user_id: str
    label_id: str
    liker_user_id: str
    liker_display_name: str
    created_at: str


class LikesBackend(Protocol):
    """Common interface implemented by the file + Azure Table backends."""

    def put(self, entity: LikeEntity) -> None: ...

    def delete(
        self, team_id: str, owner_user_id: str, label_id: str, liker_user_id: str,
    ) -> bool: ...

    def list_for_activity(
        self, team_id: str, owner_user_id: str, label_id: str,
    ) -> list[LikeEntity]: ...

    def list_bulk(
        self, team_id: str, targets: list[tuple[str, str]],
    ) -> dict[tuple[str, str], list[LikeEntity]]: ...
