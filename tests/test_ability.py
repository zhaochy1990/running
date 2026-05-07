"""Tests for stride_core.ability — custom running ability score module.

Covers acceptance criteria A1.1–A1.7 from
.omc/plans/custom-running-ability-score.md §2, plus boundary cases.
"""

from __future__ import annotations

import copy
import json
import pathlib

import pytest

from stride_core import ability
from stride_core.ability import (
    acsm_running_vo2,
    compute_ability_snapshot,
    compute_l1_quality,
    compute_l2_freshness,
    compute_l3_aerobic,
    compute_l3_endurance,
    compute_l3_economy,
    compute_l3_lt,
    compute_l3_recovery,
    compute_l3_vo2max,
    compute_l4_composite,
    compute_contribution,
    daniels_pct_vo2max,
    daniels_vdot,
    daniels_vo2_required,
    estimate_marathon_time_s,
    marathon_target_from_profile,
    marathon_target_label,
    uth_sorensen_vo2max,
    vdot_to_marathon_s,
)
from stride_core.db import Database


FIXTURE_PATH = pathlib.Path(__file__).parent / "fixtures" / "ability_sample.json"


# ---------------------------------------------------------------------------
# Fixture plumbing.
# ---------------------------------------------------------------------------

def _load_fixture() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def _seed_activities(db: Database, activities: list[dict]) -> None:
    conn = db._conn
    for a in activities:
        conn.execute(
            """INSERT OR REPLACE INTO activities
               (label_id, name, sport_type, sport_name, date, distance_m, duration_s,
                avg_pace_s_km, avg_hr, max_hr, avg_cadence, train_type)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                a["label_id"], a.get("name"), a["sport_type"], "Run",
                a["date"], a["distance_m"], a["duration_s"], a["avg_pace_s_km"],
                a.get("avg_hr"), a.get("max_hr"), a.get("avg_cadence"),
                a.get("train_type"),
            ),
        )
        for i, lap in enumerate(a.get("laps", []), start=1):
            conn.execute(
                """INSERT OR REPLACE INTO laps
                   (label_id, lap_index, lap_type, distance_m, duration_s, avg_pace,
                    avg_hr, max_hr, avg_cadence, exercise_type)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (
                    a["label_id"], i, lap.get("lap_type", "autoKm"),
                    lap["distance_m"], lap["duration_s"], lap.get("avg_pace"),
                    lap.get("avg_hr"), lap.get("max_hr"), lap.get("avg_cadence"),
                    lap.get("exercise_type"),
                ),
            )
        for p in a.get("timeseries", []):
            conn.execute(
                """INSERT INTO timeseries
                   (label_id, timestamp, heart_rate, speed, cadence)
                   VALUES (?,?,?,?,?)""",
                (
                    a["label_id"], p.get("timestamp"),
                    p.get("heart_rate"), p.get("speed"), p.get("cadence"),
                ),
            )
    conn.commit()


def _seed_daily_health(db: Database, rows: list[dict]) -> None:
    conn = db._conn
    for h in rows:
        conn.execute(
            """INSERT OR REPLACE INTO daily_health
               (date, ati, cti, rhr, distance_m, duration_s, training_load_ratio,
                training_load_state, fatigue)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (
                h["date"], h.get("ati"), h.get("cti"), h.get("rhr"),
                h.get("distance_m"), h.get("duration_s"),
                h.get("training_load_ratio"), h.get("training_load_state"),
                h.get("fatigue"),
            ),
        )
    conn.commit()


def _seed_dashboard(db: Database, d: dict) -> None:
    conn = db._conn
    conn.execute(
        """INSERT OR REPLACE INTO dashboard
           (id, running_level, aerobic_score, lactate_threshold_score,
            anaerobic_endurance_score, anaerobic_capacity_score,
            rhr, threshold_hr, threshold_pace_s_km, recovery_pct,
            avg_sleep_hrv, hrv_normal_low, hrv_normal_high,
            weekly_distance_m, weekly_duration_s)
           VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            d.get("running_level"), d.get("aerobic_score"),
            d.get("lactate_threshold_score"), d.get("anaerobic_endurance_score"),
            d.get("anaerobic_capacity_score"), d.get("rhr"),
            d.get("threshold_hr"), d.get("threshold_pace_s_km"),
            d.get("recovery_pct"), d.get("avg_sleep_hrv"),
            d.get("hrv_normal_low"), d.get("hrv_normal_high"),
            d.get("weekly_distance_m"), d.get("weekly_duration_s"),
        ),
    )
    conn.commit()


def _seed_from_fixture(db: Database, fx: dict) -> None:
    _seed_activities(db, fx["activities"])
    _seed_daily_health(db, fx["daily_health"])
    _seed_dashboard(db, fx["dashboard"])


@pytest.fixture
def fx() -> dict:
    """Fresh deep-copy of the fixture for each test."""
    return copy.deepcopy(_load_fixture())


@pytest.fixture
def ability_db(tmp_path, fx):
    """Seeded DB built from the sample fixture."""
    db = Database(db_path=tmp_path / "ability.db")
    _seed_from_fixture(db, fx)
    yield db
    db.close()


# ---------------------------------------------------------------------------
# Daniels / VO2max primitives (unit-level coverage).
# ---------------------------------------------------------------------------

class TestDanielsPrimitives:
    def test_vo2_required_zero_for_degenerate(self):
        assert daniels_vo2_required(0, 0) == 0.0
        assert daniels_vo2_required(-1, 100) == 0.0

    def test_pct_vo2max_bounded(self):
        # Marathon duration ~ 2:50 = 10200s → %VO2max should be ~0.84
        p = daniels_pct_vo2max(10200)
        assert 0.82 < p < 0.90

    def test_pct_vo2max_short_effort_above_one(self):
        # Very short efforts exceed 100% VO2max briefly (Daniels formula).
        p = daniels_pct_vo2max(5 * 60)
        assert p > 1.0

    def test_pct_vo2max_monotonic_decrease(self):
        # Longer effort → lower sustainable %VO2max.
        p_10min = daniels_pct_vo2max(10 * 60)
        p_60min = daniels_pct_vo2max(60 * 60)
        p_marathon = daniels_pct_vo2max(180 * 60)
        assert p_10min > p_60min > p_marathon

    def test_pct_vo2max_handles_zero(self):
        assert daniels_pct_vo2max(0) == 1.0

    def test_vdot_5k_1930_calibration(self):
        # Spec correction: 5K 19:30 → VDOT ≈ 51 (NOT 58 as originally written).
        v = daniels_vdot(5000, 19 * 60 + 30)
        assert 50.0 <= v <= 52.5

    def test_vdot_5k_1755_calibration(self):
        # 5K 17:55 → VDOT ≈ 57 (canonical Daniels value).
        v = daniels_vdot(5000, 17 * 60 + 55)
        assert 56.0 <= v <= 58.5

    def test_vdot_degenerate(self):
        assert daniels_vdot(0, 0) == 0.0
        assert daniels_vdot(5000, 0) == 0.0

    def test_acsm_running_vo2(self):
        # 5:00/km = 200 m/min → 0.2 * 200 + 3.5 = 43.5
        assert acsm_running_vo2(300) == pytest.approx(43.5, abs=0.2)

    def test_acsm_running_vo2_degenerate(self):
        assert acsm_running_vo2(0) == 0.0

    def test_uth_sorensen(self):
        # HRmax 185, RHR 48 → VO2max ≈ 15.3 * 185 / 48 ≈ 58.97
        assert uth_sorensen_vo2max(185, 48) == pytest.approx(58.97, abs=0.1)

    def test_uth_sorensen_degenerate(self):
        assert uth_sorensen_vo2max(0, 48) == 0.0
        assert uth_sorensen_vo2max(185, 0) == 0.0
        assert uth_sorensen_vo2max(None, 48) == 0.0
        assert uth_sorensen_vo2max(185, None) == 0.0

    def test_vdot_to_marathon_interpolation(self):
        # Canonical values.
        assert vdot_to_marathon_s(50) == ability.DANIELS_VDOT_TO_MARATHON_S[50]
        assert vdot_to_marathon_s(65) == ability.DANIELS_VDOT_TO_MARATHON_S[65]
        # Midpoint between 55 and 60 should sit in-between.
        mid = vdot_to_marathon_s(57.5)
        lo = ability.DANIELS_VDOT_TO_MARATHON_S[55]
        hi = ability.DANIELS_VDOT_TO_MARATHON_S[60]
        assert hi < mid < lo

    def test_vdot_to_marathon_out_of_range(self):
        assert vdot_to_marathon_s(29) is None
        assert vdot_to_marathon_s(86) is None
        assert vdot_to_marathon_s(None) is None
        assert vdot_to_marathon_s(-1) is None

    def test_daniels_table_matches_formula(self):
        """Lock in table-vs-formula consistency.

        For every VDOT in DANIELS_VDOT_TO_MARATHON_S, solve
            pct(T) * VDOT == vo2_required(42195, T)
        via bisection, and assert |table[VDOT] − T_solution| < 60s.
        Catches future drift of either the table or the underlying
        Daniels formulas — see spike/verify_daniels_table.py for the
        derivation script.
        """
        MARATHON_M = 42195.0

        def residual(vdot: float, t_s: float) -> float:
            return daniels_pct_vo2max(t_s) * vdot - daniels_vo2_required(MARATHON_M, t_s)

        def solve(vdot: float) -> float:
            lo, hi = 60 * 60.0, 600 * 60.0
            f_lo = residual(vdot, lo)
            f_hi = residual(vdot, hi)
            assert f_lo * f_hi < 0, f"VDOT {vdot}: bracket failure"
            for _ in range(200):
                mid = 0.5 * (lo + hi)
                f_mid = residual(vdot, mid)
                if abs(f_mid) < 1e-9 or (hi - lo) < 1e-3:
                    return mid
                if f_lo * f_mid < 0:
                    hi, f_hi = mid, f_mid
                else:
                    lo, f_lo = mid, f_mid
            return 0.5 * (lo + hi)

        for vdot, table_t in ability.DANIELS_VDOT_TO_MARATHON_S.items():
            solution = solve(float(vdot))
            assert abs(table_t - solution) < 60, (
                f"VDOT {vdot}: table={table_t}s vs formula={solution:.1f}s "
                f"(delta={table_t - solution:+.1f}s, must be <60s)"
            )


