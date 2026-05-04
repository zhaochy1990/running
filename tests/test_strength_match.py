"""Tests for ``coros_sync.translate._match_exercise`` strength matcher.

The matcher is the bridge between plan specs (which carry a Chinese
``display_name`` plus an English snake_case ``canonical_id``) and the
COROS exercise catalog (mostly English snake_case ``overview`` with a
handful of Chinese-named entries). These tests pin the four matching
strategies (CN substring, EN substring, EN token-overlap, fallback to
None) against representative catalog rows copied from
``src/coros_sync/exercise_catalog.md``.
"""

from __future__ import annotations

from coros_sync.translate import _match_exercise
from stride_core.workout_spec import StrengthExerciseSpec, StrengthTargetKind


# ─────────────────────────────────────────────────────────────────────────────
# Catalog fixtures — representative rows from exercise_catalog.md
# ─────────────────────────────────────────────────────────────────────────────


def _ex(t_code: str, overview: str, ex_id: str = "0") -> dict:
    """Build a minimal catalog entry dict (only fields the matcher reads)."""
    return {"id": ex_id, "name": t_code, "overview": overview}


# A small library covering the patterns we care about.
LIBRARY: list[dict] = [
    _ex("T1010", "planks"),
    _ex("T1016", "坐姿肩上哑铃推举"),
    _ex("T1150", "bird_dog_type"),
    _ex("T1185", "side_plank"),
    _ex("T1262", "greatest_stretch"),
    _ex("T1287", "romanian_deadlift"),
    _ex("T1301", "goblet_squat"),
    _ex("T1305", "dumbbell_romanian_deadlift"),
    _ex("T1310", "farmers_walk"),
    _ex("T1368", "copenhagen_plank"),
    # Hypothetical Chinese entry for "哥本哈根侧平板" reverse-substring test.
    _ex("T9001", "侧平板"),
]


def _spec(canonical_id: str, display_name: str) -> StrengthExerciseSpec:
    return StrengthExerciseSpec(
        canonical_id=canonical_id,
        display_name=display_name,
        sets=3,
        target_kind=StrengthTargetKind.REPS,
        target_value=10,
    )


# ─────────────────────────────────────────────────────────────────────────────
# 1. Chinese substring path
# ─────────────────────────────────────────────────────────────────────────────


def test_match_chinese_overview_exact():
    """Display ``坐姿肩上哑铃推举`` directly hits the same Chinese overview."""
    spec = _spec("seated_db_shoulder_press", "坐姿肩上哑铃推举")
    match = _match_exercise(spec, LIBRARY)
    assert match is not None
    assert match["overview"] == "坐姿肩上哑铃推举"


def test_match_chinese_substring_long_in_short():
    """Long display ``哥本哈根侧平板`` finds short catalog ``侧平板`` (reverse substring)."""
    spec = _spec("xx_no_english_match_xx", "哥本哈根侧平板")
    match = _match_exercise(spec, LIBRARY)
    assert match is not None
    assert match["overview"] == "侧平板"


# ─────────────────────────────────────────────────────────────────────────────
# 2. English substring path
# ─────────────────────────────────────────────────────────────────────────────


def test_match_english_canonical_substring():
    """canonical ``goblet_squat`` (no suffix) hits overview ``goblet_squat``."""
    spec = _spec("goblet_squat", "高脚杯深蹲")
    match = _match_exercise(spec, LIBRARY)
    assert match is not None
    assert match["overview"] == "goblet_squat"


def test_match_english_with_equipment_suffix():
    """``romanian_deadlift_db`` should strip ``_db`` and hit ``romanian_deadlift``.

    Two candidates contain that substring (``romanian_deadlift`` and
    ``dumbbell_romanian_deadlift``); first-match-wins picks whichever appears
    first in the library, but both are acceptable matches — we just assert
    that *something* matched and contained the canonical core.
    """
    spec = _spec("romanian_deadlift_db", "罗马尼亚硬拉 (哑铃)")
    match = _match_exercise(spec, LIBRARY)
    assert match is not None
    assert "romanian_deadlift" in match["overview"]


def test_match_english_strips_db_suffix_for_goblet():
    """Direct happy path: ``goblet_squat_db`` → ``goblet_squat``."""
    spec = _spec("goblet_squat_db", "哑铃高脚杯深蹲 (5kg)")
    match = _match_exercise(spec, LIBRARY)
    assert match is not None
    assert match["overview"] == "goblet_squat"


# ─────────────────────────────────────────────────────────────────────────────
# 3. English token overlap fallback
# ─────────────────────────────────────────────────────────────────────────────


