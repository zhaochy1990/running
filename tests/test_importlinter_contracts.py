from __future__ import annotations

import configparser
from pathlib import Path


def test_running_calibration_core_has_import_isolation_contract():
    config = configparser.ConfigParser()
    config.read(Path(__file__).resolve().parents[1] / ".importlinter")
    section = "importlinter:contract:running-calibration-core-isolation"

    assert section in config
    source_modules = config[section]["source_modules"].split()
    forbidden_modules = config[section]["forbidden_modules"].split()
    assert "stride_core.running_calibration.core" in source_modules
    assert "stride_core.running_calibration.segments" in source_modules
    assert "stride_core.running_calibration.zones" in source_modules
    assert "stride_core.running_calibration.prediction" in source_modules
    assert "stride_core.db" in forbidden_modules
    assert "stride_storage.mysql" in forbidden_modules
    assert "sqlalchemy" in forbidden_modules
    assert "pymysql" in forbidden_modules
    assert "stride_server" in forbidden_modules


def test_storage_cannot_import_server_contract():
    config = configparser.ConfigParser()
    config.read(Path(__file__).resolve().parents[1] / ".importlinter")
    section = "importlinter:contract:storage-no-server-import"

    assert section in config
    assert "stride_storage" in config[section]["source_modules"].split()
    assert "stride_server" in config[section]["forbidden_modules"].split()
