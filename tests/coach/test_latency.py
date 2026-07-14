"""Privacy-safe Coach latency callback tests."""

from __future__ import annotations

import logging
import uuid

from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, LLMResult

from coach.runtime.latency import CoachLatencyCallback
from coach.runtime.model_spec import ModelSpec


def test_latency_callback_logs_metadata_without_message_content(caplog) -> None:
    spec = ModelSpec(
        role="status_insight", provider="openai-compatible", model="fast",
        deployment="fast", endpoint="http://localhost/v1", api_version=None,
        temperature=None, max_tokens=100, timeout_s=10, auth_mode="api-key",
    )
    callback = CoachLatencyCallback(spec)
    run_id = uuid.uuid4()
    secret_prompt = "PRIVATE_HEALTH_PROMPT"
    callback.on_chat_model_start(
        {}, [[HumanMessage(content=secret_prompt)]], run_id=run_id
    )
    response = LLMResult(
        generations=[[ChatGeneration(message=AIMessage(
            content="PRIVATE_HEALTH_RESPONSE",
            usage_metadata={"input_tokens": 12, "output_tokens": 5, "total_tokens": 17},
        ))]]
    )

    with caplog.at_level(logging.DEBUG, logger="coach.runtime.latency"):
        callback.on_llm_end(response, run_id=run_id)

    text = caplog.text
    assert "role=status_insight" in text
    assert "input_tokens=12" in text
    assert secret_prompt not in text
    assert "PRIVATE_HEALTH_RESPONSE" not in text