# ---------------------------------------------------------------------------
# L1 / L2 / L3 unit coverage on dict-shaped activities.
# ---------------------------------------------------------------------------

class TestL1Quality:
    def test_none_activity(self):
        out = compute_l1_quality(None)
        assert out["total"] == 0.0
        assert out["breakdown"]
        assert out["evidence"] == []

    def test_basic_activity(self):
        act = {
            "label_id": "T1",
            "train_type": "Aerobic Endurance",
            "avg_hr": 145,
            "avg_pace_s_km": 320,
            "max_hr": 160,
            "avg_cadence": 180,
            "laps": [
                {"lap_index": i + 1, "avg_pace": 320, "avg_hr": 145,
                 "avg_cadence": 180, "duration_s": 320, "distance_m": 1.0}
                for i in range(5)
            ],
            "zones": [],
            "timeseries": [
                {"heart_rate": 145, "speed": 3.1} for _ in range(60)
            ],
        }
        out = compute_l1_quality(act)
        assert 0.0 <= out["total"] <= 100.0
        assert set(out["breakdown"]).issuperset({
            "pace_adherence", "hr_zone_adherence", "pace_stability",
            "hr_decoupling", "cadence_stability",
        })

    def test_plan_target_used(self):
        act = {
            "label_id": "T2",
            "train_type": "Threshold",
            "avg_hr": 165,
            "avg_pace_s_km": 255,
            "laps": [
                {"avg_pace": 255, "avg_hr": 165, "avg_cadence": 185,
                 "duration_s": 255, "distance_m": 1.0}
                for _ in range(5)
            ],
            "zones": [],
            "timeseries": [],
        }
        out = compute_l1_quality(act, plan_target={"pace_s_km": 255, "hr_lo": 160, "hr_hi": 172})
        # Perfect adherence on pace → adherence 100.
        assert out["breakdown"]["pace_adherence"] == pytest.approx(100.0, abs=0.5)

    def test_hr_decoupling_negative_raw_scores_high(self):
        """Regression guard: negative drift (efficiency improvement) must not be penalised.

        Build a 2-lap activity where the second half runs at the same pace with a
        LOWER heart rate — that's a physiologically GOOD sign (efficiency gain),
        and the new formula should score it ~100, not ~38 like the old `abs(...)`
        version did.
        """
        act = {
            "label_id": "T_NEG_DRIFT",
            "train_type": "Aerobic Endurance",
            "avg_hr": 150,
            "avg_pace_s_km": 320,
            "laps": [
                # First half: HR 160, pace 320s/km
                {"avg_pace": 320, "avg_hr": 160, "avg_cadence": 180,
                 "duration_s": 320, "distance_m": 1.0, "exercise_type": 2},
                {"avg_pace": 320, "avg_hr": 160, "avg_cadence": 180,
                 "duration_s": 320, "distance_m": 1.0, "exercise_type": 2},
                # Second half: HR drops to 140 at same pace → raw drift very negative
                {"avg_pace": 320, "avg_hr": 140, "avg_cadence": 180,
                 "duration_s": 320, "distance_m": 1.0, "exercise_type": 2},
                {"avg_pace": 320, "avg_hr": 140, "avg_cadence": 180,
                 "duration_s": 320, "distance_m": 1.0, "exercise_type": 2},
            ],
            "zones": [],
            "timeseries": [],
        }
        out = compute_l1_quality(act)
        assert out["breakdown"]["hr_decoupling_raw"] < 0, \
            "fixture must produce negative raw drift"
        assert out["breakdown"]["hr_decoupling"] >= 95.0, \
            f"negative drift should score ~100, got {out['breakdown']['hr_decoupling']}"

    def test_hr_decoupling_positive_raw_scores_low(self):
        """Regression guard: positive drift (cardiac drift) is still penalised.

        Mirror of the negative case but with HR rising in the second half. The
        new formula must keep the historical penalty for true drift; this test
        locks down the +0.124 → ~38 calibration.
        """
        # Construct timeseries with mean_hr/mean_speed ratio that yields raw≈+0.124.
        # First half: hr=150, speed=3.0 → ratio 50.
        # Second half: hr=160, speed=2.84 → ratio ~56.34. Drift = 6.34/50 = 0.1268
        first = [{"heart_rate": 150, "speed": 3.0} for _ in range(40)]
        second = [{"heart_rate": 160, "speed": 2.84} for _ in range(40)]
        act = {
            "label_id": "T_POS_DRIFT",
            "train_type": "Aerobic Endurance",
            "avg_hr": 155,
            "avg_pace_s_km": 340,
            "laps": [],
            "zones": [],
            "timeseries": first + second,
        }
        out = compute_l1_quality(act)
        raw = out["breakdown"]["hr_decoupling_raw"]
        score = out["breakdown"]["hr_decoupling"]
        assert raw > 0.10, f"fixture must produce positive raw drift, got {raw}"
        # Score = 100 - raw * 500. raw≈0.1268 → score≈36.6. Allow ±5 for fixture jitter.
        assert 30.0 <= score <= 45.0, \
            f"positive drift ~+0.124 should score ~38, got {score}"

    def test_pace_stability_filters_rest_laps_for_intervals(self):
        """Rest laps must not inflate the pace-CV on interval workouts.

        Build a 7-lap activity (warmup + 4 work laps @ 250s/km + 2 rest laps
        @ 350s/km + cooldown). Mixing rest laps would explode the CV and tank
        pace_stability; with the fix, CV is computed on the 4 work laps (all
        identical) so stability should be near 100.
        """
        act = {
            "label_id": "T_INTERVAL_STAB",
            "train_type": "Interval",
            "avg_hr": 168,
            "avg_pace_s_km": 290,
            "laps": [
                # warmup
                {"avg_pace": 360, "avg_hr": 130, "avg_cadence": 175,
                 "duration_s": 360, "distance_m": 1.0, "exercise_type": 1},
                # work × 4 @ 250s/km, near-identical → CV ≈ 0
                {"avg_pace": 250, "avg_hr": 175, "avg_cadence": 188,
                 "duration_s": 250, "distance_m": 1.0, "exercise_type": 2},
                {"avg_pace": 252, "avg_hr": 175, "avg_cadence": 188,
                 "duration_s": 252, "distance_m": 1.0, "exercise_type": 2},
                {"avg_pace": 248, "avg_hr": 176, "avg_cadence": 188,
                 "duration_s": 248, "distance_m": 1.0, "exercise_type": 2},
                {"avg_pace": 250, "avg_hr": 176, "avg_cadence": 188,
                 "duration_s": 250, "distance_m": 1.0, "exercise_type": 2},
                # rest × 2 @ 350s/km recovery
                {"avg_pace": 350, "avg_hr": 140, "avg_cadence": 170,
                 "duration_s": 350, "distance_m": 1.0, "exercise_type": 4},
                {"avg_pace": 350, "avg_hr": 140, "avg_cadence": 170,
                 "duration_s": 350, "distance_m": 1.0, "exercise_type": 4},
                # cooldown
                {"avg_pace": 380, "avg_hr": 130, "avg_cadence": 172,
                 "duration_s": 380, "distance_m": 1.0, "exercise_type": 3},
            ],
            "zones": [],
            "timeseries": [],
        }
        out = compute_l1_quality(act)
        # Old formula (CV across work + rest) → pace_stability ~25-40.
        # New formula (work laps only, CV ≈ 0.006) → pace_stability ≥ 95.
        assert out["breakdown"]["pace_stability"] >= 90.0, \
            f"work-lap CV is tiny; expected ≥90, got {out['breakdown']['pace_stability']}"

    def test_pace_adherence_uses_work_lap_median_for_intervals(self):
        """For interval train_type, adherence should use work-lap median, not avg_pace.

        Activity-level avg_pace=299s/km is contaminated by rest jogs, but the
        actual training stimulus (work laps median ≈ 247s/km) is right on the
        HR-derived target. Old formula → ~50 adherence; new formula → ≥85.
        """
        # avg_hr 168, hr_max 185 → frac=0.908 → target ≈ 226s/km (HR is high zone)
        # Use plan_target to pin target at 247s/km so the assertion is deterministic
        # against the work-lap median (≈247s/km).
        work_paces = [245, 247, 248, 249]
        rest_paces = [350, 350, 350]
        laps = (
            [{"avg_pace": 360, "avg_hr": 130, "avg_cadence": 175,
              "duration_s": 360, "distance_m": 1.0, "exercise_type": 1}]  # warmup
            + [
                {"avg_pace": p, "avg_hr": 175, "avg_cadence": 188,
                 "duration_s": p, "distance_m": 1.0, "exercise_type": 2}
                for p in work_paces
            ]
            + [
                {"avg_pace": p, "avg_hr": 140, "avg_cadence": 170,
                 "duration_s": p, "distance_m": 1.0, "exercise_type": 4}
                for p in rest_paces
            ]
            + [{"avg_pace": 380, "avg_hr": 130, "avg_cadence": 172,
                "duration_s": 380, "distance_m": 1.0, "exercise_type": 3}]  # cooldown
        )
        act = {
            "label_id": "T_INTERVAL_ADHER",
            "train_type": "Interval",
            "avg_hr": 168,
            # contaminated activity avg — far slower than the work effort
            "avg_pace_s_km": 299,
            "laps": laps,
            "zones": [],
            "timeseries": [],
        }
        # Pin the target so the test is robust to HR→pace heuristic changes.
        out = compute_l1_quality(
            act, plan_target={"pace_s_km": 247, "hr_lo": 165, "hr_hi": 180}
        )
        # Sanity: contaminated path (using 299 vs 247) → err_frac=0.21 → score ~37.
        # Fixed path (work-lap median ≈ 247.5 vs 247) → err_frac<0.01 → score ~99.
        assert out["breakdown"]["pace_adherence"] >= 85.0, \
            f"work-lap median should drive adherence high, got {out['breakdown']['pace_adherence']}"

    def test_pace_stability_dedupes_autokm_and_type2(self):
        """COROS stores both autoKm + type2 rows for the same lap_index;
        pace_stability must keep only the type2 (plan-step summary) row.

        Build 4 work reps where each rep has TWO entries — an autoKm slice with
        a slightly different pace and a type2 summary with the canonical pace.
        If both are counted, CV is inflated by the duplicate noise; with the
        fix, only the 4 type2 paces (all identical) are used → high stability.
        """
        # 4 reps, two rows each. type2 paces tightly clustered (250s/km), but
        # the matching autoKm slice paces are wider (240/260/240/260) — if both
        # were counted, the CV would jump. Both rows of a rep share lap_index.
        type2_paces = [250, 250, 250, 250]
        autokm_paces = [240, 260, 240, 260]
        laps = []
        for i, (t2, ak) in enumerate(zip(type2_paces, autokm_paces), start=1):
            laps.append({
                "lap_index": i, "lap_type": "autoKm",
                "avg_pace": ak, "avg_hr": 175, "avg_cadence": 188,
                "duration_s": ak, "distance_m": 1.0, "exercise_type": 2,
            })
            laps.append({
                "lap_index": i, "lap_type": "type2",
                "avg_pace": t2, "avg_hr": 175, "avg_cadence": 188,
                "duration_s": 3 * t2, "distance_m": 3.0, "exercise_type": 2,
            })
        act = {
            "label_id": "T_DEDUPE",
            "train_type": "Interval",
            "avg_hr": 175,
            "avg_pace_s_km": 250,
            "laps": laps,
            "zones": [],
            "timeseries": [],
        }
        out = compute_l1_quality(act)
        # type2-only (CV=0) → pace_stability=100. If both were counted, CV
        # explodes (~0.04) and stability falls below 95.
        assert out["breakdown"]["pace_stability"] >= 95.0, \
            f"dedupe failed; got {out['breakdown']['pace_stability']}"

    def test_pace_stability_drops_outlier_fragments(self):
        """A short fragment lap (< 0.3km / < 60s) must be excluded from CV.

        3 normal work laps at consistent pace plus 1 fragment with a wildly
        different pace; without the filter, CV is contaminated and stability
        drops sharply. With the filter, the fragment is dropped and stability
        stays high.
        """
        laps = [
            {"lap_index": 1, "lap_type": "type2", "avg_pace": 250,
             "avg_hr": 175, "avg_cadence": 188,
             "duration_s": 250, "distance_m": 1.0, "exercise_type": 2},
            {"lap_index": 2, "lap_type": "type2", "avg_pace": 250,
             "avg_hr": 175, "avg_cadence": 188,
             "duration_s": 250, "distance_m": 1.0, "exercise_type": 2},
            {"lap_index": 3, "lap_type": "type2", "avg_pace": 250,
             "avg_hr": 175, "avg_cadence": 188,
             "duration_s": 250, "distance_m": 1.0, "exercise_type": 2},
            # outlier fragment — exercise_type=0 so neither rest filter catches it
            {"lap_index": 4, "lap_type": "type2", "avg_pace": 494,
             "avg_hr": 175, "avg_cadence": 188,
             "duration_s": 27.66, "distance_m": 0.06, "exercise_type": 0},
        ]
        act = {
            "label_id": "T_FRAGMENT",
            "train_type": "Interval",
            "avg_hr": 175,
            "avg_pace_s_km": 250,
            "laps": laps,
            "zones": [],
            "timeseries": [],
        }
        out = compute_l1_quality(act)
        # Without fragment: 3 paces at 250 → CV=0 → stability=100.
        # With fragment: paces [250,250,250,494] → CV~0.27 → stability~46.
        assert out["breakdown"]["pace_stability"] >= 95.0, \
            f"fragment not filtered; got {out['breakdown']['pace_stability']}"

    def test_pace_stability_real_interval_pattern(self):
        """Replicate the zhaochaoyi 5/06 4×3K interval pattern.

        Mix of autoKm 1km slices and type2 plan-step summaries (3km work reps),
        all with ex_type=2, plus one fragment outlier. Verify pace_stability
        ≥ 75 once dedupe + outlier filter are applied. Pre-fix this scored
        ~41; post-fix it should be high since the type2 work-rep paces are
        consistent.
        """
        # 4 work reps of 3km each at ~245-250s/km (type2 summaries).
        # Each rep also has 3 autoKm 1km slices with wider pace variation
        # (rep splits drift faster→slower across the 3km).
        type2_rep_paces = [245, 248, 250, 247]
        laps = []
        idx = 1
        for rep_i, t2 in enumerate(type2_rep_paces):
            # 3 autoKm 1km slices per rep, paces vary
            for slice_i in range(3):
                slice_pace = t2 - 6 + slice_i * 6  # e.g. 239, 245, 251
                laps.append({
                    "lap_index": idx, "lap_type": "autoKm",
                    "avg_pace": slice_pace, "avg_hr": 175, "avg_cadence": 188,
                    "duration_s": slice_pace, "distance_m": 1.0,
                    "exercise_type": 2,
                })
                idx += 1
            # type2 plan-step summary covering 3km — give it the same lap_index
            # as one of the autoKm slices to trigger dedupe (use the middle slice)
            mid_idx = idx - 2
            laps.append({
                "lap_index": mid_idx, "lap_type": "type2",
                "avg_pace": t2, "avg_hr": 175, "avg_cadence": 188,
                "duration_s": 3 * t2, "distance_m": 3.0, "exercise_type": 2,
            })
        # Add a fragment outlier (matches the actual 5/06 artifact)
        laps.append({
            "lap_index": idx, "lap_type": "type2",
            "avg_pace": 494, "avg_hr": 170, "avg_cadence": 180,
            "duration_s": 27.66, "distance_m": 0.06, "exercise_type": 0,
        })
        act = {
            "label_id": "T_REAL_INTERVAL",
            "train_type": "Interval",
            "avg_hr": 175,
            "avg_pace_s_km": 280,
            "laps": laps,
            "zones": [],
            "timeseries": [],
        }
        out = compute_l1_quality(act)
        # After dedupe + outlier filter, only the 4 type2 paces (245,248,250,247)
        # remain. CV ≈ 0.008 → stability ≈ 98. Pre-fix, all 13 entries would be
        # in play including the 494 outlier → stability ≈ 41.
        assert out["breakdown"]["pace_stability"] >= 75.0, \
            f"real-interval pattern still noisy; got {out['breakdown']['pace_stability']}"

    def test_easy_run_no_train_type_pace_adherence_unchanged(self):
        """Regression guard: easy/long runs (train_type None or 'Base') must
        keep using avg_pace — the work-lap-median branch is gated on the
        Interval/VO2 Max/Threshold train_types only.
        """
        # Construct an easy run where avg_pace and lap median DIFFER. If the new
        # branch were to activate erroneously, the score would change.
        act_avg = {
            "label_id": "T_EASY",
            "train_type": "Aerobic Endurance",  # not in the interval set
            "avg_hr": 145,
            "avg_pace_s_km": 320,
            "laps": [
                {"avg_pace": 250, "avg_hr": 145, "avg_cadence": 180,
                 "duration_s": 250, "distance_m": 1.0, "exercise_type": 2}
                for _ in range(5)
            ],
            "zones": [],
            "timeseries": [],
        }
        out = compute_l1_quality(
            act_avg, plan_target={"pace_s_km": 320, "hr_lo": 138, "hr_hi": 152}
        )
        # avg_pace == target → ~100; if branch wrongly used lap median (250) it
        # would drop to ~34.
        assert out["breakdown"]["pace_adherence"] >= 95.0, \
            f"easy-run path must use avg_pace; got {out['breakdown']['pace_adherence']}"

    def test_pace_adherence_clamps_extreme_hr_target(self):
        """Regression guard: HR-based target pace heuristic must not extrapolate
        past its calibrated band. At avg_hr/hr_max = 1.05 the linear formula
        produced a 2:26/km target — fast enough that even a sprint-tempo gets
        an artificially low adherence score. The clamp keeps target in
        [3:20/km, 9:00/km] which preserves the score for realistic efforts.
        """
        # avg_hr 195, hr_max 185 → frac=1.05 → unclamped target 146s/km.
        # Without clamp: a 4:00/km (240s) work pace would score
        #   100 - |240-146|/146 * 300 = 100 - 193 = 0.
        # With clamp at 200s: 100 - |240-200|/200 * 300 = 40.
        act = {
            "label_id": "T_HR_CLAMP",
            "train_type": "Sprint",
            "avg_hr": 195,
            "avg_pace_s_km": 240,
            "max_hr": 200,
            "laps": [],
            "zones": [],
            "timeseries": [],
        }
        out = compute_l1_quality(act)  # no plan_target → HR heuristic
        # Without clamp: ~0; with clamp at 200s/km lower bound: ~40 (still
        # low because frac=1.05 implies extreme effort, but bounded).
        assert out["breakdown"]["pace_adherence"] >= 30.0, \
            f"clamped target should keep adherence sane; got {out['breakdown']['pace_adherence']}"


