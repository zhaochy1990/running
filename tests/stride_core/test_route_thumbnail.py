"""Tests for route thumbnail generation."""

import json
import math

from scripts.backfill_route_thumbnails import _backfill_one
from stride_core.models import ActivityDetail, TimeseriesPoint
from stride_core.db import compute_route_thumbnail


def _track_points(laps: int = 25, samples_per_lap: int = 48) -> list[dict[str, float]]:
    """Return a synthetic multi-lap GPS trace around a 400m-style track."""
    lat0 = 31.2
    lon0 = 121.4
    lat_per_meter = 1 / 111_000
    lon_per_meter = 1 / (111_000 * math.cos(math.radians(lat0)))

    points: list[dict[str, float]] = []
    for lap in range(laps):
        for i in range(samples_per_lap):
            angle = 2 * math.pi * (i / samples_per_lap)
            # Oval footprint with tiny deterministic wobble to mimic GPS/lane noise.
            x_m = 95 * math.cos(angle) + 1.5 * math.sin(lap * 0.7 + angle * 3)
            y_m = 55 * math.sin(angle) + 1.0 * math.cos(lap * 0.5 + angle * 2)
            points.append({"gps_lat": lat0 + y_m * lat_per_meter, "gps_lon": lon0 + x_m * lon_per_meter})
    return points


def _polyline_length(points: list[list[float]]) -> float:
    return sum(
        math.hypot(b[0] - a[0], b[1] - a[1])
        for a, b in zip(points, points[1:])
    )


def test_track_thumbnail_uses_loop_footprint_instead_of_lap_aliasing():
    thumb = compute_route_thumbnail(_track_points())
    assert thumb is not None

    points = json.loads(thumb)

    # Uniformly skipping a multi-lap track trace aliases into long chords across
    # the infield. The thumbnail should collapse repeated laps into one closed
    # footprint whose adjacent segments stay local.
    assert points[0] == points[-1]
    assert max(
        math.hypot(b[0] - a[0], b[1] - a[1])
        for a, b in zip(points, points[1:])
    ) <= 20
    assert _polyline_length(points) < 400


def test_open_route_thumbnail_keeps_open_start_and_finish():
    points = [
        {"gps_lat": 31.2 + i * 0.0001, "gps_lon": 121.4 + math.sin(i / 4) * 0.0002}
        for i in range(90)
    ]

    thumb = compute_route_thumbnail(points)
    assert thumb is not None

    polyline = json.loads(thumb)
    assert polyline[0] != polyline[-1]


def test_compact_switchback_route_does_not_become_closed_loop():
    lat0 = 31.2
    lon0 = 121.4
    lat_per_meter = 1 / 111_000
    lon_per_meter = 1 / (111_000 * math.cos(math.radians(lat0)))
    points = []
    for rep in range(12):
        for i in range(40):
            x_m = -140 + i * (280 / 39)
            y_m = rep * 4
            if rep % 2:
                x_m = -x_m
            points.append({"gps_lat": lat0 + y_m * lat_per_meter, "gps_lon": lon0 + x_m * lon_per_meter})

    thumb = compute_route_thumbnail(points)
    assert thumb is not None

    polyline = json.loads(thumb)
    assert polyline[0] != polyline[-1]


def test_backfill_force_regenerates_existing_thumbnail(db):
    detail = ActivityDetail(
        label_id="track1",
        name="Track Run",
        sport_type=103,
        sport_name="Track Run",
        date="2026-05-19T00:00:00+00:00",
        distance_m=10_000,
        duration_s=3_600,
        avg_pace_s_km=None,
        adjusted_pace=None,
        best_km_pace=None,
        max_pace=None,
        avg_hr=None,
        max_hr=None,
        avg_cadence=None,
        max_cadence=None,
        avg_power=None,
        max_power=None,
        avg_step_len_cm=None,
        ascent_m=None,
        descent_m=None,
        calories_kcal=None,
        aerobic_effect=None,
        anaerobic_effect=None,
        training_load=None,
        vo2max=None,
        performance=None,
        train_type=None,
        temperature=None,
        humidity=None,
        feels_like=None,
        wind_speed=None,
        timeseries=[
            TimeseriesPoint(
                timestamp=i,
                distance=None,
                heart_rate=None,
                speed=None,
                adjusted_pace=None,
                cadence=None,
                altitude=None,
                power=None,
                gps_lat=p["gps_lat"],
                gps_lon=p["gps_lon"],
            )
            for i, p in enumerate(_track_points())
        ],
    )
    db.upsert_activity(detail)
    db._conn.execute(
        "UPDATE activities SET route_thumb_json = ? WHERE label_id = ?",
        ("[[0,0],[100,100]]", "track1"),
    )
    db._conn.commit()

    touched, _, _ = _backfill_one(db._path)
    assert touched == 0
    row = db._conn.execute("SELECT route_thumb_json FROM activities WHERE label_id = 'track1'").fetchone()
    assert json.loads(row[0]) == [[0, 0], [100, 100]]

    touched, _, _ = _backfill_one(db._path, force=True)
    assert touched == 1
    row = db._conn.execute("SELECT route_thumb_json FROM activities WHERE label_id = 'track1'").fetchone()
    regenerated = json.loads(row[0])
    assert regenerated[0] == regenerated[-1]
