"""Mount the built frontend for production — SPA fallback for client-side routes."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .deps import FRONTEND_DIR


def mount_frontend(app: FastAPI) -> None:
    if not FRONTEND_DIR.exists():
        return

    app.mount("/assets", StaticFiles(directory=FRONTEND_DIR / "assets"), name="assets")

    @app.get("/{filename:path}")
    async def serve_spa(filename: str):
        file_path = FRONTEND_DIR / filename
        if filename and file_path.exists() and file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(FRONTEND_DIR / "index.html")