class TestL2Freshness:
    def test_none_health(self):
        out = compute_l2_freshness(None)
        assert out["total"] == 50.0

    def test_tsb_race_ready(self):
        out = compute_l2_freshness(
            {"ati": 50, "cti": 55, "rhr": 48, "fatigue": 30},
            dashboard={"avg_sleep_hrv": 65, "hrv_normal_low": 50, "hrv_normal_high": 75},
            baseline_rhr=48,
        )
        # cti-ati = 5 → TSB in [-10,10] → score 100; fatigue 30 → 70
        assert out["breakdown"]["tsb_score"] == 100.0
        assert out["breakdown"]["rhr_score"] == 100.0
        # All sub-scores high → total high.
        assert out["total"] > 80.0

    def test_tsb_overload_penalty(self):
        out = compute_l2_freshness(
            {"ati": 90, "cti": 50, "rhr": 55, "fatigue": 70},
            dashboard={"avg_sleep_hrv": 20, "hrv_normal_low": 50, "hrv_normal_high": 75},
            baseline_rhr=48,
        )
        # TSB = -40 → should dip score significantly.
        assert out["breakdown"]["tsb_score"] < 50.0
        assert out["breakdown"]["rhr_score"] < 100.0

    def test_hrv_unknown(self):
        out = compute_l2_freshness(
            {"ati": 55, "cti": 55, "rhr": 48, "fatigue": 30},
            dashboard=None,
            baseline_rhr=48,
        )
        assert out["breakdown"]["hrv_score"] == 50.0


