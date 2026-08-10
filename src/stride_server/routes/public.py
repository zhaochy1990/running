"""Public endpoints — no auth. Kept as a separate router so every other
router can have a router-level `require_bearer` dependency applied in the
app factory without breaking liveness probes.
"""

from __future__ import annotations

import logging
import re
from html import escape
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import HTMLResponse, PlainTextResponse

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/health")
def health():
    return {"status": "ok"}


# ── Privacy policy ─────────────────────────────────────────────────────────
#
# Authored as `data/privacy.md` in the monorepo, synced to Azure Files via
# the `sync-data.yml` GitHub Action. Served at https://stride-running.cn/privacy
# as plain HTML (no client-side JS) so it's indexable and works in low-spec
# embedded webviews.

# Where the markdown file lives in production. data/ is mounted on Azure
# Files at /app/data; in dev it lives at the project root.
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
_PRIVACY_PATH = _PROJECT_ROOT / "data" / "privacy.md"


def _markdown_to_html(md: str) -> str:
    """Tiny markdown → HTML converter for the small subset privacy.md uses
    (headings, bold, paragraphs, lists, simple tables, hr, links). Avoids
    pulling in `markdown` as a runtime dep. Output is escaped where needed.
    """
    lines = md.splitlines()
    out: list[str] = []
    in_list = False
    in_table = False
    table_align: list[str] = []

    def close_list() -> None:
        nonlocal in_list
        if in_list:
            out.append("</ul>")
            in_list = False

    def close_table() -> None:
        nonlocal in_table, table_align
        if in_table:
            out.append("</tbody></table>")
            in_table = False
            table_align = []

    def inline(text: str) -> str:
        # Order matters — escape first, then re-introduce explicit tags.
        s = escape(text)
        s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
        s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
        s = re.sub(
            r"\[([^\]]+)\]\(([^)]+)\)",
            lambda m: f'<a href="{escape(m.group(2))}" rel="noopener" target="_blank">{m.group(1)}</a>',
            s,
        )
        return s

    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.rstrip()
        if not stripped:
            close_list()
            close_table()
            i += 1
            continue
        if stripped == "---":
            close_list()
            close_table()
            out.append("<hr>")
            i += 1
            continue
        # Headings
        m = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if m:
            close_list()
            close_table()
            level = len(m.group(1))
            out.append(f"<h{level}>{inline(m.group(2))}</h{level}>")
            i += 1
            continue
        # Lists
        if re.match(r"^\s*[-*]\s+", stripped):
            close_table()
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append(f"<li>{inline(re.sub(r'^\s*[-*]\s+', '', stripped))}</li>")
            i += 1
            continue
        # Tables: line of `|...|` followed by separator line of `|---|---|`
        if "|" in stripped and stripped.startswith("|"):
            close_list()
            cells = [c.strip() for c in stripped.strip("|").split("|")]
            if not in_table:
                # Look ahead for separator
                if i + 1 < len(lines) and re.match(
                    r"^\|[\s|:\-]+\|$", lines[i + 1].strip()
                ):
                    out.append("<table><thead><tr>")
                    out.extend(f"<th>{inline(c)}</th>" for c in cells)
                    out.append("</tr></thead><tbody>")
                    in_table = True
                    i += 2  # skip separator
                    continue
            else:
                out.append("<tr>")
                out.extend(f"<td>{inline(c)}</td>" for c in cells)
                out.append("</tr>")
                i += 1
                continue
        # Blockquote
        if stripped.startswith(">"):
            close_list()
            close_table()
            out.append(
                f"<blockquote>{inline(stripped.lstrip('>').strip())}</blockquote>"
            )
            i += 1
            continue
        # Paragraph
        close_list()
        close_table()
        out.append(f"<p>{inline(stripped)}</p>")
        i += 1

    close_list()
    close_table()
    return "\n".join(out)


_PRIVACY_CSS = """
body { max-width: 720px; margin: 2em auto; padding: 0 1em; font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif; color: #0a0a0a; line-height: 1.6; }
h1 { font-size: 1.8em; margin-bottom: 0.2em; }
h2 { font-size: 1.3em; margin-top: 1.5em; border-bottom: 1px solid #e5e5e5; padding-bottom: 0.2em; }
h3 { font-size: 1.05em; margin-top: 1em; color: #404040; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 0.95em; }
th, td { border: 1px solid #e5e5e5; padding: 6px 10px; text-align: left; }
th { background: #f5f5f5; font-weight: 600; }
blockquote { border-left: 3px solid #d4d4d4; padding: 0.2em 1em; color: #525252; margin: 1em 0; background: #fafafa; }
code { background: #f5f5f5; padding: 1px 4px; border-radius: 3px; font-size: 0.9em; }
a { color: #00b85a; }
hr { border: 0; border-top: 1px solid #e5e5e5; margin: 2em 0; }
"""


@router.get("/privacy", response_class=HTMLResponse)
def privacy_page():
    if not _PRIVACY_PATH.exists():
        logger.warning("privacy.md not found at %s", _PRIVACY_PATH)
        return PlainTextResponse(
            "Privacy policy is being prepared. Contact zhaochaoyi@microsoft.com.",
            status_code=503,
        )
    md = _PRIVACY_PATH.read_text(encoding="utf-8")
    body = _markdown_to_html(md)
    html = (
        "<!DOCTYPE html>\n"
        "<html lang='zh-CN'><head>"
        "<meta charset='UTF-8'>"
        "<meta name='viewport' content='width=device-width, initial-scale=1'>"
        "<title>STRIDE 隐私政策</title>"
        f"<style>{_PRIVACY_CSS}</style>"
        "</head><body>"
        f"{body}"
        "</body></html>"
    )
    return HTMLResponse(content=html)
