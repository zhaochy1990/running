"""Mount the built frontend for production — SPA fallback for client-side routes."""

from __future__ import annotations

import re
from os import stat_result
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response

from .deps import FRONTEND_DIR

IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"
STABLE_CACHE_CONTROL = "public, max-age=86400"
INDEX_CACHE_CONTROL = "no-cache"
HASHED_ASSET_PATTERN = re.compile(
    r"-(?=[A-Za-z0-9_-]{8}\.)(?=[A-Za-z0-9_-]*[A-Z0-9_])[A-Za-z0-9_-]{8}(?=\.)"
)


class CacheControlledStaticFiles(StaticFiles):
    """Serve content-hashed build assets with an immutable cache policy."""

    def file_response(
        self,
        full_path: Path,
        stat_result: stat_result,
        scope: dict,
        status_code: int = 200,
    ) -> Response:
        response = super().file_response(full_path, stat_result, scope, status_code)
        response.headers["Cache-Control"] = (
            IMMUTABLE_CACHE_CONTROL
            if HASHED_ASSET_PATTERN.search(Path(full_path).name)
            else INDEX_CACHE_CONTROL
        )
        return response


def _frontend_file_response(file_path: Path, *, is_index: bool = False) -> FileResponse:
    cache_control = INDEX_CACHE_CONTROL if is_index else STABLE_CACHE_CONTROL
    return FileResponse(file_path, headers={"Cache-Control": cache_control})


def mount_frontend(app: FastAPI) -> None:
    if not FRONTEND_DIR.exists():
        return

    app.mount(
        "/assets",
        CacheControlledStaticFiles(directory=FRONTEND_DIR / "assets"),
        name="assets",
    )

    frontend_root = FRONTEND_DIR.resolve()

    @app.get("/{filename:path}")
    async def serve_spa(filename: str) -> FileResponse:
        file_path = (frontend_root / filename).resolve()
        if (
            filename
            and file_path.is_relative_to(frontend_root)
            and file_path.exists()
            and file_path.is_file()
        ):
            return _frontend_file_response(
                file_path,
                is_index=file_path.name == "index.html",
            )
        return _frontend_file_response(frontend_root / "index.html", is_index=True)
