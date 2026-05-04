"""App factory — composes the FastAPI app with a pluggable DataSource.

The factory accepts either a single `DataSource` (back-compat: that adapter
serves all users) or a `ProviderRegistry` (multi-provider: each user is
dispatched to their configured adapter via `get_source_for_user`).
Routes retrieve their adapter via the `get_source` / `get_source_for_user`
dependencies, so they never import a specific adapter.
"""

from __future__ import annotations

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from stride_core.registry import ProviderRegistry
from stride_core.source import DataSource

from .bearer import _load_public_key, is_dev_mode, require_bearer, verify_path_user
from .routes import account, ability, activities, health, inbody, likes, onboarding, plan, plan_variants, profile, public, sync, teams, training_plan, users, weeks, workouts
from .static import mount_frontend


def create_app(source_or_registry: DataSource | ProviderRegistry) -> FastAPI:
    # Fail-closed: in non-dev environments the auth public key must be set so
    # Bearer verification is enforced. Dev mode (STRIDE_ENV=dev) keeps the
    # legacy fail-open behaviour with a one-time warning.
    if _load_public_key() is None and not is_dev_mode():
        raise RuntimeError(
            "STRIDE auth not configured: set STRIDE_AUTH_PUBLIC_KEY_PEM or "
            "STRIDE_AUTH_PUBLIC_KEY_PATH for production, or STRIDE_ENV=dev "
            "for local development."
        )

    # Normalize to a registry. Single-adapter callers (existing tests + the
    # current main.py until rolled over) get auto-wrapped in a one-entry
    # registry. `app.state.source` keeps pointing at the default adapter for
    # back-compat with `Depends(get_source)`; new code uses `get_source_for_user`.
    if isinstance(source_or_registry, ProviderRegistry):
        registry = source_or_registry
        if len(registry) == 0:
            raise RuntimeError("ProviderRegistry passed to create_app() is empty")
        default_name = registry.default_name() or next(iter(registry.names()))
        default_source: DataSource = registry.get(default_name)
    else:
        registry = ProviderRegistry()
        registry.register(source_or_registry, default=True)
        default_source = source_or_registry

    app = FastAPI(title="STRIDE - Running Dashboard API")
    app.state.source = default_source
    app.state.registry = registry

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
    app.include_router(account.router, dependencies=protected)
    app.include_router(profile.router, dependencies=protected)
    app.include_router(onboarding.router, dependencies=protected)
    app.include_router(teams.router, dependencies=protected)
    app.include_router(likes.router, dependencies=protected)
    app.include_router(activities.router, dependencies=protected_user)
    app.include_router(weeks.router, dependencies=protected_user)
    app.include_router(sync.router, dependencies=protected_user)
    app.include_router(training_plan.router, dependencies=protected_user)
    app.include_router(health.router, dependencies=protected_user)
    app.include_router(inbody.router, dependencies=protected_user)
    app.include_router(ability.router, dependencies=protected_user)
    app.include_router(workouts.router, dependencies=protected_user)
    app.include_router(plan.router, dependencies=protected_user)
    app.include_router(plan_variants.router, dependencies=protected_user)

    # Internal webhook router — gated by X-Internal-Token, NOT bearer JWT.
    # Path is /internal/... (not /api/internal/...) so future bearer-prefix
    # middleware on /api/* cannot accidentally catch it.
    app.include_router(plan.internal_router)

    # SPA fallback must be last so it doesn't swallow /api/* paths.
    mount_frontend(app)
    return app
