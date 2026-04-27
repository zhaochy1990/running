"""App factory — composes the FastAPI app with a pluggable DataSource.

The factory accepts any DataSource-conforming adapter. Routes retrieve it from
app.state via the `get_source` dependency, so they never import a specific
adapter (see .deps.get_source).
"""

from __future__ import annotations

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from stride_core.source import DataSource

from .bearer import _load_public_key, is_dev_mode, require_bearer, verify_path_user
from .routes import ability, activities, health, inbody, onboarding, profile, public, sync, training_plan, users, weeks
from .static import mount_frontend


def create_app(source: DataSource) -> FastAPI:
    # Fail-closed: in non-dev environments the auth public key must be set so
    # Bearer verification is enforced. Dev mode (STRIDE_ENV=dev) keeps the
    # legacy fail-open behaviour with a one-time warning.
    if _load_public_key() is None and not is_dev_mode():
        raise RuntimeError(
            "STRIDE auth not configured: set STRIDE_AUTH_PUBLIC_KEY_PEM or "
            "STRIDE_AUTH_PUBLIC_KEY_PATH for production, or STRIDE_ENV=dev "
            "for local development."
        )

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

    # Routers with /api/{user}/... paths also enforce that the path UUID
    # matches the JWT sub claim (403 on mismatch). The users list and
    # health/public routers are exempt — they don't have a {user} path param.
    protected_user = [Depends(verify_path_user)]

    app.include_router(users.router, dependencies=protected)
    app.include_router(profile.router, dependencies=protected)
    app.include_router(onboarding.router, dependencies=protected)
    app.include_router(activities.router, dependencies=protected_user)
    app.include_router(weeks.router, dependencies=protected_user)
    app.include_router(sync.router, dependencies=protected_user)
    app.include_router(training_plan.router, dependencies=protected_user)
    app.include_router(health.router, dependencies=protected_user)
    app.include_router(inbody.router, dependencies=protected_user)
    app.include_router(ability.router, dependencies=protected_user)

    # SPA fallback must be last so it doesn't swallow /api/* paths.
    mount_frontend(app)
    return app
