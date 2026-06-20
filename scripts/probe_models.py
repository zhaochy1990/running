#!/usr/bin/env python3
"""Quick probe: can the coach LLM factory reach each candidate deployment?

Builds each candidate ModelSpec via the real coach factory + DefaultAzureCredential
and does one tiny chat call, reporting OK/FAIL + latency. Run BEFORE the expensive
full-generation sweep so misconfigured models (wrong api_kind / provider / endpoint)
are caught cheaply.

    az login
    $env:PYTHONIOENCODING="utf-8"; python scripts/probe_models.py
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

_SRC = Path(__file__).resolve().parents[1] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from coach.runtime.llm_factory import build_chat_model
from coach.runtime.model_spec import ModelSpec
from langchain_core.messages import HumanMessage
from stride_server.coach_runtime import _build_azure_credentials

_AOAI = "https://azureai4identity.cognitiveservices.azure.com"
endpoint = "https://azureai4identity.services.ai.azure.com/openai/v1/"
# (tag, provider, deployment, endpoint, api_kind, api_version, temperature)
CANDIDATES = [
    # ("gpt-5.5",      "azure-openai",      "gpt-5.5",      _AOAI,  "responses",        "2025-04-01-preview", None),
    # ("gpt-5.4",      "azure-openai",      "gpt-5.4",      _AOAI,  "responses",        "2025-04-01-preview", None),
    # ("gpt-5.4-nano", "azure-openai",      "gpt-5.4-nano", _AOAI,  "responses",        "2025-04-01-preview", None),
    # ("gpt-4.1",      "azure-openai",      "gpt-4.1",      _AOAI,  "chat-completions", "2025-04-01-preview", 0.4),
    # ("gpt-4.1-mini", "azure-openai",      "gpt-4.1-mini", _AOAI,  "chat-completions", "2025-04-01-preview", 0.4),
    ("DeepSeek-R1",  "azure-ai-inference", "DeepSeek-R1", endpoint, "chat-completions", "2024-05-01-preview", None),
    ("Kimi-K2.5",    "azure-ai-inference", "Kimi-K2.5",   endpoint, "chat-completions", "2024-05-01-preview", 0.6),
]


def main() -> int:
    creds = _build_azure_credentials()
    print(f"{'TAG':14} {'RESULT':6} {'LAT':>7}  DETAIL")
    print("-" * 78)
    for tag, provider, deployment, endpoint, api_kind, api_version, temp in CANDIDATES:
        spec = ModelSpec(
            role="generator", provider=provider, model=deployment, deployment=deployment,
            endpoint=endpoint, api_version=api_version, temperature=temp,
            max_tokens=256, timeout_s=60.0, api_kind=api_kind,
        )
        t0 = time.monotonic()
        try:
            llm = build_chat_model(spec, credentials=creds)
            resp = llm.invoke([HumanMessage(content="Reply with exactly: OK")])
            dt = time.monotonic() - t0
            txt = str(getattr(resp, "content", resp))[:40].replace("\n", " ")
            print(f"{tag:14} {'OK':6} {dt:6.1f}s  {txt!r}")
        except Exception as exc:  # noqa: BLE001
            dt = time.monotonic() - t0
            msg = str(exc).replace("\n", " ")[:90]
            print(f"{tag:14} {'FAIL':6} {dt:6.1f}s  {type(exc).__name__}: {msg}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