def test_match_english_token_overlap_word_order():
    """``goblet_squat_db`` ↔ ``dumbbell_goblet_squat`` share {goblet, squat}.

    To exercise this path the substring path #2 must miss; we feed a library
    that does NOT contain bare ``goblet_squat`` so the matcher has to fall
    through to token overlap.
    """
    library = [
        _ex("T1305", "dumbbell_romanian_deadlift"),
        _ex("T9999", "dumbbell_goblet_squat"),  # only token-overlap candidate
    ]
    spec = _spec("goblet_squat_db", "高脚杯深蹲")
    match = _match_exercise(spec, library)
    assert match is not None
    assert match["overview"] == "dumbbell_goblet_squat"


def test_token_overlap_picks_highest_score():
    """When multiple library entries share tokens, pick the highest-overlap one."""
    library = [
        # 1 of 3 tokens overlap (goblet) → 1/3 ~ 0.33, BELOW threshold
        _ex("T1", "goblet_lunge_kettlebell"),
        # 2 of 3 tokens overlap (goblet, squat) → 2/3 ~ 0.67, ABOVE threshold
        _ex("T2", "dumbbell_goblet_squat"),
    ]
    spec = _spec("goblet_squat_db", "高脚杯深蹲")
    match = _match_exercise(spec, library)
    assert match is not None
    assert match["overview"] == "dumbbell_goblet_squat"


# ─────────────────────────────────────────────────────────────────────────────
# 4. No-match fallback
# ─────────────────────────────────────────────────────────────────────────────


def test_no_match_returns_none():
    """A spec with no Chinese overlap and no English token overlap returns None."""
    library = [
        _ex("T1", "burpees"),
        _ex("T2", "jumping_jacks"),
    ]
    spec = _spec("dead_bug", "Dead Bug")  # canonical tokens {dead, bug}
    assert _match_exercise(spec, library) is None


def test_empty_library_returns_none():
    spec = _spec("goblet_squat_db", "高脚杯深蹲")
    assert _match_exercise(spec, []) is None


# ─────────────────────────────────────────────────────────────────────────────
# 5. Precedence — Chinese wins over English when both could hit
# ─────────────────────────────────────────────────────────────────────────────


def test_chinese_match_takes_precedence_over_english():
    """When both a Chinese-overview and an English-overview row could match,
    the matcher returns the first-encountered hit (CN before EN in this lib).

    We construct a library where the CN row comes first; since strategy 1
    runs before strategy 2 inside the loop and either returns immediately,
    iteration order determines the outcome. We assert the CN row wins.
    """
    library = [
        _ex("T1016", "坐姿肩上哑铃推举"),  # CN entry
        _ex("T9999", "seated_dumbbell_shoulder_press"),  # EN entry
    ]
    spec = StrengthExerciseSpec(
        canonical_id="seated_dumbbell_shoulder_press",
        display_name="坐姿肩上哑铃推举",
        sets=3,
        target_kind=StrengthTargetKind.REPS,
        target_value=10,
    )
    match = _match_exercise(spec, library)
    assert match is not None
    assert match["overview"] == "坐姿肩上哑铃推举"


def test_english_only_when_no_chinese_in_overview():
    """A spec with Chinese display_name but no matching Chinese overview falls
    through to English matching against the canonical_id.

    ``Dead Bug`` has no CJK in display_name (so CN path skipped), and the
    canonical ``dead_bug`` should hit overview ``dead_bug`` via substring.
    """
    library = [_ex("T9", "dead_bug")]
    spec = _spec("dead_bug", "Dead Bug")
    match = _match_exercise(spec, library)
    assert match is not None
    assert match["overview"] == "dead_bug"


# ─────────────────────────────────────────────────────────────────────────────
# 6. P1W2 sanity — hit-rate against representative real-plan exercises
# ─────────────────────────────────────────────────────────────────────────────


def test_p1w2_strength_session_hit_rate():
    """Real W2 plan strength specs should mostly find a catalog match.

    The W2 plan currently sees 100% misses with the legacy substring matcher.
    With the fix, exercises with a clean canonical_id+catalog mapping should
    hit; truly novel ones (single_leg_wall_sit, banded ankle inversion) may
    legitimately miss.
    """
    # Subset of P1W2's strength session A (most recoverable matches).
    specs = [
        _spec("goblet_squat_db", "哑铃深蹲 (减半重量或自重)"),
        _spec("plank_basic", "平板支撑"),
        _spec("side_plank", "侧平板"),
        _spec("bird_dog", "Bird Dog"),
        _spec("copenhagen_side_plank", "哥本哈根侧平板 (T1368)"),
    ]
    matches = [_match_exercise(s, LIBRARY) for s in specs]
    hits = sum(1 for m in matches if m is not None)
    # We expect at least 4 of these 5 to hit — the strict goal is that the
    # matcher no longer goes 100% custom on canonical strength names.
    assert hits >= 4, f"only {hits}/5 hit; matches={[m and m['overview'] for m in matches]}"
