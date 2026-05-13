/// DayPlan — local model derived from [PlanDaysResponse] for the D6 screen.
///
/// We don't generate code for this file — it's a hand-mapped view model
/// that translates [PlanDay] + [PlannedSession] into the fields D6 needs.
/// Keeps the screen decoupled from raw API shapes and makes it easy to
/// add warmup_blocks / nutrition.pre if/when the backend exposes them.
library;

import '../../../data/models/plan.dart';

/// Resolved view-model for a single training session, ready for D6 rendering.
class DayPlan {

  // ── Factory ───────────────────────────────────────────────────────────────

  /// Build from [PlanDay] + index.
  ///
  /// Field-mapping notes vs. spec assumptions:
  ///
  /// | Spec assumption           | Actual [PlannedSession] field            | Match? |
  /// |---------------------------|------------------------------------------|--------|
  /// | session.kind              | kind (String)                            | YES    |
  /// | session.distance_m        | totalDistanceM                           | YES (renamed) |
  /// | session.duration_sec      | totalDurationS                           | YES (renamed) |
  /// | target_pace_sec_per_km_*  | targetPace (String, e.g. "5:00-5:30")   | PARTIAL — parsed below |
  /// | target_hr_low/high        | targetHrZone (String, e.g. "130-150")   | PARTIAL — parsed below |
  /// | warmup_blocks             | NOT in API response (null → default)     | MISMATCH |
  /// | nutrition.pre             | PlannedNutrition.notes (String?)        | PARTIAL — used as fallback |
  ///
  /// Both targetPace and targetHrZone are free-form strings like "5:00-5:30/km"
  /// or "130-150 bpm".  We parse them best-effort; on failure the fields stay
  /// null and the UI shows "—".
  factory DayPlan.fromPlanDay(PlanDay day, int sessionIndex) {
    final session = day.sessions[sessionIndex];

    final (paceLow, paceHigh) = _parsePaceRange(session.targetPace);
    final (hrLow, hrHigh) = _parseHrRange(session.targetHrZone);

    return DayPlan(
      date: day.date,
      sessionIndex: sessionIndex,
      kind: session.kind,
      name: session.title ?? _kindLabel(session.kind),
      distanceM: session.totalDistanceM,
      durationSec: session.totalDurationS,
      targetPaceLowSecPerKm: paceLow,
      targetPaceHighSecPerKm: paceHigh,
      targetHrLow: hrLow,
      targetHrHigh: hrHigh,
      // warmup_blocks not yet in API; null triggers default list in UI.
      warmupBlocks: null,
      // Use nutrition notes as pre-training hint if available.
      nutritionPre: day.nutrition?.notes,
    );
  }
  const DayPlan({
    required this.date,
    required this.sessionIndex,
    required this.kind,
    required this.name,
    this.distanceM,
    this.durationSec,
    this.targetPaceLowSecPerKm,
    this.targetPaceHighSecPerKm,
    this.targetHrLow,
    this.targetHrHigh,
    this.warmupBlocks,
    this.nutritionPre,
  });

  /// ISO date string, e.g. "2026-05-12".
  final String date;

  /// Zero-based index within the day's session list.
  final int sessionIndex;

  /// Session kind: "E" / "M" / "T" / "I" / "R" / "rest".
  final String kind;

  /// Human-readable session name / title.
  final String name;

  /// Total distance in metres (may be null for duration-based sessions).
  final num? distanceM;

  /// Total duration in seconds (may be null for distance-based sessions).
  final num? durationSec;

  /// Lower bound of target pace in seconds/km (null when not specified).
  final int? targetPaceLowSecPerKm;

  /// Upper bound of target pace in seconds/km (null when not specified).
  final int? targetPaceHighSecPerKm;

  /// Lower bound of target HR in bpm (null when not specified).
  final int? targetHrLow;

  /// Upper bound of target HR in bpm (null when not specified).
  final int? targetHrHigh;

  /// Warmup checklist items.  Null means "use the default list".
  final List<String>? warmupBlocks;

  /// Pre-training nutrition note text.  Null means "use the default text".
  final String? nutritionPre;

  // ── Helpers ───────────────────────────────────────────────────────────────

  /// Parse "5:00-5:30/km" or "300-330" → (low_sec, high_sec).
  /// Returns (null, null) on any parse failure.
  static (int?, int?) _parsePaceRange(String? raw) {
    if (raw == null || raw.isEmpty) return (null, null);
    // Strip trailing units like "/km"
    final cleaned = raw.replaceAll(RegExp(r'[/\s]?km.*', caseSensitive: false), '').trim();
    // Try "M:SS-M:SS" or plain seconds "300-330"
    final parts = cleaned.split('-');
    if (parts.length != 2) return (null, null);
    final low = _parseTimeToSec(parts[0].trim());
    final high = _parseTimeToSec(parts[1].trim());
    return (low, high);
  }

  /// Parse "M:SS" or plain integer seconds into an integer second value.
  static int? _parseTimeToSec(String s) {
    final colonIdx = s.indexOf(':');
    if (colonIdx > 0) {
      final m = int.tryParse(s.substring(0, colonIdx));
      final sec = int.tryParse(s.substring(colonIdx + 1));
      if (m != null && sec != null) return m * 60 + sec;
    }
    return int.tryParse(s);
  }

  /// Parse "130-150 bpm" or "130-150" → (130, 150).
  static (int?, int?) _parseHrRange(String? raw) {
    if (raw == null || raw.isEmpty) return (null, null);
    final cleaned = raw.replaceAll(RegExp(r'bpm', caseSensitive: false), '').trim();
    final parts = cleaned.split('-');
    if (parts.length != 2) return (null, null);
    final low = int.tryParse(parts[0].trim());
    final high = int.tryParse(parts[1].trim());
    return (low, high);
  }

  /// Fallback session name from kind when title is absent.
  static String _kindLabel(String kind) {
    return switch (kind.toUpperCase()) {
      'E' => '轻松跑',
      'M' => '马配跑',
      'T' => '节奏跑',
      'I' => '间歇跑',
      'R' => '冲刺跑',
      'REST' => '休息日',
      _ => '训练课',
    };
  }
}
