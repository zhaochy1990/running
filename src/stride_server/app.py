"""App factory — composes the FastAPI app with a pluggable DataSource.

The factory accepts any DataSource-conforming adapter. Routes retrieve it from
app.state via the `get_source` dependency, so they never import a specific
adapter (see .deps.get_source).
"""

from __future__ import annotations

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from stride_core.source import DataSource

from .bearer import require_bearer
from .routes import activities, health, inbody, public, sync, training_plan, users, weeks
from .static import mount_frontend


def create_app(source: DataSource) -> FastAPI:
    app = FastAPI(title="STRIDE - Running Dashboard API")
    app.state.source = source

    # CORS is intentionally permissive (`*`) — the real authz boundary lives
    # at the Bearer layer applied per-router below.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Public routes (no auth) — liveness probe, must stay open for Azure.
    app.include_router(public.router)

    # Every other router sits behind require_bearer. Writes that previously
    # had per-endpoint Depends(require_bearer) still work (dependency runs
    # once per request regardless of where it's declared).
    protected = [Depends(require_bearer)]
    app.include_router(users.router, dependencies=protected)
    app.include_router(activities.router, dependencies=protected)
    app.include_router(weeks.router, dependencies=protected)
    app.include_router(sync.router, dependencies=protected)
    app.include_router(training_plan.router, dependencies=protected)
    app.include_router(health.router, dependencies=protected)
    app.include_router(inbody.router, dependencies=protected)

    # SPA fallback must be last so it doesn't swallow /api/* paths.
    mount_frontend(app)
    return app