class TestL3:
    def test_aerobic_no_evidence(self):
        score, ev, det = compute_l3_aerobic([])
        assert score == 0.0 and ev == []

    def test_aerobic_with_evidence(self):
        # Best-performance semantics: evidence holds only the fastest qualifying run;
        # n_runs counts all qualifying runs for context.
        activities = [
            {"label_id": "A1", "sport_type": 100, "avg_hr": 145,
             "avg_pace_s_km": 310, "distance_m": 10000, "laps": [],
             "timeseries": []},
            {"label_id": "A2", "sport_type": 100, "avg_hr": 146,
             "avg_pace_s_km": 312, "distance_m": 8000, "laps": [],
             "timeseries": []},
        ]
        score, ev, det = compute_l3_aerobic(activities)
        assert score > 60.0
        assert ev == ["A1"]  # A1 is faster (310 < 312) → best
        assert det["n_runs"] == 2
        assert det["best_pace_s_km"] == 310.0

    def test_aerobic_filters_by_hr(self):
        # HR far from 145 → excluded
        activities = [
            {"label_id": "A1", "sport_type": 100, "avg_hr": 170,
             "avg_pace_s_km": 280, "distance_m": 10000, "laps": [],
             "timeseries": []},
        ]
        score, ev, _ = compute_l3_aerobic(activities)
        assert score == 0.0 and ev == []

    def test_lt_requires_laps(self):
        # No laps → no LT.
        activities = [
            {"label_id": "A1", "sport_type": 100, "avg_pace_s_km": 255,
             "distance_m": 10000, "duration_s": 2550, "laps": [],
             "timeseries": []},
        ]
        score, ev, _ = compute_l3_lt(activities)
        assert score == 0.0 and ev == []

    def test_lt_detects_sustained(self):
        # 30 laps of 1km each @ 4:10/km (250s) → 30*250 = 7500s > 20min.
        activities = [
            {"label_id": "A1", "sport_type": 100, "avg_pace_s_km": 250,
             "distance_m": 30000, "duration_s": 7500,
             "laps": [
                 {"distance_m": 1.0, "duration_s": 250, "avg_pace": 250,
                  "avg_hr": 168, "avg_cadence": 184}
                 for _ in range(30)
             ],
             "timeseries": []},
        ]
        score, ev, det = compute_l3_lt(activities)
        assert score > 60.0
        assert "A1" in ev
        assert det["best_pace_s_km"] is not None

    def test_endurance_no_long_run(self):
        score, ev, _ = compute_l3_endurance([
            {"label_id": "A1", "sport_type": 100, "distance_m": 15000,
             "laps": [], "timeseries": []}
        ])
        assert score == 0.0 and ev == []

    def test_endurance_with_long_run(self):
        activities = [
            {"label_id": "LR", "sport_type": 100, "distance_m": 30000,
             "laps": [], "timeseries": []}
        ]
        score, ev, det = compute_l3_endurance(activities)
        assert score > 0 and "LR" in ev
        assert det["longest_km"] == 30.0

    def test_economy_no_target_pace_laps(self):
        # Laps far outside [280, 300] → no cadence sample.
        activities = [
            {"label_id": "A1", "sport_type": 100,
             "laps": [
                 {"avg_pace": 320, "avg_cadence": 178, "distance_m": 1.0,
                  "duration_s": 320}
                 for _ in range(5)
             ]}
        ]
        score, ev, _ = compute_l3_economy(activities)
        assert score == 0.0 and ev == []

    def test_economy_with_target_pace_laps(self):
        activities = [
            {"label_id": "A1", "sport_type": 100,
             "laps": [
                 {"avg_pace": 290, "avg_cadence": 184, "distance_m": 1.0,
                  "duration_s": 290}
                 for _ in range(5)
             ]}
        ]
        score, ev, det = compute_l3_economy(activities)
        assert score > 80
        assert "A1" in ev
        assert det["median_cadence"] == 184.0

    def test_recovery_empty(self):
        score, ev, det = compute_l3_recovery([])
        assert score == 50.0 and det["n_days"] == 0

    def test_recovery_average(self):
        score, ev, det = compute_l3_recovery([80, 85, 90])
        assert score == pytest.approx(85.0, abs=0.01)


