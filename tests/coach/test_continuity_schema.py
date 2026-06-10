from coach.schemas import ContinuitySignals


def test_continuity_signals_round_trips():
    sig = ContinuitySignals(
        days_since_last_race=84,
        post_race_recovery_status="recovered",
        recent_aerobic_weeks=6,
        recent_volume_trend="rising",
        recent_longest_run_km=32.0,
        recent_quality_sessions_per_week=1.5,
        current_form_zone="维持期",
        current_chronic_load=64.1,
        return_from_layoff=False,
        macro_cycle="summer",
        season_context="夏→秋，6-10月，含高温窗口",
        injuries=["achilles"],
    )
    dumped = sig.model_dump()
    assert dumped["macro_cycle"] == "summer"
    assert ContinuitySignals.model_validate(dumped).current_chronic_load == 64.1
