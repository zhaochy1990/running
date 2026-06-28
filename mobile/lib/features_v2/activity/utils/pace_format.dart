/// Pace string parsing / formatting helpers.
///
/// Extracted from the activity detail screen so the parsing branches are
/// unit-testable (see `test/features_v2/activity/pace_format_test.dart`).
library;

/// Parse a `5'18"/km` or `5:18` style pace string into seconds-per-km.
///
/// Returns `null` when no `m:ss` / `m'ss"` pattern is present, so callers can
/// fall back to another source.
int? parsePaceFmt(String raw) {
  final match = RegExp(r'(\d+)[:′\x27](\d{1,2})').firstMatch(raw);
  if (match == null) return null;
  final m = int.tryParse(match.group(1)!);
  final s = int.tryParse(match.group(2)!);
  if (m == null || s == null) return null;
  return m * 60 + s;
}

/// Format seconds-per-km as `m'ss"` (e.g. 318 → `5'18"`).
String fmtPaceSeconds(int secPerKm) {
  final m = secPerKm ~/ 60;
  final s = secPerKm % 60;
  return "$m'${s.toString().padLeft(2, '0')}\"";
}
