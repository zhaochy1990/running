from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from stride_server import static as static_module
from stride_server.app import _add_http_middleware


IMMUTABLE_CACHE = "public, max-age=31536000, immutable"
STABLE_CACHE = "public, max-age=86400"


def _build_client(monkeypatch, tmp_path: Path) -> TestClient:
    frontend_dir = tmp_path / "dist"
    (frontend_dir / "assets").mkdir(parents=True)
    (frontend_dir / "fonts").mkdir()
    (frontend_dir / "index.html").write_text("<main>STRIDE</main>", encoding="utf-8")
    (frontend_dir / "favicon.svg").write_text("<svg></svg>", encoding="utf-8")
    (frontend_dir / "assets" / "index-ABCDEFGH.js").write_text(
        "const stride = 'performance';\n" * 200,
        encoding="utf-8",
    )
    for asset_name in ("runtime-config.json", "app-manifest.json", "runtime-settings.json"):
        (frontend_dir / "assets" / asset_name).write_text(
            '{"version": 1}',
            encoding="utf-8",
        )
    (frontend_dir / "fonts" / "outfit-latin.woff2").write_bytes(b"font-data")
    monkeypatch.setattr(static_module, "FRONTEND_DIR", frontend_dir)

    app = FastAPI()
    _add_http_middleware(app)
    static_module.mount_frontend(app)
    return TestClient(app)


def test_hashed_assets_are_immutable_and_gzipped(monkeypatch, tmp_path: Path) -> None:
    client = _build_client(monkeypatch, tmp_path)

    response = client.get(
        "/assets/index-ABCDEFGH.js",
        headers={"Accept-Encoding": "gzip"},
    )

    assert response.status_code == 200
    assert response.headers["cache-control"] == IMMUTABLE_CACHE
    assert response.headers["content-encoding"] == "gzip"
    assert "Accept-Encoding" in response.headers["vary"]
    # TestClient transparently decompresses the body while preserving headers.
    assert response.text.startswith("const stride")


def test_non_hashed_assets_require_revalidation(monkeypatch, tmp_path: Path) -> None:
    client = _build_client(monkeypatch, tmp_path)

    for asset_name in ("runtime-config.json", "app-manifest.json", "runtime-settings.json"):
        response = client.get(
            f"/assets/{asset_name}",
            headers={"Accept-Encoding": "identity"},
        )

        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-cache"


def test_index_and_spa_fallback_require_revalidation(monkeypatch, tmp_path: Path) -> None:
    client = _build_client(monkeypatch, tmp_path)

    index_response = client.get("/", headers={"Accept-Encoding": "identity"})
    fallback_response = client.get(
        "/week/current",
        headers={"Accept-Encoding": "identity"},
    )

    assert index_response.status_code == 200
    assert fallback_response.status_code == 200
    assert index_response.headers["cache-control"] == "no-cache"
    assert fallback_response.headers["cache-control"] == "no-cache"
    assert fallback_response.text == "<main>STRIDE</main>"


def test_spa_fallback_cannot_escape_frontend_directory(monkeypatch, tmp_path: Path) -> None:
    client = _build_client(monkeypatch, tmp_path)
    secret_path = tmp_path / "secret.txt"
    secret_path.write_text("SECRET", encoding="utf-8")

    response = client.get("/%2e%2e/secret.txt")

    assert response.status_code == 200
    assert response.text == "<main>STRIDE</main>"
    assert "SECRET" not in response.text
    assert response.headers["cache-control"] == "no-cache"


def test_stable_public_files_use_one_day_cache(monkeypatch, tmp_path: Path) -> None:
    client = _build_client(monkeypatch, tmp_path)

    font_response = client.get(
        "/fonts/outfit-latin.woff2",
        headers={"Accept-Encoding": "identity"},
    )
    favicon_response = client.get(
        "/favicon.svg",
        headers={"Accept-Encoding": "identity"},
    )

    assert font_response.status_code == 200
    assert favicon_response.status_code == 200
    assert font_response.headers["cache-control"] == STABLE_CACHE
    assert favicon_response.headers["cache-control"] == STABLE_CACHE
    assert "immutable" not in font_response.headers["cache-control"]


def test_range_response_is_not_gzipped(monkeypatch, tmp_path: Path) -> None:
    client = _build_client(monkeypatch, tmp_path)

    response = client.get(
        "/assets/index-ABCDEFGH.js",
        headers={"Accept-Encoding": "gzip", "Range": "bytes=0-1999"},
    )

    assert response.status_code == 206
    assert "content-encoding" not in response.headers
    assert response.headers["content-range"].startswith("bytes 0-1999/")
