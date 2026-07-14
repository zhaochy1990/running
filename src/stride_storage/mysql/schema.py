"""Canonical SQLAlchemy Core metadata — initial dormant schema slice.

This first slice defines activities + sync_meta only. It is deliberately not
wired into production and will grow behind backend contract tests.
"""

from __future__ import annotations

from sqlalchemy import Column, Computed, Date, Index, Integer, MetaData, String, Table, Text, text
from sqlalchemy.dialects.mysql import CHAR, DATETIME, DOUBLE, JSON, VARCHAR

metadata = MetaData()

activities = Table(
    "activities",
    metadata,
    Column("user_id", CHAR(36, charset="ascii", collation="ascii_bin"), primary_key=True, nullable=False),
    Column("label_id", VARCHAR(128, charset="ascii", collation="ascii_bin"), primary_key=True, nullable=False),
    Column("name", Text),
    Column("sport_type", Integer, nullable=False),
    Column("sport_name", String(128)),
    Column("date", DATETIME(fsp=6), nullable=False),
    Column("distance_m", DOUBLE(asdecimal=False)),
    Column("duration_s", DOUBLE(asdecimal=False)),
    Column("avg_pace_s_km", DOUBLE(asdecimal=False)),
    Column("adjusted_pace", DOUBLE(asdecimal=False)),
    Column("best_km_pace", DOUBLE(asdecimal=False)),
    Column("max_pace", DOUBLE(asdecimal=False)),
    Column("avg_hr", Integer),
    Column("max_hr", Integer),
    Column("avg_cadence", Integer),
    Column("max_cadence", Integer),
    Column("avg_power", Integer),
    Column("max_power", Integer),
    Column("avg_step_len_cm", DOUBLE(asdecimal=False)),
    Column("ascent_m", DOUBLE(asdecimal=False)),
    Column("descent_m", DOUBLE(asdecimal=False)),
    Column("calories_kcal", Integer),
    Column("aerobic_effect", DOUBLE(asdecimal=False)),
    Column("anaerobic_effect", DOUBLE(asdecimal=False)),
    Column("training_load", DOUBLE(asdecimal=False)),
    Column("vo2max", DOUBLE(asdecimal=False)),
    Column("performance", DOUBLE(asdecimal=False)),
    Column("train_type", String(128)),
    Column("temperature", DOUBLE(asdecimal=False)),
    Column("humidity", DOUBLE(asdecimal=False)),
    Column("feels_like", DOUBLE(asdecimal=False)),
    Column("wind_speed", DOUBLE(asdecimal=False)),
    Column("device", String(255)),
    Column("feel_type", Integer),
    Column("sport_note", Text),
    Column("sport", String(64)),
    Column("train_kind", String(64)),
    Column("feel", String(64)),
    Column("provider", String(32), nullable=False, server_default=text("'coros'")),
    Column("vertical_oscillation_mm", DOUBLE(asdecimal=False)),
    Column("ground_contact_time_ms", DOUBLE(asdecimal=False)),
    Column("vertical_ratio_pct", DOUBLE(asdecimal=False)),
    Column("pauses", JSON),
    Column("route_thumb_json", JSON),
    Column("synced_at", DATETIME(fsp=6), nullable=False, server_default=text("CURRENT_TIMESTAMP(6)")),
    Column(
        "shanghai_date",
        Date,
        Computed("DATE(`date` + INTERVAL 8 HOUR)", persisted=True),
    ),
    mysql_engine="InnoDB",
    mysql_charset="utf8mb4",
)

Index("idx_activities_user_date", activities.c.user_id, activities.c.date)
Index("idx_activities_user_shanghai_day", activities.c.user_id, activities.c.shanghai_date)

sync_meta = Table(
    "sync_meta",
    metadata,
    Column("user_id", CHAR(36, charset="ascii", collation="ascii_bin"), primary_key=True, nullable=False),
    Column("key", VARCHAR(128, charset="ascii", collation="ascii_bin"), primary_key=True, nullable=False),
    Column("value", Text),
    mysql_engine="InnoDB",
    mysql_charset="utf8mb4",
)