class TestL4:
    def test_composite_empty(self):
        assert compute_l4_composite({}) == 0.0

    def test_composite_weighted(self):
        l3 = dict(aerobic=80, lt=70, vo2max=60, endurance=75,
                  economy=85, recovery=90)
        total = (
            80 * 0.20 + 70 * 0.25 + 60 * 0.20 + 75 * 0.20
            + 85 * 0.10 + 90 * 0.05
        )
        assert compute_l4_composite(l3) == pytest.approx(total, abs=0.01)

    def test_estimate_marathon_from_vdot(self):
        l3 = {"vo2max_used_vdot": 55, "endurance": 80}  # endurance→factor mid
        t = estimate_marathon_time_s(l3)
        # Should be close to the vdot=55 canonical value, minus endurance correction.
        base = ability.DANIELS_VDOT_TO_MARATHON_S[55]
        # endurance=80, factor = 1.02 - (80-70)/15 * 0.04 = 1.02 - 0.0267 = 0.993
        expected = base * (1.02 - (80 - 70) / 15 * 0.04)
        assert t == pytest.approx(int(round(expected)), abs=5)

    def test_estimate_marathon_none_when_no_vdot(self):
        assert estimate_marathon_time_s({}) is None
        assert estimate_marathon_time_s({"vo2max_used_vdot": 0}) is None

    def test_estimate_marathon_score_fallback(self):
        # When only score (no vdot) is present, inverse-anchor maps score→vdot.
        # Anchor: score 60 ↔ vdot 62 (see VO2MAX_REFERENCE_VDOT / SCORE_AT_REF).
        t_with_vdot = estimate_marathon_time_s({"vo2max_used_vdot": 62, "endurance": 80})
        t_with_score = estimate_marathon_time_s({"vo2max": 60, "endurance": 80})
        assert t_with_vdot == t_with_score


class TestContribution:
    def test_basic(self):
        delta = compute_contribution(
            {"label_id": "A1"},
            prior_l3={"aerobic": 70, "lt": 65, "vo2max": 60,
                      "endurance": 55, "economy": 75, "recovery": 80},
            posterior_l3={"aerobic": 70.5, "lt": 65, "vo2max": 62,
                          "endurance": 55, "economy": 75, "recovery": 80},
        )
        assert delta["aerobic"] == pytest.approx(0.5, abs=0.01)
        assert delta["vo2max"] == pytest.approx(2.0, abs=0.01)
        assert delta["endurance"] == pytest.approx(0.0, abs=0.01)

    def test_missing_key_zero(self):
        delta = compute_contribution({}, prior_l3={}, posterior_l3={})
        for v in delta.values():
            assert v == 0.0


class TestMarathonTarget:
    def test_missing_profile_target_returns_none(self):
        assert marathon_target_from_profile({"display_name": "runner"}) is None

    def test_structured_profile_target_time(self):
        profile = {"target_distance": "FM", "target_time": "3:40:00"}
        assert marathon_target_from_profile(profile) == 3 * 3600 + 40 * 60

    def test_legacy_chinese_goal_skips_pace_token(self):
        profile = {"目标": "2026-08-30 马拉松破 3:40 (目标配速 5:13/km)"}
        assert marathon_target_from_profile(profile) == 3 * 3600 + 40 * 60

    def test_label_omits_zero_seconds(self):
        assert marathon_target_label(3 * 3600 + 40 * 60) == "Sub-3:40"


# ---------------------------------------------------------------------------
# A1.1 — snapshot shape.
# ---------------------------------------------------------------------------

class TestA1_1_SnapshotShape:
    def test_required_top_level_keys(self, ability_db):
        snap = compute_ability_snapshot(ability_db, "2026-04-23")
        required = {
            "date", "l1_latest", "l2_freshness", "l3_dimensions",
            "l4_composite", "l4_marathon_estimate_s",
            "distance_to_sub_2_50_s", "evidence_activity_ids",
        }
        assert required.issubset(set(snap.keys()))

    def test_l3_dimensions_present(self, ability_db):
        snap = compute_ability_snapshot(ability_db, "2026-04-23")
        dims = snap["l3_dimensions"]
        for k in ("aerobic", "lt", "vo2max", "endurance", "economy", "recovery"):
            assert k in dims
            assert "score" in dims[k]

    def test_l2_shape(self, ability_db):
        snap = compute_ability_snapshot(ability_db, "2026-04-23")
        l2 = snap["l2_freshness"]
        assert "total" in l2 and "breakdown" in l2
        for k in ("tsb_score", "rhr_score", "hrv_score", "fatigue_score"):
            assert k in l2["breakdown"]


# ---------------------------------------------------------------------------
# A1.2 — purity / determinism.
# ---------------------------------------------------------------------------

class TestA1_2_Determinism:
    def test_three_identical_calls(self, ability_db):
        s1 = compute_ability_snapshot(ability_db, "2026-04-23")
        s2 = compute_ability_snapshot(ability_db, "2026-04-23")
        s3 = compute_ability_snapshot(ability_db, "2026-04-23")
        # Stringify deterministically and compare.
        assert json.dumps(s1, sort_keys=True, default=str) == \
               json.dumps(s2, sort_keys=True, default=str)
        assert json.dumps(s2, sort_keys=True, default=str) == \
               json.dumps(s3, sort_keys=True, default=str)


