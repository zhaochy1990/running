"""stride_server: FastAPI backend for the STRIDE dashboard.

Routes are source-agnostic — they consume the DataSource protocol via
request.app.state.source, wired at composition root (stride_server.main).
"""

from .app import create_app

__all__ = ["create_app"]
