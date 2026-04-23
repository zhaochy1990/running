"""InBody body-composition scans — read trends + upsert writes from local CLI."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from stride_core.models import BodyCompositionScan

from ..deps import get_db

router = APIRouter()


# Phase checkpoints from TRAINING_PLAN.md for context on the /summary endpoint.
PHASE_CHECKPOINTS = [
    {"phase": "Phase 1", "date": "2026-06-21", "weight_kg": 70.5, "body_fat_pct": 21.0, "smm_kg_min": 31.0},
    {"phase": "Phase 2", "date": "2026-08-16", "weight_kg": 69.0, "body_fat_pct": 19.0, "smm_kg_min": 30.8},
    {"phase": "Phase 3", "date": "2026-10-25", "weight_kg": 68.0, "body_fat_pct": 17.5, "smm_kg_min": 30.5},
]


def _scan_row_to_dict(row) -> dict:
    return dict(row)


def _segments_by_name(rows) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for r in rows:
        d = dict(r)
        out[d["segment"]] = d
    return out


def _derive(scan: dict, segs: dict[str, dict]) -> dict:
    """Attach derived per-scan fields used by the frontend."""
    ll = segs.get("left_leg", {}).get("lean_mass_kg")
    rl = segs.get("right_leg", {}).get("lean_mass_kg")
    la = segs.get("left_arm", {}).get("lean_mass_kg")
    ra = segs.get("right_arm", {}).get("lean_mass_kg")
    trunk = segs.get("trunk", {}).get("lean_mass_kg")
    ll_fat = segs.get("left_leg", {}).get("fat_mass_kg")
    rl_fat = segs.get("right_leg", {}).get("fat_mass_kg")

    scan["leg_smm_delta"] = round(rl - ll, 2) if ll is not None and rl is not None else None
    scan["leg_fat_delta"] = round(rl_fat - ll_fat, 2) if ll_fat is not None and rl_fat is not None else None
    scan["arm_smm_delta"] = round(ra - la, 2) if la is not None and ra is not None else None

    upper = (la or 0) + (ra or 0) + (trunk or 0)
    lower = (ll or 0) + (rl or 0)
    scan["upper_lower_smm_ratio"] = round(upper / lower, 3) if lower else None

    # Flatten per-segment lean/fat for easy chart access
    for name in ("left_arm", "right_arm", "trunk", "left_leg", "right_leg"):
        s = segs.get(name, {})
        scan[f"{name}_smm_kg"] = s.get("lean_mass_kg")
        scan[f"{name}_fat_kg"] = s.get("fat_mass_kg")
        scan[f"{name}_lean_pct_std"] = s.get("lean_pct_of_standard")
        scan[f"{name}_fat_pct_std"] = s.get("fat_pct_of_standard")
    return scan


@router.get("/api/{user}/inbody")
def list_inbody(user: str, days: int | None = Query(None, ge=1, le=3650)):
    """List scans (newest-first) with derived per-scan fields + segments."""
    db = get_db(user)
    try:
        scans = [_scan_row_to_dict(r) for r in db.list_inbody_scans(days=days)]
        for s in scans:
            segs = _segments_by_name(db.get_inbody_segments(s["scan_date"]))
            _derive(s, segs)
            s["segments"] = list(segs.values())
        return {"scans": scans}
    finally:
        db.close()


@router.get("/api/{user}/inbody/summary")
def inbody_summary(user: str):
    """Latest scan + 30-day deltas + phase-checkpoint comparison."""
    db = get_db(user)
    try:
        latest = db.latest_inbody_scan()
        if not latest:
            return {"latest": None, "deltas": None, "checkpoints": PHASE_CHECKPOINTS}
        latest_d = _scan_row_to_dict(latest)
        segs = _segments_by_name(db.get_inbody_segments(latest_d["scan_date"]))
        _derive(latest_d, segs)
        latest_d["segments"] = list(segs.values())

        prior_rows = db._conn.execute(
            "SELECT * FROM inbody_scan WHERE scan_date < ? "
            "ORDER BY scan_date DESC LIMIT 1",
            (latest_d["scan_date"],),
        ).fetchall()
        prior = dict(prior_rows[0]) if prior_rows else None

        deltas = None
        if prior:
            deltas = {
                "prev_date": prior["scan_date"],
                "weight_kg": round(latest_d["weight_kg"] - prior["weight_kg"], 2),
                "body_fat_pct": round(latest_d["body_fat_pct"] - prior["body_fat_pct"], 2),
                "smm_kg": round(latest_d["smm_kg"] - prior["smm_kg"], 2),
                "fat_mass_kg": round(latest_d["fat_mass_kg"] - prior["fat_mass_kg"], 2),
                "visceral_fat_level": latest_d["visceral_fat_level"] - prior["visceral_fat_level"],
            }

        return {"latest": latest_d, "deltas": deltas, "checkpoints": PHASE_CHECKPOINTS}
    finally:
        db.close()


@router.get("/api/{user}/inbody/{scan_date}")
def get_inbody(user: str, scan_date: str):
    """Single scan with all 5 segments."""
    db = get_db(user)
    try:
        row = db.get_inbody_scan(scan_date)
        if not row:
            raise HTTPException(status_code=404, detail=f"No scan on {scan_date}")
        scan = _scan_row_to_dict(row)
        segs = _segments_by_name(db.get_inbody_segments(scan_date))
        _derive(scan, segs)
        scan["segments"] = list(segs.values())
        return scan
    finally:
        db.close()


@router.post("/api/{user}/inbody")
def upsert_inbody(user: str, payload: dict):
    """Upsert a scan + 5 segments. Body validated via `BodyCompositionScan.from_dict()`."""
    try:
        scan = BodyCompositionScan.from_dict(payload)
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=422, detail=str(e))

    db = get_db(user)
    try:
        db.upsert_inbody_scan(scan)
        row = db.get_inbody_scan(scan.scan_date)
        stored = _scan_row_to_dict(row)
        segs = _segments_by_name(db.get_inbody_segments(scan.scan_date))
        _derive(stored, segs)
        stored["segments"] = list(segs.values())
        return stored
    finally:
        db.close()