# ---------------------------------------------------------------------------
# A1.3 — easy run: aerobic/economy tiny, LT/VO2max/endurance unchanged.
# ---------------------------------------------------------------------------

class TestA1_3_EasyRunMinimalImpact:
    def test_only_aerobic_and_economy_move(self, ability_db):
        before = compute_ability_snapshot(ability_db, "2026-04-23")

        # Append a collinear easy run: HR 143, pace 322 s/km (line pace = 465 - HR).
        # With this point collinear to the existing (140,325),(145,320),(150,315),
        # the HR-pace regression slope/intercept are preserved exactly.
        new_easy = {
            "label_id": "A_NEW_EASY",
            "name": "Easy 12K (A1.3)",
            "sport_type": 100,
            "date": "2026-04-22T00:00:00+00:00",
            "distance_m": 12000,
            "duration_s": 12 * 322,
            "avg_pace_s_km": 322,
            "avg_hr": 143,
            "max_hr": 153,
            "avg_cadence": 179,
            "train_type": "Aerobic Endurance",
            "laps": [],
            "timeseries": [],
        }
        _seed_activities(ability_db, [new_easy])
        after = compute_ability_snapshot(ability_db, "2026-04-23")

        def dim(snap, k):
            return snap["l3_dimensions"][k]["score"]

        # Aerobic / economy move < 0.2 (noise-floor tolerance).
        assert abs(dim(after, "aerobic") - dim(before, "aerobic")) <= 0.2
        assert abs(dim(after, "economy") - dim(before, "economy")) <= 0.2

        # LT / VO2max / endurance unchanged (no new evidence; collinear regression).
        assert dim(after, "lt") == dim(before, "lt")
        assert dim(after, "vo2max") == dim(before, "vo2max")
        assert dim(after, "endurance") == dim(before, "endurance")


# ---------------------------------------------------------------------------
# A1.4 — interval session bumps VO2max & improves marathon estimate.
# NOTE: plan literal "5:20/km" is physically incompatible with "marathon
# improved" for a sub-2:50 target (VDOT ~36 would regress the estimate).
# We use 3:45/km, a realistic VO2max-pace for this athlete — the ACCEPTANCE
# CRITERION (vo2max delta >= 0.3, new evidence, faster marathon) is unchanged.
# ---------------------------------------------------------------------------

class TestExtractIntervalReps:
    """Regression coverage for the autoKm + type2 dedupe in
    `_extract_interval_reps`. COROS interleaves two parallel "lap streams" and
    the previous implementation summed both, double-counting overlapping work.
    """

    def test_prefers_type2_over_overlapping_autokm(self):
        """A 4×3K interval recorded with both autoKm 1km slices and type2
        plan-step summaries should yield exactly 4 reps totalling 12 km, not
        16 reps totalling 22 km.
        """
        from stride_core.ability import _extract_interval_reps, daniels_vdot

        laps = []
        # 4 work reps. Each rep = 3 autoKm 1km slices + 1 type2 3km summary.
        # autoKm and type2 overlap the same physical 3km of running.
        for rep in range(4):
            base_pace = 246  # ~4:06/km
            for slice_i in range(3):
                laps.append({
                    "lap_index": rep * 4 + slice_i + 1,
                    "lap_type": "autoKm",
                    "distance_m": 1.0, "duration_s": base_pace,
                    "avg_pace": base_pace, "exercise_type": 2,
                })
            laps.append({
                "lap_index": rep * 4 + 4,
                "lap_type": "type2",
                "distance_m": 3.0, "duration_s": 3 * base_pace,
                "avg_pace": base_pace, "exercise_type": 2,
            })
        act = {"label_id": "T_DEDUP", "sport_type": 100, "laps": laps}
        reps = _extract_interval_reps(act)
        assert len(reps) == 4, \
            f"expected 4 type2 reps, got {len(reps)}: {reps}"
        total_d = sum(d for d, _ in reps)
        total_t = sum(t for _, t in reps)
        assert total_d == 12000, f"total distance should be 12 km, got {total_d}"
        assert total_t == 12 * 246, f"total time should be {12*246}, got {total_t}"
        # Sanity: VDOT for 12 km @ 4:06/km
        vdot = daniels_vdot(total_d, total_t)
        assert 50 <= vdot <= 53, f"vdot out of band: {vdot}"

    def test_falls_back_to_autokm_when_no_type2(self):
        """Simple unstructured interval logged with only autoKm rows should
        still produce reps — the type2-preference rule must fall back.
        """
        from stride_core.ability import _extract_interval_reps

        laps = [
            {"lap_index": i, "lap_type": "autoKm",
             "distance_m": 1.0, "duration_s": 240,
             "avg_pace": 240, "exercise_type": 2}
            for i in range(1, 7)
        ]
        act = {"label_id": "T_AUTOKM", "sport_type": 100, "laps": laps}
        reps = _extract_interval_reps(act)
        assert len(reps) == 6, f"autoKm fallback failed: {reps}"

    def test_drops_fragment_outliers_before_dedupe(self):
        """A fragment type2 row (e.g. 0.06km / 27.66s ex_type=0) at the same
        lap_index as a legit autoKm work rep must NOT silently win the dedupe
        and then disappear, dropping the real rep.
        """
        from stride_core.ability import _extract_interval_reps

        laps = [
            # Real work rep
            {"lap_index": 5, "lap_type": "autoKm",
             "distance_m": 1.0, "duration_s": 243.5,
             "avg_pace": 243.5, "exercise_type": 2},
            # Fragment artifact at the SAME lap_index — must be dropped first
            {"lap_index": 5, "lap_type": "type2",
             "distance_m": 0.06, "duration_s": 27.66,
             "avg_pace": 494.65, "exercise_type": 0},
        ]
        act = {"label_id": "T_FRAG", "sport_type": 100, "laps": laps}
        reps = _extract_interval_reps(act)
        assert len(reps) == 1, f"fragment-first drop failed: {reps}"
        d, t = reps[0]
        assert d == 1000.0
        assert abs(t - 243.5) < 0.01

    def test_filters_rest_laps_by_exercise_type(self):
        """Rest laps (exercise_type=4) must never be counted as work reps."""
        from stride_core.ability import _extract_interval_reps

        laps = [
            {"lap_index": 1, "lap_type": "type2",
             "distance_m": 3.0, "duration_s": 750,
             "avg_pace": 250, "exercise_type": 2},
            {"lap_index": 2, "lap_type": "type2",
             "distance_m": 0.5, "duration_s": 180,
             "avg_pace": 360, "exercise_type": 4},
        ]
        act = {"label_id": "T_REST", "sport_type": 100, "laps": laps}
        reps = _extract_interval_reps(act)
        assert len(reps) == 1
        assert reps[0][0] == 3000.0


