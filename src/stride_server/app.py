"""App factory — composes the FastAPI app with a pluggable DataSource.

The factory accepts either a single `DataSource` (back-compat: that adapter
serves all users) or a `ProviderRegistry` (multi-provider: each user is
dispatched to their configured adapter via `get_source_for_user`).
Routes retrieve their adapter via the `get_source` / `get_source_for_user`
dependencies, so they never import a specific adapter.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from stride_core.registry import ProviderRegistry
from stride_core.source import DataSource

from stride_server.config import load_server_config
from stride_server.config.models import ServerConfig

from .bearer import load_public_key_from_config, require_bearer, verify_path_user
from .deps import PROJECT_ROOT

logger = logging.getLogger(__name__)


@asynccontextmanager
async def _lifespan(app: FastAPI):
    """Startup: reconcile stale coach jobs (plan §8.3, Pattern A).

    On every container start we scan ``stridecoachjobs`` for rows still in
    ``RUNNING`` whose ``heartbeat_at`` is older than the threshold and mark
    them FAILED with ``error_code='interrupted_by_restart'``. This is what
    keeps Pattern A safe under ACA restarts at ``--max-replicas 1``.
    """
    try:
        from .coach_adapters.job_scheduler import JobScheduler
        from .coach_adapters.persistence.jobs_store import jobs_store_from_env

        scheduler = JobScheduler(jobs_store_from_env())
        swept = scheduler.reconcile_stale_jobs()
        if swept:
            logger.warning(
                "lifespan startup reconcile: marked %d running coach jobs FAILED "
                "(interrupted_by_restart): %s",
                len(swept),
                swept,
            )
        else:
            logger.info("lifespan startup reconcile: no stale coach jobs to sweep")
    except Exception:  # noqa: BLE001 — startup must not break the app
        logger.exception("lifespan startup reconcile failed; continuing without sweep")
    yield
    # Shutdown: nothing special.
from .routes import account, ability, activities, body_composition, coach, feedback, generate, health, home, likes, master_plan, notifications, nutrition_daily, nutrition_meals, nutrition_prefs, onboarding, plan, plan_variants, pbs, predictions, profile, public, review, running_profile, strength, stride, sync, teams, training_goal, training_load, training_plan, users, watch, weeks, workouts
from .static import mount_frontend


def create_app(
    source_or_registry: DataSource | ProviderRegistry,
    config: ServerConfig | None = None,
) -> FastAPI:
    config = config or load_server_config()
    # Fail-closed unless config explicitly permits local insecure auth.
    if load_public_key_from_config(config.auth) is None and not config.auth.allow_insecure_without_key:
        raise RuntimeError(
            "STRIDE auth not configured: set auth.public_key_pem/path or "
            "allow_insecure_without_key=true for local development."
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

    app = FastAPI(title="STRIDE - Running Dashboard API", lifespan=_lifespan)
    app.state.config = config
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
    app.include_router(training_goal.router, dependencies=protected)
    app.include_router(nutrition_prefs.router, dependencies=protected)
    app.include_router(running_profile.router, dependencies=protected)
    app.include_router(master_plan.router, dependencies=protected)
    app.include_router(teams.router, dependencies=protected)
    app.include_router(likes.router, dependencies=protected)
    app.include_router(notifications.router, dependencies=protected)
    app.include_router(watch.router, dependencies=protected)
    app.include_router(activities.router, dependencies=protected_user)
    app.include_router(home.router, dependencies=protected_user)
    app.include_router(weeks.router, dependencies=protected_user)
    app.include_router(sync.router, dependencies=protected_user)
    app.include_router(training_plan.router, dependencies=protected_user)
    app.include_router(health.router, dependencies=protected_user)
    app.include_router(body_composition.router, dependencies=protected_user)
    app.include_router(ability.router, dependencies=protected_user)
    app.include_router(stride.router, dependencies=protected_user)
    app.include_router(workouts.router, dependencies=protected_user)
    app.include_router(plan.router, dependencies=protected_user)
    app.include_router(plan_variants.router, dependencies=protected_user)
    app.include_router(generate.router, dependencies=protected_user)
    app.include_router(strength.router, dependencies=protected_user)
    app.include_router(feedback.router, dependencies=protected_user)
    app.include_router(review.router, dependencies=protected_user)
    app.include_router(pbs.router, dependencies=protected_user)
    app.include_router(predictions.router, dependencies=protected_user)
    app.include_router(nutrition_meals.router, dependencies=protected_user)
    app.include_router(nutrition_daily.router, dependencies=protected_user)
    # Coach endpoints: paths are /api/users/me/... so they sit under the
    # generic `protected` (require_bearer) chain — the owner check happens
    # inside each handler against payload["sub"] rather than via the path.
    app.include_router(coach.router, dependencies=protected)

    # Internal webhook router — gated by X-Internal-Token, NOT bearer JWT.
    # Path is /internal/... (not /api/internal/...) so future bearer-prefix
    # middleware on /api/* cannot accidentally catch it.
    app.include_router(plan.internal_router)
    app.include_router(training_load.internal_router)
    app.include_router(sync.internal_router)
    app.include_router(notifications.internal_router)

    # Curated strength-illustration library — public static assets baked
    # into the image. Mount BEFORE the SPA fallback so the catch-all in
    # static.py doesn't swallow these paths.
    strength_lib_dir = PROJECT_ROOT / "strength_illustrations" / "output"
    if strength_lib_dir.exists():
        app.mount(
            "/strength_illustrations/output",
            StaticFiles(directory=strength_lib_dir),
            name="strength_illustrations",
        )

    # SPA fallback must be last so it doesn't swallow /api/* paths.
    mount_frontend(app)
    return app
