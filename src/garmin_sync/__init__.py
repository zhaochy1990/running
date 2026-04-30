"""Garmin Connect adapter — read-only path (v1).

Architecture mirrors `coros_sync/`:
- `auth.py` persists per-user Garmin SSO tokens (via garth).
- `client.py` is a thin wrapper around an authenticated `garth.Client` and
  the high-level `garminconnect.Garmin` API surface (with the working
  garth client grafted in to bypass garminconnect 0.3.3's broken CN login).
- `normalize.py` translates Garmin-encoded values to stride_core's
  provider-agnostic enums.
- `models.py` converts Garmin API JSON into `stride_core.models.ActivityDetail`,
  `DailyHealth`, `Dashboard` — the same domain models COROS produces.
- `sync.py` orchestrates the per-user sync (activities + daily health).
- `adapter.py` exposes everything as a `DataSource` implementation.

v1 is read-only: login + sync. Workout push, exercise catalog, sleep/HRV
detail tables come in later phases.
"""