class TestVo2maxRaceLikeGate:
    """Regression coverage for the `is_race_like` gate inside `compute_l3_vo2max`.
    A 15 km mixed warmup+work+cooldown session must NOT be fed wholesale to
    `daniels_vdot`: doing so dilutes pace badly (VDOT ≈ 41 vs 51 from rep path).
    """

    def test_mixed_session_with_rest_laps_skipped(self):
        """Activity with rest laps mid-effort must skip the race-like path."""
        from stride_core.ability import compute_l3_vo2max

        # 4×3K interval: 12 km work in 48 min, plus warmup/rest/cooldown
        # totalling 15 km / 75 min activity. Without the gate, race-like fed
        # 15 km / 4500 s into Daniels → VDOT ≈ 41.
        laps = []
        # warmup (continuous, not "rest" by ex_type=1)
        laps.append({"lap_index": 0, "lap_type": "type2",
                     "distance_m": 1.0, "duration_s": 360,
                     "avg_pace": 360, "exercise_type": 1})
        # 4 work reps + 3 rest jogs in between
        for i in range(4):
            laps.append({"lap_index": i * 2 + 1, "lap_type": "type2",
                         "distance_m": 3.0, "duration_s": 720,
                         "avg_pace": 240, "exercise_type": 2})
            if i < 3:
                laps.append({"lap_index": i * 2 + 2, "lap_type": "type2",
                             "distance_m": 0.4, "duration_s": 180,
                             "avg_pace": 450, "exercise_type": 4})
        # cooldown
        laps.append({"lap_index": 99, "lap_type": "type2",
                     "distance_m": 1.6, "duration_s": 480,
                     "avg_pace": 300, "exercise_type": 3})
        act = {
            "label_id": "T_MIXED",
            "sport_type": 100,
            "distance_m": 15.0,
            "duration_s": 4500,
            "train_type": "Interval",
            "laps": laps,
            "timeseries": [],
        }
        score, ev, det = compute_l3_vo2max([act], None, hr_max=185)
        # Rep path computes VDOT from the 4×3K work only: 12 km / 48 min
        # → VDOT ≈ 52.6. Race-like path (now gated) would have produced
        # 15 km / 4500 s → VDOT ≈ 41 — much lower.
        assert det["vo2max_primary"] is not None
        assert det["vo2max_primary"] >= 50.0, \
            f"rep path expected, got primary {det['vo2max_primary']}"

    def test_clean_5k_tt_still_admitted_via_race_like(self):
        """A clean continuous 5K time trial (no rest laps) must STILL go
        through the race-like path."""
        from stride_core.ability import compute_l3_vo2max, daniels_vdot

        # 5 km in 19:30, marked Threshold, no rest laps at all.
        act = {
            "label_id": "T_5K_TT",
            "sport_type": 100,
            "distance_m": 5.0,
            "duration_s": 19 * 60 + 30,
            "train_type": "Threshold",
            "laps": [],  # no laps → no rep path, no rest segments
            "timeseries": [],
        }
        score, ev, det = compute_l3_vo2max([act], None, hr_max=185)
        # Race-like path: VDOT(5000, 1170) ≈ 51
        assert det["vo2max_primary"] is not None
        expected = daniels_vdot(5000, 1170)
        assert abs(det["vo2max_primary"] - expected) < 0.5
        assert ev == ["T_5K_TT"]


class TestEconomyDedupe:
    """Regression coverage for L3 economy autoKm/type2 dedupe."""

    def test_economy_does_not_double_count_overlapping_laps(self):
        """An autoKm + type2 pair sharing a lap_index must contribute one
        cadence sample, not two. Without dedupe, an unbalanced pair (e.g.
        autoKm cad=170, type2 cad=185) skews the median.
        """
        from stride_core.ability import compute_l3_economy

        # Two activities: in the dedupe-enabled path, only the type2 cadence
        # of 185 should win. With both counted, median lands at ~177.5.
        laps = [
            {"lap_index": 1, "lap_type": "autoKm",
             "distance_m": 1.0, "duration_s": 290, "avg_pace": 290,
             "avg_cadence": 170, "exercise_type": 2},
            {"lap_index": 1, "lap_type": "type2",
             "distance_m": 3.0, "duration_s": 870, "avg_pace": 290,
             "avg_cadence": 185, "exercise_type": 2},
        ]
        act = {"label_id": "T_ECON", "sport_type": 100, "laps": laps}
        score, ev, det = compute_l3_economy([act])
        # With dedupe: only type2 (cad 185) counted → median = 185.
        assert det["median_cadence"] == 185.0, \
            f"economy dedupe failed; median={det['median_cadence']}"


class TestA1_4_IntervalEvidence:
    def test_interval_bumps_vo2max(self, ability_db):
        before = compute_ability_snapshot(ability_db, "2026-04-23")
        before_vo2 = before["l3_dimensions"]["vo2max"]["score"]
        before_marathon = before["l4_marathon_estimate_s"]
        assert before_marathon is not None, \
            "baseline must produce a marathon estimate for A1.4 to test a decrease"

        # 6 × 1K @ 3:45/km interval reps, marked exercise_type=2.
        reps_laps = [
            {"lap_type": "autoKm", "distance_m": 1.0, "duration_s": 225,
             "avg_pace": 225, "avg_hr": 175, "max_hr": 180, "avg_cadence": 188,
             "exercise_type": 2}
            for _ in range(6)
        ]
        # Rest laps (exercise_type=4 = recovery) — excluded from rep pool.
        rest_laps = [
            {"lap_type": "autoKm", "distance_m": 0.4, "duration_s": 120,
             "avg_pace": 300, "avg_hr": 140, "max_hr": 150, "avg_cadence": 170,
             "exercise_type": 4}
            for _ in range(5)
        ]
        interval_act = {
            "label_id": "A_NEW_INTERVAL",
            "name": "6x1K @ 3:45",
            "sport_type": 100,
            "date": "2026-04-22T10:00:00+00:00",
            "distance_m": 8000,   # reps + rest
            "duration_s": 1950,
            "avg_pace_s_km": 244,
            "avg_hr": 168,
            "max_hr": 180,
            "avg_cadence": 185,
            "train_type": "Interval",
            "laps": reps_laps + rest_laps,
            "timeseries": [],
        }
        _seed_activities(ability_db, [interval_act])
        after = compute_ability_snapshot(ability_db, "2026-04-23")
        after_vo2 = after["l3_dimensions"]["vo2max"]["score"]
        after_marathon = after["l4_marathon_estimate_s"]

        assert abs(after_vo2 - before_vo2) >= 0.3, \
            f"vo2max delta too small: {before_vo2} → {after_vo2}"
        assert "A_NEW_INTERVAL" in after["l3_dimensions"]["vo2max"]["evidence"]
        assert after_marathon is not None
        assert after_marathon < before_marathon, \
            f"marathon estimate should decrease: {before_marathon} → {after_marathon}"


# ---------------------------------------------------------------------------
# A1.5 — long run bumps endurance & improves marathon estimate.
# ---------------------------------------------------------------------------

class TestA1_5_LongRunEvidence:
    def test_long_run_bumps_endurance(self, ability_db):
        before = compute_ability_snapshot(ability_db, "2026-04-23")
        before_end = before["l3_dimensions"]["endurance"]["score"]
        before_marathon = before["l4_marathon_estimate_s"]
        assert before_marathon is not None

        # 30K @ 4:30/km with per-km laps (no exercise_type → reps-path eligible).
        # HR drift < 5%: first 15 laps @ HR 150, last 15 @ HR 156.
        long_laps = []
        for i in range(30):
            hr = 150 if i < 15 else 156
            long_laps.append({
                "lap_type": "autoKm", "distance_m": 1.0, "duration_s": 270,
                "avg_pace": 270, "avg_hr": hr, "max_hr": hr + 4,
                "avg_cadence": 182, "exercise_type": None,
            })
        long_act = {
            "label_id": "A_NEW_LONG",
            "name": "30K long run",
            "sport_type": 100,
            "date": "2026-04-22T06:00:00+00:00",
            "distance_m": 30000,
            "duration_s": 30 * 270,
            "avg_pace_s_km": 270,
            "avg_hr": 153,
            "max_hr": 162,
            "avg_cadence": 182,
            "train_type": "Base",
            "laps": long_laps,
            "timeseries": [
                {"timestamp": i * 30, "heart_rate": 150 + i // 20,
                 "speed": 3.7, "cadence": 182}
                for i in range(300)
            ],
        }
        _seed_activities(ability_db, [long_act])
        after = compute_ability_snapshot(ability_db, "2026-04-23")
        after_end = after["l3_dimensions"]["endurance"]["score"]
        after_marathon = after["l4_marathon_estimate_s"]

        assert abs(after_end - before_end) >= 0.5, \
            f"endurance delta too small: {before_end} → {after_end}"
        assert "A_NEW_LONG" in after["l3_dimensions"]["endurance"]["evidence"]
        assert after_marathon < before_marathon


# ---------------------------------------------------------------------------
# A1.6 — marathon estimate changes consistently with VDOT.
# ---------------------------------------------------------------------------

