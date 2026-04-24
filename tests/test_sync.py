"""Smoke tests for coros_sync.sync helpers — focused on the ability hook."""

from __future__ import annotations

import pytest

from coros_sync.sync import (
    _fmt_delta,
    _fmt_marathon,
    _fmt_time_delta,
    _try_run_ability_hook,
)


class TestFormatHelpers:
    def test_fmt_marathon(self):
        assert _fmt_marathon(None) == "—"
        assert _fmt_marathon(0) == "—"
        assert _fmt_marathon(10200) == "2:50:00"
        assert _fmt_marathon(11022) == "3:03:42"

    def test_fmt_delta(self):
        assert _fmt_delta(None, 10.0) == "—"
        assert _fmt_delta(10.0, None) == "—"
        assert _fmt_delta(60.0, 61.2) == "+1.2"
        assert _fmt_delta(60.0, 58.8) == "-1.2"

    def test_fmt_time_delta(self):
        assert _fmt_time_delta(None, 10200) == "—"
        assert _fmt_time_delta(10200, None) == "—"
        assert _fmt_time_delta(10200, 10000) == "-3:20"
        assert _fmt_time_delta(10000, 10100) == "+1:40"


class TestAbilityHook:
    def test_empty_new_activities_does_not_fail(self, db, capsys):
        """With no activities or new label_ids, the hook should run silently and persist
        an empty snapshot without raising. The sync pipeline must remain robust."""
        _try_run_ability_hook(db, [])

        # Should not raise — and snapshot rows for today may or may not be written
        # depending on data availability, but the hook must not leak an exception.
        captured = capsys.readouterr()
        # Prints a summary line.
        assert "ability:" in captured.out

    def test_hook_with_unknown_label_id_skips_gracefully(self, db, capsys):
        """Passing a label_id that isn't in the DB should not raise."""
        _try_run_ability_hook(db, ["nonexistent_label"])
        captured = capsys.readouterr()
        assert "ability:" in captured.out

    def test_hook_tolerates_broken_db(self, capsys):
        """Any unexpected exception during the ability hook must be swallowed."""

        class BrokenDB:
            def __getattr__(self, name):
                raise RuntimeError(f"boom:{name}")

        # Should not raise.
        _try_run_ability_hook(BrokenDB(), ["x"])
