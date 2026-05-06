"""Curated strength-training illustration library.

The directory ``strength_illustrations/`` at the project root holds a curated
set of muscle-activation diagrams plus per-exercise coaching descriptions
(动作要点 / 发力部位 / 常见错误). Each exercise is keyed by ``code`` —
typically a COROS T-code (``T1231``) but a handful of mnemonic codes
(``SL_WALLSIT``, ``HIP_9090``) for catalog-only entries.

This module loads the three JSON files once at import time (cheap — under
100 KB total) and exposes a single ``lookup`` entry point used by the
``/api/{user}/weeks/{folder}/strength`` route to join a planned exercise
to its image + coaching text.

Match keys:
  1. ``provider_id``  (e.g. ``T1231``) → direct match against ``code``.
  2. ``canonical_id`` (e.g. ``single_leg_wall_sit``) → resolved through
     ``_CANONICAL_TO_CODE`` for the small set of mnemonic codes.

Usability filter: only verdicts equal to ``"go"`` qualify the image as
product-grade. ``borderline_go``, ``hold``, ``regen``, missing → image is
treated as unavailable and the API returns ``image_url=None`` so the
frontend renders text-only.
"""

from __future__ import annotations

import json
import logging
import threading
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

# Resolve project root the same way ``deps.py`` does so this works both in
# the repo and inside the Docker image (where source lives at /app/src and
# the library at /app/strength_illustrations/).
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_LIB_DIR = _PROJECT_ROOT / "strength_illustrations"

# URL prefix the FastAPI app mounts the ``output/`` directory under (see
# ``app.py``). Image URLs returned by ``lookup`` use this prefix so the
# frontend can ``<img src=...>`` directly.
IMAGE_URL_PREFIX = "/strength_illustrations/output"

# Mnemonic canonical_id → code. Hand-maintained for the few catalog
# entries that aren't COROS T-codes.
_CANONICAL_TO_CODE: dict[str, str] = {
    "single_leg_wall_sit": "SL_WALLSIT",
    "hip_90_90":           "HIP_9090",
    "hip_9090":            "HIP_9090",
}


@dataclass(frozen=True)
class StrengthLibraryEntry:
    """Per-exercise data joined from the three library JSON files."""

    code: str
    name_zh: str
    image_url: str | None              # None when image is missing or not product-grade
    key_points: tuple[str, ...]
    muscle_focus: tuple[str, ...]
    common_mistakes: tuple[str, ...]


class _Library:
    """Loaded once at import time. Treated as immutable after construction."""

    def __init__(self) -> None:
        self._entries: dict[str, StrengthLibraryEntry] = {}
        self._load()

    def _load(self) -> None:
        exercises_path = _LIB_DIR / "exercises.json"
        notes_path = _LIB_DIR / "review_notes.json"
        descriptions_path = _LIB_DIR / "descriptions.json"

        if not exercises_path.exists():
            logger.warning(
                "strength_library: %s missing — library disabled",
                exercises_path,
            )
            return

        try:
            exercises = json.loads(exercises_path.read_text(encoding="utf-8"))["exercises"]
        except (OSError, ValueError, KeyError) as exc:
            logger.warning("strength_library: failed to load exercises.json: %s", exc)
            return

        notes: dict = {}
        if notes_path.exists():
            try:
                notes = json.loads(notes_path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                logger.warning("strength_library: failed to load review_notes.json: %s", exc)

        descriptions: dict = {}
        if descriptions_path.exists():
            try:
                descriptions = json.loads(descriptions_path.read_text(encoding="utf-8")).get(
                    "exercises", {}
                )
            except (OSError, ValueError) as exc:
                logger.warning("strength_library: failed to load descriptions.json: %s", exc)

        for ex in exercises:
            code = ex["code"]
            verdict = (notes.get(code) or {}).get("verdict") if isinstance(notes, dict) else None
            image_url = self._resolve_image_url(code) if verdict == "go" else None

            desc = descriptions.get(code, {}) if isinstance(descriptions, dict) else {}
            # Fall back to labels_zh when no detailed muscle_focus authored.
            muscle_focus = desc.get("muscle_focus") or [
                z for z, _ in (ex.get("labels_zh") or [])
            ]

            self._entries[code] = StrengthLibraryEntry(
                code=code,
                name_zh=ex.get("name_zh", code),
                image_url=image_url,
                key_points=tuple(desc.get("key_points", []) or []),
                muscle_focus=tuple(muscle_focus or []),
                common_mistakes=tuple(desc.get("common_mistakes", []) or []),
            )

    @staticmethod
    def _resolve_image_url(code: str) -> str | None:
        out_dir = _LIB_DIR / "output" / code
        if not out_dir.exists():
            return None
        # Pick highest version PNG (same convention as scripts/strength_illustrations.py).
        best_n = -1
        best_name: str | None = None
        for p in out_dir.glob("v*.png"):
            try:
                n = int(p.stem[1:])
            except ValueError:
                continue
            if n > best_n:
                best_n = n
                best_name = p.name
        if best_name is None:
            return None
        return f"{IMAGE_URL_PREFIX}/{code}/{best_name}"

    def lookup(
        self,
        *,
        provider_id: str | None = None,
        canonical_id: str | None = None,
    ) -> StrengthLibraryEntry | None:
        """Return the matching entry, or ``None`` for no library match.

        The entry's ``image_url`` is ``None`` when the image isn't usable —
        callers should always check it before rendering the image.
        """
        if provider_id and provider_id in self._entries:
            return self._entries[provider_id]
        if canonical_id:
            mapped = _CANONICAL_TO_CODE.get(canonical_id)
            if mapped and mapped in self._entries:
                return self._entries[mapped]
        return None

    @property
    def loaded_codes(self) -> tuple[str, ...]:
        return tuple(self._entries.keys())


_LIBRARY: _Library | None = None
_LIBRARY_LOCK = threading.Lock()


def get_library() -> _Library:
    global _LIBRARY
    if _LIBRARY is None:
        with _LIBRARY_LOCK:
            if _LIBRARY is None:
                _LIBRARY = _Library()
    return _LIBRARY


def lookup(
    *,
    provider_id: str | None = None,
    canonical_id: str | None = None,
) -> StrengthLibraryEntry | None:
    """Public lookup helper. Returns ``None`` for no library match."""
    return get_library().lookup(provider_id=provider_id, canonical_id=canonical_id)


__all__ = [
    "IMAGE_URL_PREFIX",
    "StrengthLibraryEntry",
    "get_library",
    "lookup",
]
