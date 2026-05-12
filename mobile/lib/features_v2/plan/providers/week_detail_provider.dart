/// weekDetailProvider — fetches full week data for D2 周计划预览.
///
/// Combines [StrideApi.getWeek] (plan markdown + metadata) with
/// [StrideApi.getPlanDays] (structured sessions for the 7-day schedule).
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../../../data/models/plan.dart';

/// Combined week detail view-model for D2.
class WeekDetailData {
  const WeekDetailData({
    required this.folder,
    required this.dateFrom,
    required this.dateTo,
    this.planTitle,
    this.plan,
    this.feedback,
    this.days = const [],
  });

  final String folder;
  final String dateFrom;
  final String dateTo;

  /// Short display title, e.g. "W2 渐进负荷".
  final String? planTitle;

  /// Raw plan markdown (may be null when no plan generated yet).
  final String? plan;

  /// Raw feedback markdown.
  final String? feedback;

  /// Ordered list of plan days (Mon→Sun). May be empty.
  final List<PlanDay> days;

  // ── Computed helpers ──────────────────────────────────────────────────────

  /// Total planned distance in metres across all sessions.
  num get totalDistanceM {
    num total = 0;
    for (final day in days) {
      for (final s in day.sessions) {
        total += s.totalDistanceM ?? 0;
      }
    }
    return total;
  }

  /// Total planned duration in seconds across all sessions.
  num get totalDurationS {
    num total = 0;
    for (final day in days) {
      for (final s in day.sessions) {
        total += s.totalDurationS ?? 0;
      }
    }
    return total;
  }

  /// Number of strength sessions (kind == 'strength').
  int get strengthCount {
    int count = 0;
    for (final day in days) {
      for (final s in day.sessions) {
        if (s.kind.toLowerCase() == 'strength') count++;
      }
    }
    return count;
  }
}

final weekDetailProvider =
    FutureProvider.autoDispose.family<WeekDetailData, String>(
  (ref, folder) async {
    final api = ref.watch(strideApiProvider);
    final userId = ref.watch(currentUserIdProvider);
    if (userId == null) throw Exception('用户未登录');

    // Fire both requests in parallel.
    final results = await Future.wait([
      api.getWeek(userId, folder),
      api.getPlanDays(userId, _folderDateFrom(folder), _folderDateTo(folder))
          .catchError((_) => const PlanDaysResponse(days: [])),
    ]);

    final weekDetail = results[0] as WeekDetail;
    final planDays = results[1] as PlanDaysResponse;

    // Sort days Mon→Sun.
    final sortedDays = [...planDays.days]
      ..sort((a, b) => a.date.compareTo(b.date));

    return WeekDetailData(
      folder: weekDetail.folder,
      dateFrom: weekDetail.dateFrom,
      dateTo: weekDetail.dateTo,
      planTitle: _extractPlanTitle(weekDetail.plan),
      plan: weekDetail.plan,
      feedback: weekDetail.feedback,
      days: sortedDays,
    );
  },
);

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Extract YYYY-MM-DD date_from from folder string.
/// Folder format: "2026-05-11_05-17(W1基础)" or "2026-05-11_2026-05-17".
/// Falls back to parsing the folder prefix.
String _folderDateFrom(String folder) {
  // Try extracting the first date segment (10 chars YYYY-MM-DD).
  if (folder.length >= 10) {
    final candidate = folder.substring(0, 10);
    if (RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(candidate)) {
      return candidate;
    }
  }
  return folder;
}

/// Extract YYYY-MM-DD date_to from folder string.
/// Folder format: "2026-05-11_05-17(W1基础)".
String _folderDateTo(String folder) {
  // Common format: YYYY-MM-DD_MM-DD(...) — year inferred from dateFrom.
  final parts = folder.split('_');
  if (parts.length >= 2) {
    // parts[0] = "2026-05-11", parts[1] = "05-17(W1基础)" or "2026-05-17"
    final year = parts[0].substring(0, 4);
    var datePart = parts[1];
    // Strip trailing parenthetical annotation.
    final parenIdx = datePart.indexOf('(');
    if (parenIdx >= 0) datePart = datePart.substring(0, parenIdx);
    // If it looks like MM-DD, prepend year.
    if (RegExp(r'^\d{2}-\d{2}$').hasMatch(datePart)) {
      return '$year-$datePart';
    }
    // If it's already YYYY-MM-DD, use directly.
    if (RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(datePart)) {
      return datePart;
    }
  }
  // Last resort: dateFrom + 6 days.
  final from = DateTime.tryParse(_folderDateFrom(folder));
  if (from != null) {
    final to = from.add(const Duration(days: 6));
    return '${to.year}-${to.month.toString().padLeft(2, '0')}-${to.day.toString().padLeft(2, '0')}';
  }
  return folder;
}

/// Best-effort extraction of a short plan title from the plan markdown.
/// Looks for the first H2 heading or returns null.
String? _extractPlanTitle(String? markdown) {
  if (markdown == null || markdown.isEmpty) return null;
  for (final line in markdown.split('\n')) {
    final trimmed = line.trim();
    if (trimmed.startsWith('## ')) {
      return trimmed.substring(3).trim();
    }
  }
  return null;
}
