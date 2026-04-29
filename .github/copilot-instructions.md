# Copilot instructions for STRIDE

## Build, test, and lint commands

Use PowerShell syntax on Windows.

```powershell
# Python install with backend/API/test extras
pip install -e ".[dev,analysis,web]"

# Python tests
pytest
pytest tests\test_db.py
pytest -k test_pace_str

# COROS CLI; prefer module execution because the script may not be on PATH
$env:PYTHONIOENCODING = "utf-8"; python -m coros_sync -P zhaochaoyi sync
$env:PYTHONIOENCODING = "utf-8"; python -m coros_sync -P zhaochaoyi status

# Local FastAPI backend. STRIDE_ENV=dev keeps auth fail-open when no public key is configured.
$env:PYTHONIOENCODING = "utf-8"; $env:STRIDE_ENV = "dev"; python -m uvicorn stride_server.main:app --reload --port 8080

# Frontend
cd frontend
npm install
npm run dev
npm run api
npm run start
npm run build
npm run lint
npm run test
npx vitest run src\path\to\file.test.tsx -t "test name"

# Docker
docker build -t stride .
docker run -p 8080:8080 -v .\data:/app/data stride
```

## High-level architecture

This repository combines a COROS sync CLI, a source-agnostic data layer, a FastAPI API, and a Vite/React dashboard.

- `src/stride_core/` is the shared data layer. It owns SQLite schema/migrations (`db.py`), dataclasses and display helpers (`models.py`), analysis/export code, and the `DataSource` protocol in `source.py`. It must stay source-agnostic and should not import `coros_sync`.
- `src/coros_sync/` is the COROS-specific adapter and CLI. `client.py` wraps the unofficial COROS Training Hub API; `sync.py` discovers new activities, fetches details in parallel, writes sequentially to SQLite, then runs best-effort AOAI commentary and ability hooks; `adapter.py::CorosDataSource` implements `stride_core.source.DataSource`.
- `src/stride_server/` is the FastAPI server. `main.py` is the only composition root that wires `CorosDataSource` into `create_app()`. Routes get the adapter through `Depends(get_source)` and per-user SQLite handles through `get_db(user)`, not by importing COROS code directly.
- `frontend/` is a React + Vite + TypeScript SPA. `frontend/src/api.ts` calls `/api`, attaches `Authorization: Bearer` from `sessionStorage`, and retries once after refreshing tokens via `authStore.ts`. Vite proxies `/api` to the backend on port 8080 in dev.
- `data/{user_uuid}/` contains per-user SQLite DBs, COROS credentials, profiles, training plans, and weekly logs. Friendly slugs such as `zhaochaoyi` are resolved via `data/.slug_aliases.json`; API paths use UUIDs and enforce `{user}` == JWT `sub`.

Deployment has two separate data paths:

- Code/frontend changes trigger `.github/workflows/deploy.yml`, which builds the frontend, builds the Docker image, pushes to GHCR, deploys Azure Container Apps, and checks `/api/health`.
- Markdown/profile data changes trigger `.github/workflows/sync-data.yml`, which uploads weekly `plan.md`, `feedback.md`, InBody images, `TRAINING_PLAN.md`, `status.md`, and `profile.json` to Azure Files. SQLite-only rows such as `activity_commentary` are not covered by this workflow; push them through the CLI/API.

## Key conventions

- Use `PYTHONIOENCODING=utf-8` (PowerShell: `$env:PYTHONIOENCODING = "utf-8"`) for `coros_sync` commands on Windows to avoid Rich/Unicode console errors.
- Before answering questions about current status, load, fatigue, readiness, or training metrics, sync first with `python -m coros_sync -P {profile} sync`; default profile is `zhaochaoyi`.
- COROS API-to-internal unit conversion belongs in `stride_core.models.*.from_api()` classmethods. Do not scatter COROS unit conversions through routes or UI code.
- Dates are `YYYYMMDD` strings in COROS-facing CLI/model code. Pace is seconds per km internally and displayed with `pace_str()`.
- SQLite writes are idempotent upserts. CLI profile slugs are resolved before opening data; server routes and direct `Database(user=...)` handles should use the UUID directory name. Tests use temp DB paths/fixtures.
- Weekly `plan.md` files must cover running, strength/conditioning, and nutrition. Before drafting a new plan, review the current phase from `TRAINING_PLAN.md`, previous feedback, recent health/load metrics, and latest InBody data. Include fatigue/load context when creating weekly plans.
- Do not add a “已推送到 COROS 手表的训练” section to weekly plans. After editing a plan, remove duplicated or repeated content.
- `feedback.md` is generated/appended from actual data: `sport_note`/`feel_type` plus objective DB metrics. Do not create placeholder templates or overwrite existing feedback; append new feedback verbatim when syncing activity notes.
- `activity_commentary` rows carry `generated_by` and `generated_at`. AOAI drafts use `generated_by='gpt-4.1'` and sync never overwrites an existing row. Claude/Copilot-authored refinements must upsert locally with the producing model id and be pushed with `commentary push <label_id> --generated-by <model>`.
- For strength workouts, prefer COROS built-in exercises from `src/coros_sync/exercise_catalog.md` / `client.query_exercises(sport_type=4)`. Only create custom exercises when no built-in match exists; COROS names can differ from common Chinese exercise names.
- Running/strength workout dates use `YYYYMMDD`. Running workout pace targets in `workout.py` are milliseconds per km in the COROS payload; strength targets use `targetType` 2 for time seconds and 3 for reps.
- Server auth is fail-closed unless `STRIDE_ENV=dev` is set. Production uses `STRIDE_AUTH_PUBLIC_KEY_PEM` or `STRIDE_AUTH_PUBLIC_KEY_PATH`, validates RS256 JWTs, and checks user-path UUIDs against token `sub`.
- Keep all non-public `/api/*` routes behind the router-level auth dependencies in `stride_server.app`. `/api/health` is the public liveness endpoint and SPA fallback must remain last.
- Frontend auth is the in-house auth-service flow, not MSAL. Required frontend env vars are `VITE_AUTH_BASE_URL` and `VITE_AUTH_CLIENT_ID`; Application Insights is optional through `VITE_APPLICATIONINSIGHTS_CONNECTION_STRING`.
- When working under `data/f10bc353-01ab-4db1-af9f-d9305ea9a532/`, also follow that directory's `CLAUDE.md` athlete profile: chronic Achilles/ITB considerations, easy-day discipline, preferred COROS built-in strength exercises, and profile-specific collaboration rules.
