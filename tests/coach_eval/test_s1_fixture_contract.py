from __future__ import annotations

import hashlib
import json
from pathlib import Path


FIXTURE_DIR = Path(__file__).resolve().parents[1] / "fixtures" / "coach_eval" / "s1"


# Frozen fixture input contracts. ``expected`` may be calibrated with new
# evidence, but changing ``input`` invalidates regression comparability and
# must be an explicit fixture-version decision.
S1_INPUT_SHA256 = {
    "s1-data-gap-no-recent-race": "dad32d5c98a6e53973495739869734b4627ca082632247e178b36413d2a869c1",
    "s1-edge-case-race-on-holiday": "f32da39b1e9879e31b5cb3892ec87f0c6a9e6db70f5bb6146beea096af5381ea",
    "s1-fm-target-sub250-advanced": "fe19d51ab0fc6750ff88991720974811fbcb68ba47a07a58f86cf3a56eb93fd8",
    "s1-frequency-limit-3day": "7082ded5ceb2c4b0dccb68d240d9090ed7802afdad5c969b50d9961426282817",
    "s1-goal-realism-boundary-13pct": "3a32f0285023fd054d26d09887abbdfbb6e0dc4b4324a290796e507b312082f1",
    "s1-injury-knee-return": "4fb7ce2c37ad57ed692d63d6b7be1b3deb686957a35376122b83ff388a87d672",
    "s1-phase-transition-from-recovery": "13350808d69a2c351a086220abf29746ea1a6fc150d394541c6b384ad4fa6a23",
    "s1-sparse-db-capable": "4550030a5a81b49b403e5b7f4a3b2e4fdc8cda0d3c7cf9c712107d372508f9a9",
    "s1-target-distance-10k": "d89c0a739df2e51dfbc81a09e18b3b96b150dfc04c2272c5c14fb6670e40858f",
    "s1-target-distance-5k": "f5d1a4ba14aed0b1947413fb1a5bd63f0c2d74355689deb5ee4057349b68fc46",
    "s1-target-distance-hm": "d7833e9f6998a7a41e48f061c904adffc6c1261c787250ef3120090daf2938fc",
    "s1-unrealistic-goal": "23772c53577b066286e926adec62cee6046538ee3ddce5b93eae9fa1e3342f87",
    "s1-user-pushback-aggressive-peak": "a41fbf997a15624da747ae23f5b8da6bda2cb7a48081d5332a9d0c30a3d76c38",
    "s1-zhaochaoyi-altitude-p2-replan": "38b9082628f55fd99734683497a9d2eb8779b9654c9a78fe82160694f5277fd9",
}


REQUIRED_TAGS = {
    "phase_transition",
    "injury_constraint",
    "user_pushback",
    "data_gap",
    "edge_case",
    "target_distance",
    "unrealistic_goal",
    "sparse_db_capable_user",
    "frequency_limit",
    "goal_realism_boundary",
    "real_user",
}


def _load_s1_fixtures() -> list[tuple[Path, dict]]:
    fixtures: list[tuple[Path, dict]] = []
    for path in sorted(FIXTURE_DIR.glob("*.json")):
        fixtures.append((path, json.loads(path.read_text(encoding="utf-8"))))
    return fixtures


def _input_hash(fixture: dict) -> str:
    canonical = json.dumps(
        fixture["input"],
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def test_s1_fixture_ids_and_inputs_are_frozen() -> None:
    fixtures = _load_s1_fixtures()
    ids = [fixture["fixture_id"] for _path, fixture in fixtures]

    assert ids == sorted(S1_INPUT_SHA256)
    assert len(ids) == 14

    for path, fixture in fixtures:
        fixture_id = fixture["fixture_id"]
        assert path.name == f"{fixture_id}.json"
        assert fixture["scope"] == "s1"
        assert _input_hash(fixture) == S1_INPUT_SHA256[fixture_id]


def test_s1_fixture_envelope_and_coverage_tags() -> None:
    all_tags: set[str] = set()
    for _path, fixture in _load_s1_fixtures():
        assert isinstance(fixture.get("description"), str) and fixture["description"]
        assert isinstance(fixture.get("tags"), list) and fixture["tags"]
        all_tags.update(str(tag) for tag in fixture["tags"])

        input_payload = fixture.get("input") or {}
        user_profile = input_payload.get("user_profile") or {}
        expected = fixture.get("expected") or {}
        assert user_profile.get("target_race", {}).get("distance")
        assert user_profile.get("weekly_run_days_max") is not None
        assert input_payload.get("season_window", {}).get("start_date")
        assert input_payload.get("season_window", {}).get("end_date")
        assert expected.get("hard_constraints")
        assert expected.get("soft_rubric")

    assert REQUIRED_TAGS <= all_tags