class TestA1_6_MarathonVdotLinearity:
    def test_delta_matches_daniels_interpolation(self):
        base_l3 = {"vo2max_used_vdot": 55.0, "endurance": 80.0}
        bumped_l3 = {"vo2max_used_vdot": 60.0, "endurance": 80.0}
        t1 = estimate_marathon_time_s(base_l3)
        t2 = estimate_marathon_time_s(bumped_l3)
        # Expected from canonical table + same endurance correction.
        endurance_factor = 1.02 - (80 - 70) / 15 * 0.04
        expected_t1 = ability.DANIELS_VDOT_TO_MARATHON_S[55] * endurance_factor
        expected_t2 = ability.DANIELS_VDOT_TO_MARATHON_S[60] * endurance_factor
        assert abs(t1 - expected_t1) <= 5
        assert abs(t2 - expected_t2) <= 5
        # Delta within ±5s of canonical delta.
        assert abs((t2 - t1) - (expected_t2 - expected_t1)) <= 5

    def test_vdot_monotonic_over_table(self):
        # Each +5 VDOT should shave time.
        prev = None
        for v in range(35, 85, 5):
            t = estimate_marathon_time_s({"vo2max_used_vdot": v, "endurance": 80})
            if prev is not None:
                assert t < prev, f"non-monotonic at VDOT {v}: {prev} → {t}"
            prev = t

    def test_stale_high_vdot_ignored_by_current_window(self, tmp_path, fx):
        db = Database(db_path=tmp_path / "stale_vdot.db")
        _seed_from_fixture(db, fx)
        try:
            old_fast = {
                "label_id": "OLD_FAST_INTERVAL",
                "name": "Old 6x1K @ 3:30",
                "sport_type": 100,
                "date": "2025-10-01T10:00:00+00:00",
                "distance_m": 8000,
                "duration_s": 6 * 210 + 5 * 120,
                "avg_pace_s_km": 232,
                "avg_hr": 168,
                "max_hr": 180,
                "avg_cadence": 185,
                "train_type": "Interval",
                "laps": [
                    {"lap_type": "autoKm", "distance_m": 1.0, "duration_s": 210,
                     "avg_pace": 210, "avg_hr": 175, "max_hr": 180,
                     "avg_cadence": 188, "exercise_type": 2}
                    for _ in range(6)
                ],
                "timeseries": [],
            }
            recent_5k = {
                "label_id": "RECENT_5K",
                "name": "Recent 5K TT",
                "sport_type": 100,
                "date": "2026-04-22T10:00:00+00:00",
                "distance_m": 5000,
                "duration_s": 1500,
                "avg_pace_s_km": 300,
                "avg_hr": 170,
                "max_hr": 180,
                "avg_cadence": 182,
                "train_type": "Threshold",
                "laps": [],
                "timeseries": [],
            }
            _seed_activities(db, [old_fast, recent_5k])

            snap = compute_ability_snapshot(db, "2026-04-23")
            vo2 = snap["l3_dimensions"]["vo2max"]
            expected_recent_vdot = daniels_vdot(5000, 1500)

            assert vo2["evidence"] == ["RECENT_5K"]
            assert vo2["vo2max_used_vdot"] == pytest.approx(expected_recent_vdot, abs=0.01)
        finally:
            db.close()


# ---------------------------------------------------------------------------
# A1.7 — VO2max three-estimator panel, 5K TT calibration.
# ---------------------------------------------------------------------------

class TestA1_7_Vo2maxEstimators:
    def test_5k_tt_primary_matches_daniels(self, tmp_path, fx):
        db = Database(db_path=tmp_path / "a17.db")
        _seed_from_fixture(db, fx)

        # Add a 5K time trial at 18:55 on 2026-04-22 — race-like activity
        # triggers primary VDOT path inside compute_l3_vo2max.
        tt_time_s = 18 * 60 + 55
        tt = {
            "label_id": "A_5K_TT",
            "name": "5K TT",
            "sport_type": 100,
            "date": "2026-04-22T12:00:00+00:00",
            "distance_m": 5000,
            "duration_s": tt_time_s,
            "avg_pace_s_km": tt_time_s / 5.0,
            "avg_hr": 178,
            "max_hr": 185,
            "avg_cadence": 188,
            "train_type": "VO2 Max",
            "laps": [],
            "timeseries": [],
        }
        _seed_activities(db, [tt])

        snap = compute_ability_snapshot(db, "2026-04-23")
        vo2 = snap["l3_dimensions"]["vo2max"]

        expected_vdot = daniels_vdot(5000, tt_time_s)
        # Correct 5K 18:55 value is ~53.2 — not 58. Test against actual formula.
        assert vo2["vo2max_primary"] is not None
        assert abs(vo2["vo2max_primary"] - expected_vdot) <= 1.0, \
            f"primary VDOT off: expected≈{expected_vdot}, got {vo2['vo2max_primary']}"

        # All three estimators populated.
        assert vo2["vo2max_primary"] is not None
        assert vo2["vo2max_secondary"] is not None
        assert vo2["vo2max_floor"] is not None
        assert vo2["vo2max_source"] == "primary"
        assert vo2["vo2max_used"] == pytest.approx(vo2["vo2max_primary"], abs=0.01)

        db.close()


# ---------------------------------------------------------------------------
# Boundary / resilience.
# ---------------------------------------------------------------------------

class TestBoundary:
    def test_empty_db_no_exception(self, tmp_path):
        db = Database(db_path=tmp_path / "empty.db")
        snap = compute_ability_snapshot(db, "2026-04-23")
        # No evidence anywhere.
        assert snap["evidence_activity_ids"] == []
        # Marathon estimate unavailable with no VO2max evidence.
        assert snap["l4_marathon_estimate_s"] is None
        # All 5 evidence-driven L3 dimensions are zero. Recovery falls back to
        # 50 (L2 default when no health data) so l4_composite is small but > 0.
        for k in ("aerobic", "lt", "vo2max", "endurance", "economy"):
            assert snap["l3_dimensions"][k]["score"] == 0.0
        # Composite is dominated by recovery (weight 0.05): ≤ 50 * 0.05 = 2.5.
        assert snap["l4_composite"] <= 2.5
        db.close()

    def test_none_db(self):
        snap = compute_ability_snapshot(None, "2026-04-23")
        assert snap["l4_composite"] == 0.0

    def test_db_without_conn_attribute(self):
        class Fake:
            pass
        snap = compute_ability_snapshot(Fake(), "2026-04-23")
        assert snap["l4_composite"] == 0.0

    def test_only_easy_runs_fallback(self, tmp_path, fx):
        db = Database(db_path=tmp_path / "easy_only.db")
        _seed_from_fixture(db, fx)
        snap = compute_ability_snapshot(db, "2026-04-23")
        vo2 = snap["l3_dimensions"]["vo2max"]
        # No interval / race-like evidence → primary is None, secondary falls back
        # via HR-pace regression.
        assert vo2["vo2max_primary"] is None
        assert vo2["vo2max_source"] in ("secondary", "floor")
        # LT not triggered either (no per-km laps).
        assert snap["l3_dimensions"]["lt"]["score"] == 0.0
        db.close()

    def test_hrmax_unknown_uth_returns_zero(self):
        # Uth–Sørensen must not crash when either HR is 0/None.
        assert uth_sorensen_vo2max(None, 48) == 0.0
        assert uth_sorensen_vo2max(185, None) == 0.0

    def test_snapshot_handles_db_errors(self, tmp_path, monkeypatch):
        db = Database(db_path=tmp_path / "err.db")
        # Force activity fetch to raise; compute_ability_snapshot must not
        # bubble the exception.
        def boom(*a, **kw):
            raise sqlite_error()
        import sqlite3

        def sqlite_error():
            return sqlite3.OperationalError("forced")

        monkeypatch.setattr(ability, "_fetch_recent_activities", boom)
        snap = compute_ability_snapshot(db, "2026-04-23")
        assert snap["date"] == "2026-04-23"
        db.close()
