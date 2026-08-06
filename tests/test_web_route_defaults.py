"""Regression checks for production stride-web route defaults."""

import tomllib
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]


def test_go_profile_coach_flags_match_python() -> None:
    """The routed Go profile must preserve the feature gates that select the weekly UI."""
    python_config = tomllib.loads((ROOT / "config/server.toml").read_text(encoding="utf-8"))
    go_config = yaml.safe_load((ROOT / "src/go/config.yml").read_text(encoding="utf-8"))

    python_plan = python_config["plan"]
    go_features = go_config["api"]["features"]
    assert go_features["coach-agent-weekly-plan-users"] == python_plan["coach_agent_weekly_plan_users"]
    assert go_features["coach-chat-users"] == python_plan["coach_chat_users"]
    assert go_features["coach-chat-debug-users"] == python_plan["coach_chat_debug_users"]
    assert go_features["coach-chat-max-message-chars"] == python_plan["coach_chat_max_message_chars"]
