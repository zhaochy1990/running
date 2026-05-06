// Format helpers — mirrors `frontend/src/api.ts` parseDate / formatDate / pace_str.

DateTime? parseApiDate(String dateStr) {
  if (dateStr.isEmpty) return null;
  // ISO format with timezone
  if (dateStr.contains('T')) {
    return DateTime.tryParse(dateStr);
  }
  // YYYYMMDD
  if (dateStr.length == 8) {
    final y = int.tryParse(dateStr.substring(0, 4));
    final m = int.tryParse(dateStr.substring(4, 6));
    final d = int.tryParse(dateStr.substring(6, 8));
    if (y == null || m == null || d == null) return null;
    return DateTime(y, m, d);
  }
  // YYYY-MM-DD
  return DateTime.tryParse(dateStr);
}

String formatDate(String dateStr) {
  final d = parseApiDate(dateStr);
  if (d == null) return dateStr;
  return '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
}

String formatDateShort(String dateStr) {
  final d = parseApiDate(dateStr);
  if (d == null) return dateStr;
  return '${d.month}月${d.day}日';
}

const _weekdayCN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

String weekdayCN(String dateStr) {
  final d = parseApiDate(dateStr);
  if (d == null) return '';
  return _weekdayCN[d.weekday % 7];
}

/// Pace seconds-per-km → "M:SS/km"
String paceFmt(num secondsPerKm) {
  final s = secondsPerKm.round();
  final m = s ~/ 60;
  final r = s % 60;
  return '$m:${r.toString().padLeft(2, '0')}/km';
}

/// Duration seconds → "H:MM:SS" or "M:SS"
String durationFmt(int seconds) {
  if (seconds < 0) return '0:00';
  final h = seconds ~/ 3600;
  final m = (seconds % 3600) ~/ 60;
  final s = seconds % 60;
  if (h > 0) {
    return '$h:${m.toString().padLeft(2, '0')}:${s.toString().padLeft(2, '0')}';
  }
  return '$m:${s.toString().padLeft(2, '0')}';
}
