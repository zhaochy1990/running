"""Regression: `stride_storage` Tier-A/B imports must NOT require the Azure SDK.

This guards the coach unit-testability invariant — coach (and its tests) may
import `stride_storage.interfaces` without `azure` installed/importable. We run the
imports in a subprocess whose import system actively rejects any `azure`
import, so a transitive azure edge (even a function-level one) would surface
as an ImportError.

Pairs with `.importlinter` Contract 5 (static guard); this is the runtime
guard that also covers the package `__init__` not eagerly importing azure.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SRC = _REPO_ROOT / "src"

# Modules that coach (and any azure-free consumer) must be able to import.
_AZURE_FREE_MODULES = [
    "stride_storage",
    "stride_storage.interfaces",
    "stride_storage.interfaces.config",
    "stride_storage.sqlite",
    "stride_storage.content",
]

_PROGRAM = """
import importlib
import sys

class _BlockOptionalStorageSDKs:
    def find_spec(self, name, path=None, target=None):
        top = name.split(".", 1)[0]
        if top in {"azure", "sqlalchemy", "pymysql"}:
            raise ImportError(f"optional storage SDK import is blocked in this test: {name}")
        return None

sys.meta_path.insert(0, _BlockOptionalStorageSDKs())

mods = %r
for m in mods:
    importlib.import_module(m)
print("OK")
"""


def test_storage_ports_import_without_optional_storage_sdks() -> None:
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(_SRC), env.get("PYTHONPATH", "")],
    ).rstrip(os.pathsep)

    result = subprocess.run(
        [sys.executable, "-c", _PROGRAM % (_AZURE_FREE_MODULES,)],
        capture_output=True,
        text=True,
        env=env,
        cwd=str(_REPO_ROOT),
    )

    assert result.returncode == 0, (
        "optional-SDK-free import of stride_storage.interfaces failed:\n"
        f"stdout:\n{result.stdout}\n\nstderr:\n{result.stderr}"
    )
    assert "OK" in result.stdout
