# STRIDE Python API backend image (stride-app).
#
# ADR 0017: the frontend SPA and the strength-illustration *byte* serving now
# live in the separate `stride-web` image (built from Dockerfile.web) — the
# single user-facing front door. This image is API-only; it no longer builds or
# ships `frontend/dist`. `strength_illustrations/` is still COPYed in below
# because `strength_library.py` reads it on disk to construct the image URLs the
# BFF then serves same-origin.
FROM python:3.13-slim
WORKDIR /app

# pyproject.toml + src must be present BEFORE the editable install. The
# editable install (PEP 660) writes a .pth file pointing at /app/src, so
# Path(__file__) on every package resolves to /app/src/<pkg>/<file>.py at
# runtime — keeping PROJECT_ROOT / USER_DATA_DIR / FRONTEND_DIR computations
# correct (they walk up from __file__ to /app/).
COPY pyproject.toml ./
COPY src/ ./src/

# Copy admin / one-shot scripts (backfill, schedule inspection, etc.).
# Invoked manually via `az containerapp exec` against the running revision —
# they are not part of the request-serving path.
COPY scripts/ ./scripts/

# Coach runtime config — coach.runtime.config.load_config() reads this at
# request time to resolve the role→deployment mapping. Without this COPY
# the coach endpoints 500 with CoachConfigError at first invocation.
#
# `config/coach.toml` in the repo is the LOCAL DEV override (per-developer,
# points at a dev endpoint / deployment). Production must use `coach.prod.toml`.
# After COPY, overwrite coach.toml with coach.prod.toml so the default config
# resolver (`<repo-root>/config/coach.toml`) picks up prod values.
#
# We `cp` (not `mv`) so coach.prod.toml stays on the image — that way a future
# deployment that points `STRIDE_COACH_CONFIG_PATH` at `coach.prod.toml`
# explicitly still finds the file instead of hitting CoachConfigError.
COPY config/ ./config/
RUN cp ./config/coach.prod.toml ./config/coach.toml

# coach_eval is the dev-only offline evaluation framework — never invoked
# from a prod route. Strip it from the image to keep the surface area small
# and to make accidental imports impossible at runtime. The `.importlinter`
# `coach-eval-dev-only` contract is the static guard; this is the runtime
# guard. (See `src/coach_eval/__init__.py` for the rationale.)
#
# The CLI entrypoint `scripts/eval_coach.py` imports `coach_eval` — strip it
# too so the prod image doesn't ship a broken script that would crash on
# import if anything (cron, ad-hoc shell) tried to run it.
RUN rm -rf /app/src/coach_eval || true
RUN rm -f /app/scripts/eval_coach.py || true

# Single source of truth for deps: pyproject.toml [project.optional-dependencies].
# Editable install (-e) keeps /app/src as the import location — no file copy
# into site-packages, so __file__-based path resolution stays correct.
RUN pip install --no-cache-dir -e ".[web,analysis]"

# Copy training plans as defaults (Azure Files mount may overlay at runtime)
COPY data/ ./data/

# Strength illustration library — ships baked into the image (image data,
# not per-user data; not affected by the data/ Azure Files mount).
COPY strength_illustrations/ ./strength_illustrations/

# Editable install adds /app/src via .pth so PYTHONPATH is redundant. Keep
# it as a defensive backstop in case any subprocess / spawned helper reads
# sys.path before the .pth file is processed.
ENV PYTHONPATH=/app/src

# Data directory (Azure Files mount point at runtime)
RUN mkdir -p /app/data

EXPOSE 8080
CMD ["uvicorn", "stride_server.main:app", "--host", "0.0.0.0", "--port", "8080"]
