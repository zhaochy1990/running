"""App factory — composes the FastAPI app with a pluggable DataSource.

The factory accepts any DataSource-conforming adapter. Routes retrieve it from
app.state via the `get_source` dependency, so they never import a specific
adapter (see .deps.get_source).
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from stride_core.source import DataSource

from .routes import activities, health, sync, training_plan, users, weeks
from .static import mount_frontend


def create_app(source: DataSource) -> FastAPI:
    app = FastAPI(title="STRIDE - Running Dashboard API")
    app.state.source = source

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Register API routers first — SPA fallback (mount_frontend) must be last
    # so it doesn't swallow /api/* paths.
    app.include_router(users.router)
    app.include_router(activities.router)
    app.include_router(weeks.router)
    app.include_router(sync.router)
    app.include_router(training_plan.router)
    app.include_router(health.router)

    mount_frontend(app)
    return app
