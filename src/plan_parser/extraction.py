"""Extract fenced ``json`` code blocks from model output or markdown."""

from __future__ import annotations

import re


JSON_BLOCK_RE = re.compile(
    r"```(?:json|jsonc)?\s*(\{.*?\})\s*```",
    re.DOTALL | re.IGNORECASE,
)


def extract_last_json_block(text: str) -> str | None:
    """Return the contents of the *last* fenced ```json``` block, or None."""
    matches = JSON_BLOCK_RE.findall(text)
    if not matches:
        return None
    return matches[-1]


def strip_json_block(text: str) -> str:
    """Remove fenced ```json``` blocks from ``text``.

    Used by the coach agent's ``weekly_plan`` task so the markdown stored as
    ``content_md`` is the pure plan markdown — the JSON code block is metadata,
    not authored content.
    """
    return JSON_BLOCK_RE.sub("", text).rstrip()
