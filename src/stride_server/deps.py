"""Shared helpers and constants used across stride_server routes.

These are deliberately source-agnostic: they only depend on stride_core. The
DataSource adapter is injected at app-factory time and retrieved via
`request.app.state.source` inside route handlers — not imported here.
"""

from __future__ import annotations

import re
from pathlib import Path

from fastapi import HTTPException, Request, status

from stride_core.db import USER_DATA_DIR, Database
from stride_core.source import DataSource

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
FRONTEND_DIR = PROJECT_ROOT / "frontend" / "dist"

_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


def _validate_uuid(uuid: str) -> str:
    if not _UUID4_RE.match(uuid or ""):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid user identifier",
        )
    return uuid


# COROS exercise T-code -> Chinese name mapping.
# Lives here (not in stride_core) because it is display-layer data; a non-COROS
# adapter would provide its own mapping via the source in future.
EXERCISE_NAMES: dict[str, str] = {
    "T1001": "搏击操", "T1002": "引体向上", "T1004": "俯卧撑", "T1005": "跳绳",
    "T1006": "仰卧起坐", "T1007": "波比跳", "T1009": "开合跳", "T1010": "平板支撑",
    "T1011": "哑铃体侧屈", "T1013": "高抬腿", "T1014": "跳箱", "T1035": "仰卧举腿",
    "T1076": "自行车卷腹", "T1079": "登山跑", "T1106": "弹力带反向飞鸟",
    "T1120": "热身", "T1121": "训练", "T1122": "放松", "T1123": "休息",
    "T1145": "俄罗斯转体", "T1150": "鸟狗式", "T1185": "侧平板",
    "T1243": "死虫式", "T1320": "弹力带肩外旋", "T1324": "弹力带肩推",
    "T1364": "药球俄罗斯转体", "T1368": "哥本哈根侧平板",
    "T1384": "泡沫轴-髋部", "T1385": "泡沫轴-腘绳肌",
    "T1386": "泡沫轴-髂胫束", "T1387": "泡沫轴-股四头肌", "T1389": "泡沫轴-小腿",
    "S3618": "休息",
}


def get_db(user: str) -> Database:
    _validate_uuid(user)
    return Database(user=user)


def get_logs_dir(user: str) -> Path:
    _validate_uuid(user)
    return USER_DATA_DIR / user / "logs"


def format_duration(seconds: float | None) -> str:
    if not seconds:
        return "—"
    s = int(seconds)
    hrs, rem = divmod(s, 3600)
    mins, secs = divmod(rem, 60)
    return f"{hrs:02d}:{mins:02d}:{secs:02d}"


def exercise_name(key: str) -> str:
    """Resolve exercise T-code to Chinese name, fallback to cleaned key."""
    if key in EXERCISE_NAMES:
        return EXERCISE_NAMES[key]
    return key.replace("sid_strength_", "").replace("_", " ").title()


def parse_week_dates(folder_name: str) -> tuple[str, str] | None:
    """Parse '2026-04-13_04-19(赛后恢复)' → ('2026-04-13', '2026-04-19')."""
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})", folder_name)
    if not m:
        return None
    year = int(m.group(1))
    sm, sd = int(m.group(2)), int(m.group(3))
    em, ed = int(m.group(4)), int(m.group(5))
    return f"{year}-{sm:02d}-{sd:02d}", f"{year}-{em:02d}-{ed:02d}"


def get_source(request: Request) -> DataSource:
    """FastAPI dependency — retrieve the configured DataSource from app state."""
    source: DataSource = request.app.state.source
    return source
