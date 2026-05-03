# STRIDE / coros-sync Project

## Project Overview

STRIDE is a comprehensive application for synchronizing, analyzing, and visualizing running and health data from COROS watches. It operates on a **Local Authoring + Cloud Draft-Writer** model, where local instances (powered by SQLite and Markdown files) act as the authoritative source for training plans and logs, while a cloud-deployed Azure Container App (STRIDE dashboard) serves as the reader environment and auto-generates commentary drafts using Azure OpenAI.

The project is structured into two main components:
1.  **Backend (`src/`):** A Python-based CLI tool (`coros-sync`) and a FastAPI server (`stride_server`). It handles data synchronization from the unofficial COROS API, SQLite database management, and serves the frontend. 
2.  **Frontend (`frontend/`):** A React SPA (Single Page Application) built with Vite, TypeScript, Tailwind CSS, and Zustand for state management, serving as the STRIDE dashboard.

## Tech Stack

*   **Backend:** Python 3.11+, FastAPI, SQLite (with WAL mode), `click` (CLI), `httpx`, `pandas`, `matplotlib`, `pytest`. Packaging is managed by `hatchling` (`pyproject.toml`).
*   **Frontend:** React 19, TypeScript, Vite, Tailwind CSS v4, Zustand, Recharts, React Router.
*   **Deployment:** Docker, Azure Container Apps, GitHub Actions (`deploy.yml`, `sync-data.yml`).

## Directory Structure

*   `src/`: Core Python source code.
    *   `coros_sync/`: COROS unofficial API client, sync logic, and CLI tool.
    *   `stride_core/`: Shared data layer, models, and SQLite database interface.
    *   `stride_server/`: FastAPI server routes and application setup.
*   `frontend/`: React + Vite frontend source code.
*   `data/`: Local storage for user-specific data. Each user has a UUID-keyed directory containing their `coros.db` (SQLite), `config.json` (credentials), and training logs (Markdown).
*   `tests/`: Standardized Python test suite using `pytest`.

## Architecture & Data Flow

*   **Multi-tenant Data:** Data is strictly isolated per user within `data/{user_id}/`. The `{user_id}` is a UUID mapped from friendly slugs via `data/.slug_aliases.json`.
*   **Database:** Local SQLite database (`coros.db`) stores activities, laps, zones, timeseries, and daily health data synced from COROS.
*   **Training Plans & Logs:** Weekly plans (`plan.md`) and feedback (`feedback.md`) are stored as Markdown in `data/{user_id}/logs/`. This content is authoritative and pushed to the cloud via Git and GitHub Actions (`sync-data.yml`).
*   **Authentication:** Integrates with an in-house Auth Service (OAuth2 + JWT with PKCE). The FastAPI server validates RS256 Bearer tokens, and the frontend handles token lifecycles via `sessionStorage`.

## Building, Running, and Testing

### Backend / CLI setup

```bash
# Install the project with development and analysis extras
pip install -e ".[dev,analysis,web]"

# Run the CLI tool (requires configuring user profiles)
# Set PYTHONIOENCODING=utf-8 on Windows for proper terminal rendering
PYTHONIOENCODING=utf-8 python -m coros_sync -P <user_slug> sync

# Run the FastAPI server locally
PYTHONIOENCODING=utf-8 uvicorn stride_server.main:app --reload --port 8080
```

### Frontend Setup

```bash
cd frontend
npm install

# Run the Vite development server
npm run dev

# Run both the development server and the API concurrently
npm run start
```

### Testing

```bash
# Run the Python test suite
pytest

# Run a specific test file
pytest tests/test_db.py
```

## Development Conventions

*   **CLI Usage:** Tools are exposed via the `coros-sync` CLI. Use `-P` or `--profile` to specify the target user context.
*   **Data Models:** Models act as the single unit-conversion boundary from external APIs. Ensure consistent unit handling (Dates as `YYYYMMDD`, Pace as seconds-per-km).
*   **Database Operations:** Use `INSERT OR REPLACE` for idempotent database upserts.
*   **Code Style Check:** There's an ESLint config in the frontend (`npm run lint`), and Python code should adhere to standard modern Python typed practices.
*   **Cloud Operations:** Read operations check via local DB or markdown files, but when changing AI commentaries and plans, use `coros-sync commentary push` to sync back row-level AI drafts to the STRIDE production instance.