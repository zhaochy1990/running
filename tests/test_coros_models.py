"""Unit tests for `coros_sync.models`."""
from __future__ import annotations

from coros_sync.models import daily_hrv_from_coros, hrv_list_from_dashboard


class TestDailyHrvFromCoros:
    def test_full_item_extracted(self):
        # Captured from trainingcn.coros.com /dashboard/query response,
        # sleepHrvList[0] for user 448004085413593088 on 2026-05-16.
        item = {
            "avgSleepHrv": 42,
            "happenDay": 20260516,
            "sleepHrvBase": 34,
            "sleepHrvIntervalList": [5, 26, 30, 38],
            "sleepHrvSd": 3.77,
            "userId": 448004085413593088,
        }
        h = daily_hrv_from_coros(item)
        assert h.date == "2026-05-16"
        assert h.last_night_avg == 42
        assert h.baseline_low_upper == 26
        assert h.baseline_balanced_low == 30
        assert h.baseline_balanced_upper == 38
        # COROS doesn't surface these per-day fields.
        assert h.weekly_avg is None
        assert h.last_night_5min_high is None
        assert h.feedback_phrase is None

    def test_status_derived_from_baseline(self):
        # COROS doesn't return a status string; derive one so downstream
        # `training_load.core` short-circuits low-HRV checks against the
        # baseline interval the watch itself uses.
        base = {"happenDay": 20260518, "sleepHrvIntervalList": [5, 26, 30, 38], "sleepHrvBase": 34}
        # Within balanced range
        assert daily_hrv_from_coros({**base, "avgSleepHrv": 32}).status == "BALANCED"
        # Above balanced upper
        assert daily_hrv_from_coros({**base, "avgSleepHrv": 40}).status == "UNBALANCED"
        # Below balanced low but above low_upper (the gray "unbalanced" band)
        assert daily_hrv_from_coros({**base, "avgSleepHrv": 28}).status == "UNBALANCED"
        # Below low_upper
        assert daily_hrv_from_coros({**base, "avgSleepHrv": 20}).status == "LOW"
        # Below absolute floor
        assert daily_hrv_from_coros({**base, "avgSleepHrv": 3}).status == "POOR"

    def test_handles_missing_interval_list(self):
        # Earliest days after first HRV reading may not have a baseline
        # established yet.
        item = {"avgSleepHrv": 50, "happenDay": 20260101}
        h = daily_hrv_from_coros(item)
        assert h.date == "2026-01-01"
        assert h.last_night_avg == 50
        assert h.baseline_low_upper is None
        assert h.baseline_balanced_low is None
        assert h.baseline_balanced_upper is None
        assert h.status is None  # cannot classify without baseline

    def test_handles_missing_value(self):
        # Some days may have a placeholder entry with no HRV reading.
        item = {"happenDay": 20260102, "sleepHrvIntervalList": [5, 26, 30, 38]}
        h = daily_hrv_from_coros(item)
        assert h.date == "2026-01-02"
        assert h.last_night_avg is None
        assert h.status is None

    def test_rejects_bool_value(self):
        # `isinstance(True, int)` is True in Python; without an explicit guard,
        # a stray bool would land as 1 / 0 in last_night_avg and corrupt the
        # personal-baseline comparison downstream.
        h = daily_hrv_from_coros({"avgSleepHrv": True, "happenDay": 20260103,
                                  "sleepHrvIntervalList": [5, 26, 30, 38]})
        assert h.last_night_avg is None
        assert h.status is None

    def test_null_happenday_yields_empty_date(self):
        # COROS may emit placeholder list entries with happenDay=null; the
        # mapper must NOT write the literal string "None" into the DB.
        h = daily_hrv_from_coros({"avgSleepHrv": 30, "happenDay": None,
                                  "sleepHrvIntervalList": [5, 26, 30, 38]})
        assert h.date == ""

    def test_float_happenday_coerced(self):
        # Some endpoints return happenDay as float (e.g. 20260516.0); coerce.
        h = daily_hrv_from_coros({"avgSleepHrv": 30, "happenDay": 20260516.0,
                                  "sleepHrvIntervalList": [5, 26, 30, 38]})
        assert h.date == "2026-05-16"

    def test_interval_with_null_element_drops_status(self):
        # Don't TypeError on a malformed baseline like [5, None, 30, 38].
        h = daily_hrv_from_coros({"avgSleepHrv": 30, "happenDay": 20260104,
                                  "sleepHrvIntervalList": [5, None, 30, 38]})
        assert h.status is None
        # The non-null neighbors still come through individually.
        assert h.baseline_low_upper is None
        assert h.baseline_balanced_low == 30
        assert h.baseline_balanced_upper == 38


class TestHrvListFromDashboard:
    def test_extracts_full_list(self):
        # /dashboard/query → data.summaryInfo
        summary = {
            "sleepHrvData": {
                "avgSleepHrv": 31,
                "happenDay": 20260522,
                "sleepHrvList": [
                    {"avgSleepHrv": 42, "happenDay": 20260516,
                     "sleepHrvIntervalList": [5, 26, 30, 38], "sleepHrvBase": 34},
                    {"avgSleepHrv": 44, "happenDay": 20260517,
                     "sleepHrvIntervalList": [5, 27, 31, 39], "sleepHrvBase": 35},
                    {"avgSleepHrv": 31, "happenDay": 20260522,
                     "sleepHrvIntervalList": [5, 25, 29, 39], "sleepHrvBase": 34},
                ],
            }
        }
        rows = hrv_list_from_dashboard(summary)
        assert [r.date for r in rows] == ["2026-05-16", "2026-05-17", "2026-05-22"]
        assert [r.last_night_avg for r in rows] == [42, 44, 31]

    def test_returns_empty_when_missing(self):
        assert hrv_list_from_dashboard({}) == []
        assert hrv_list_from_dashboard({"sleepHrvData": {}}) == []
        assert hrv_list_from_dashboard({"sleepHrvData": {"sleepHrvList": []}}) == []

    def test_filters_rows_with_unparseable_dates(self):
        # Defense in depth: even if COROS one day emits a bogus happenDay,
        # we must not write `date=""` / `date="None"` rows to the DB.
        summary = {"sleepHrvData": {"sleepHrvList": [
            {"avgSleepHrv": 42, "happenDay": None,
             "sleepHrvIntervalList": [5, 26, 30, 38]},
            {"avgSleepHrv": 31, "happenDay": 20260522,
             "sleepHrvIntervalList": [5, 25, 29, 39]},
            {"avgSleepHrv": 99, "happenDay": "garbage"},
        ]}}
        rows = hrv_list_from_dashboard(summary)
        assert [r.date for r in rows] == ["2026-05-22"]
