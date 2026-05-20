from __future__ import annotations

from tests.test_teams_routes import (
    USER_A,
    USER_B,
    _FakeAdapter,
    _FakeRegistry,
    _auth,
    _override_registry,
    app_client,
    rsa_keypair,
)


def test_team_sync_all_runs_post_sync_for_each_synced_member(app_client, monkeypatch):
    client, token, _ = app_client

    coros_adapter = _FakeAdapter(name="coros", sync_activities=1, sync_health=2)
    garmin_adapter = _FakeAdapter(name="garmin", sync_activities=3, sync_health=4)
    registry = _FakeRegistry({USER_A: coros_adapter, USER_B: garmin_adapter})
    _override_registry(client, registry)

    async def fake_list_members(_bearer, _team_id):
        return [
            {"user_id": USER_A, "name": "Alice", "role": "owner"},
            {"user_id": USER_B, "name": "Bob", "role": "member"},
        ]

    import stride_server.auth_service_client as ac
    import stride_server.routes.teams as teams_mod

    monkeypatch.setattr(ac, "list_members", fake_list_members)
    calls: list[dict] = []
    monkeypatch.setattr(teams_mod, "run_post_sync_for_result", lambda **kwargs: calls.append(kwargs))

    resp = client.post("/api/teams/t1/sync-all", headers=_auth(token))

    assert resp.status_code == 200
    assert [(call["user"], call["provider"]) for call in calls] == [
        (USER_A, "coros"),
        (USER_B, "garmin"),
    ]
