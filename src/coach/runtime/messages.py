"""Message-content normalisation helpers shared across coach runtime + adapters.

``extract_text`` flattens a langchain ``BaseMessage.content`` (which can be
``str`` for chat-completions or ``list[dict]`` for Responses API) into a
single plain-text string. Callers downstream (judge parsers, sentinel
extractors, JSON tier parsers) only want the user-facing text and don't
care which API surface produced it.

Pure logic, no I/O — safe for ``coach.*`` core.
"""

from __future__ import annotations


def extract_text(content: object) -> str:
    """Normalise langchain message ``content`` to a single text string.

    The Responses API returns ``content`` as ``list[dict]`` (typically a
    reasoning block + a text block). The chat-completions API returns ``str``.
    We want only the user-facing text, concatenated, so downstream parsers
    see exactly what the model wrote.

    Falls back to ``str(content)`` for unrecognised shapes so a misbehaving
    response surfaces as a parse failure rather than crashing.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict):
                btype = block.get("type")
                if btype in ("text", "output_text"):
                    txt = block.get("text")
                    if isinstance(txt, str):
                        parts.append(txt)
            elif isinstance(block, str):
                parts.append(block)
        if parts:
            return "\n".join(parts)
    return str(content)
