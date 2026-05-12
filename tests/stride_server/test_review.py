"""Tests for GET /api/{user}/weeks/{folder}/review (T12)."""

from __future__ import annotations

import json
import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"

FOLDER = "2026-05-04_05-10(W1)"
DATE_FROM = "2026-05-04"
DATE_TO = "2026-05-10"

NEXT_FOLDER = "2026-05-11_05-17(W2)"
NEXT_DATE_FROM = "2026-05-11"


# ── Key helpers ────────────────────────────────────────────────────────────────


@pytest.fixture
def rsa_keypair():
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = private.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    public_pem = private.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    return private_pem, public_pem


def _token(private_pem: str, sub: str = USER_UUID) -> str:
    now = int(time.time())
    return jwt.encode(
        {"sub": sub, "iss": "auth-service", "exp": now + 3600, "iat": now, "role": "user"},
        private_pem,
        algorithm="RS256",
    )


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ── App fixture ────────────────────────────────────────────────────────────────


@pytest.fixture
def app_client(tmp_path, monkeypatch, rsa_keypair):
    private_pem, public_pem = rsa_keypair

    import stride_server.bearer as bearer
    monkeypatch.setattr(bearer, "_cached_public_key", public_pem)
    monkeypatch.setattr(bearer, "_warned_open", False)
    for key in ("STRIDE_AUTH_PUBLIC_KEY_PEM", "STRIDE_AUTH_PUBLIC_KEY_PATH",
                "STRIDE_AUTH_ISSUER", "STRIDE_AUTH_AUDIENCE"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("STRIDE_AUTH_PUBLIC_KEY_PEM", public_pem)

    import stride_core.db as core_db_mod
    import stride_server.deps as deps_mod
    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    monkeypatch.setattr(deps_mod, "USER_DATA_DIR", tmp_path)

    # Patch content_store to return no folders (so next_week_preview lookup
    # doesn't try to open files on disk).
    import stride_server.content_store as cs_mod
    monkeypatch.setattr(cs_mod, "list_week_folders", lambda user: iter([]))

    from stride_server.bearer import require_bearer, verify_path_user
    from stride_server.routes.review import router

    app = FastAPI()
    app.include_router(router, dependencies=[Depends(require_bearer), Depends(verify_path_user)])

    client = TestClient(app, raise_server_exceptions=False)
    return client, _token(private_pem), tmp_path, private_pem


# ── Seed helpers ───────────────────────────────────────────────────────────────


def _user_dir(tmp_path):
    d = tmp_path / USER_UUID
    d.mkdir(parents=True, exist_ok=True)
    return d


def _open_db(tmp_path):
    """Open the test user's Database (creates schema if needed)."""
    from stride_core.db import Database
    return Database(user=USER_UUID)


def _seed_standard(tmp_path):
    """Seed a standard week: 2 planned sessions + 1 actual + 1 feedback + PMC."""
    _user_dir(tmp_path)
    db = _open_db(tmp_path)

    # Planned sessions: 2 run sessions in W1
    db._conn.execute(
        """INSERT INTO planned_session
           (week_folder, date, session_index, kind, summary, total_distance_m, total_duration_s)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (FOLDER, "2026-05-05", 0, "run", "E 10K 有氧", 10000, 3600),
    )
    db._conn.execute(
        """INSERT INTO planned_session
           (week_folder, date, session_index, kind, summary, total_distance_m, total_duration_s)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (FOLDER, "2026-05-08", 0, "run", "节奏跑 8K", 8000, 2400),
    )

    # 1 actual activity matching first planned session date
    db._conn.execute(
        """INSERT INTO activities
           (label_id, name, sport_type, date, distance_m, duration_s, avg_pace_s_km, avg_hr)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        ("ACT001", "Easy Run", 100, "2026-05-05T07:00:00", 9800.0, 3540, 361, 148),
    )

    # Feedback for the activity
    db._conn.execute(
        """INSERT INTO activity_feedback (label_id, rpe, mood_tags, note)
           VALUES (?, ?, ?, ?)""",
        ("ACT001", 5, json.dumps(["状态好"], ensure_ascii=False), "感觉不错"),
    )

    # Commentary for highlight
    db._conn.execute(
        """INSERT INTO activity_commentary (label_id, commentary, generated_by)
           VALUES (?, ?, ?)""",
        ("ACT001", "轻松有氧节奏控制良好，心率稳定在 Z2 区间。", "gpt-4.1"),
    )

    # PMC data for the week (7 days)
    for i, d in enumerate([
        ("2026-05-04", 44.0, 56.0),
        ("2026-05-05", 45.0, 56.2),
        ("2026-05-06", 44.5, 56.3),
        ("2026-05-07", 44.0, 56.1),
        ("2026-05-08", 46.0, 56.5),
        ("2026-05-09", 45.5, 56.4),
        ("2026-05-10", 46.5, 56.6),
    ]):
        db._conn.execute(
            "INSERT OR REPLACE INTO daily_health (date, ati, cti) VALUES (?, ?, ?)",
            d,
        )

    db._conn.commit()
    db.close()


def _seed_no_pmc(tmp_path):
    """Seed a week with planned/actual but NO daily_health rows."""
    _user_dir(tmp_path)
    db = _open_db(tmp_path)
    db._conn.execute(
        """INSERT INTO planned_session
           (week_folder, date, session_index, kind, summary, total_distance_m, total_duration_s)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (FOLDER, "2026-05-05", 0, "run", "E 10K", 10000, 3600),
    )
    db._conn.execute(
        """INSERT INTO activities
           (label_id, name, sport_type, date, distance_m, duration_s, avg_pace_s_km, avg_hr)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        ("ACT002", "Run", 100, "2026-05-05T07:00:00", 10000.0, 3600, 360, 145),
    )
    db._conn.commit()
    db.close()


# ── Tests ──────────────────────────────────────────────────────────────────────


class TestReviewStandardWeek:
    """Standard week: planned sessions + actual activities + feedback + PMC."""

    def test_status_200(self, app_client):
        client, token, tmp_path, _ = app_client
        _seed_standard(tmp_path)
        resp = client.get(f"/api/{USER_UUID}/weeks/{FOLDER}/review", headers=_auth(token))
        assert resp.status_code == 200, resp.text

    def test_summary_fields(self, app_client):
        client, token, tmp_path, _ = app_client
        _seed_standard(tmp_path)
        data = client.get(
            f"/api/{USER_UUID}/weeks/{FOLDER}/review", headers=_auth(token)
        ).json()

        s = data["summary"]
        assert s["total_sessions_planned"] == 2
        assert s["total_sessions_completed"] == 1
        assert abs(s["completion_rate"] - 0.5) < 0.01
        assert s["total_distance_km"] > 0
        assert s["avg_rpe"] == 5.0  # only 1 feedback row with rpe=5

    def test_sessions_list(self, app_client):
        client, token, tmp_path, _ = app_client
        _seed_standard(tmp_path)
        data = client.get(
            f"/api/{USER_UUID}/weeks/{FOLDER}/review", headers=_auth(token)
        ).json()

        sessions = data["sessions"]
        assert len(sessions) == 2

        completed = [s for s in sessions if s["completed"]]
        assert len(completed) == 1
        c = completed[0]
        assert c["actual_label_id"] == "ACT001"
        assert c["rpe"] == 5
        assert "状态好" in c["mood_tags"]
        assert c["adherence_pct"] is not None

        incomplete = [s for s in sessions if not s["completed"]]
        assert len(incomplete) == 1
        assert incomplete[0]["actual_label_id"] is None
        assert incomplete[0]["rpe"] is None

    def test_tsb_series(self, app_client):
        client, token, tmp_path, _ = app_client
        _seed_standard(tmp_path)
        data = client.get(
            f"/api/{USER_UUID}/weeks/{FOLDER}/review", headers=_auth(token)
        ).json()

        tsb = data["tsb_series"]
        assert len(tsb) == 7
        assert tsb[0]["date"] == "2026-05-04"
        # tsb = cti - ati; for first row: 56.0 - 44.0 = 12.0
        assert abs(tsb[0]["tsb"] - 12.0) < 0.1

    def test_insights_present(self, app_client):
        client, token, tmp_path, _ = app_client
        _seed_standard(tmp_path)
        data = client.get(
            f"/api/{USER_UUID}/weeks/{FOLDER}/review", headers=_auth(token)
        ).json()

        insights = data["insights"]
        assert len(insights) >= 1
        for insight in insights:
            assert insight["level"] in ("positive", "warning", "neutral")
            assert insight["type"] in ("completion", "load", "rpe", "streak")
            assert len(insight["text"]) > 0

    def test_activity_highlights(self, app_client):
        client, token, tmp_path, _ = app_client
        _seed_standard(tmp_path)
        data = client.get(
            f"/api/{USER_UUID}/weeks/{FOLDER}/review", headers=_auth(token)
        ).json()

        highlights = data["activity_highlights"]
        assert len(highlights) == 1
        assert highlights[0]["label_id"] == "ACT001"
        assert len(highlights[0]["commentary_excerpt"]) <= 80

    def test_next_week_preview_null_when_no_next_week(self, app_client):
        client, token, tmp_path, _ = app_client
        _seed_standard(tmp_path)
        data = client.get(
            f"/api/{USER_UUID}/weeks/{FOLDER}/review", headers=_auth(token)
        ).json()
        # content_store patched to return no folders → next_week_preview = null
        assert data["next_week_preview"] is None

    def test_envelope_fields(self, app_client):
        client, token, tmp_path, _ = app_client
        _seed_standard(tmp_path)
        data = client.get(
            f"/api/{USER_UUID}/weeks/{FOLDER}/review", headers=_auth(token)
        ).json()
        assert data["folder"] == FOLDER
        assert data["date_from"] == DATE_FROM
        assert data["date_to"] == DATE_TO


class TestReviewNoPMC:
    """Week with no daily_health data → tsb_series empty, load insight skipped."""

    def test_tsb_empty(self, app_client):
        client, token, tmp_path, _ = app_client
        _seed_no_pmc(tmp_path)
        data = client.get(
            f"/api/{USER_UUID}/weeks/{FOLDER}/review", headers=_auth(token)
        ).json()
        assert data["tsb_series"] == []

    def test_no_load_insight(self, app_client):
        client, token, tmp_path, _ = app_client
        _seed_no_pmc(tmp_path)
        data = client.get(
            f"/api/{USER_UUID}/weeks/{FOLDER}/review", headers=_auth(token)
        ).json()
        types = [i["type"] for i in data["insights"]]
        assert "load" not in types


class TestInsightCompletionBranches:
    """Verify that different completion rates trigger correct insight levels."""

    def _make_client_with_rate(self, app_client, tmp_path, rate: float):
        """Seed a week with the given completion rate.

        Uses days 2026-05-04 to 2026-05-10 (7 days max in the folder).
        planned=7, completed=int(planned*rate) so we stay within 1 week.
        """
        planned = 7
        completed = int(planned * rate)
        _user_dir(tmp_path)
        db = _open_db(tmp_path)
        for i in range(planned):
            d = f"2026-05-{4 + i:02d}"
            db._conn.execute(
                """INSERT INTO planned_session
                   (week_folder, date, session_index, kind, summary, total_distance_m)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (FOLDER, d, 0, "run", f"Session {i}", 8000),
            )
        # Insert `completed` actual run activities matching the first `completed` dates
        for i in range(completed):
            d_act = f"2026-05-{4 + i:02d}T07:00:00"
            db._conn.execute(
                """INSERT INTO activities
                   (label_id, name, sport_type, date, distance_m, duration_s)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (f"ACT{i:03d}", "Run", 100, d_act, 8000.0, 2800),
            )
        db._conn.commit()
        db.close()

    def test_high_completion_positive(self, app_client):
        client, token, tmp_path, _ = app_client
        # rate=1.0 → 7/7 = 100% → "positive"
        self._make_client_with_rate(app_client, tmp_path, rate=1.0)
        data = client.get(
            f"/api/{USER_UUID}/weeks/{FOLDER}/review", headers=_auth(token)
        ).json()
        completion_insights = [i for i in data["insights"] if i["type"] == "completion"]
        assert len(completion_insights) == 1
        assert completion_insights[0]["level"] == "positive"

    def test_mid_completion_neutral(self, app_client):
        client, token, tmp_path, _ = app_client
        # rate=0.857 → int(7*0.857)=5 completed / 7 planned ≈ 71% → "neutral"
        self._make_client_with_rate(app_client, tmp_path, rate=0.857)
        data = client.get(
            f"/api/{USER_UUID}/weeks/{FOLDER}/review", headers=_auth(token)
        ).json()
        completion_insights = [i for i in data["insights"] if i["type"] == "completion"]
        assert len(completion_insights) == 1
        assert completion_insights[0]["level"] == "neutral"

    def test_low_completion_warning(self, app_client):
        client, token, tmp_path, _ = app_client
        # rate=0.4 → int(7*0.4)=2 completed / 7 planned ≈ 29% → "warning"
        self._make_client_with_rate(app_client, tmp_path, rate=0.4)
        data = client.get(
            f"/api/{USER_UUID}/weeks/{FOLDER}/review", headers=_auth(token)
        ).json()
        completion_insights = [i for i in data["insights"] if i["type"] == "completion"]
        assert len(completion_insights) == 1
        assert completion_insights[0]["level"] == "warning"


class TestReviewInvalidFolder:
    """Invalid folder → 400."""

    def test_invalid_folder(self, app_client):
        client, token, tmp_path, _ = app_client
        _user_dir(tmp_path)
        _open_db(tmp_path).close()
        resp = client.get(
            f"/api/{USER_UUID}/weeks/not-a-folder/review", headers=_auth(token)
        )
        assert resp.status_code == 400
