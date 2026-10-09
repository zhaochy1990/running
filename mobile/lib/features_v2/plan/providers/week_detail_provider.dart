/// weekDetailProvider — fetches full week data for D2 周计划预览.
///
/// Combines [StrideApi.getWeek] (markdown + metadata) with
/// [StrideApi.getWeeklyPlan] (structured sessions, plan/weeks/{weekName}).
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../../../data/models/plan.dart';
import '../../../data/models/weekly_plan.dart';

/// One calendar day's sessions within the week.
class WeekDaySessions {
  const WeekDaySessions({required this.date, this.sessions = const []});

  final String date; // YYYY-MM-DD
  final List<PlannedSession> sessions;
}

/// Combined week detail view-model for D2.
class WeekDetailData {
  const WeekDetailData({
    required this.folder,
    required this.dateFrom,
    required this.dateTo,
    this.planTitle,
    this.planContent,
    this.days = const [],
  });

  final String folder;
  final String dateFrom;
  final String dateTo;

  /// Short display title, e.g. "W2 渐进负荷"（从 plan markdown 提取）.
  final String? planTitle;

  /// Structured sessions/nutrition content (null when content_version==1).
  final WeeklyPlanContent? planContent;

  /// Ordered days Mon→Sun. May be empty.
  final List<WeekDaySessions> days;

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
        if (s.kind == 'strength') count++;
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

    final week = await api.getWeek(userId, folder);

    // Structured content keyed by weekName (`YYYY-MM-DD_MM-DD`). Missing plan
    // (404/no content) is not an error — the screen renders an empty week.
    final WeeklyPlanDetail? plan;
    try {
      plan = await api.getWeeklyPlan(userId, week.weekName);
    } catch (_) {
      plan = null;
    }

    // Days Mon→Sun from the week's own date range.
    final days = <WeekDaySessions>[];
    final from = DateTime.tryParse(week.dateFrom);
    final to = DateTime.tryParse(week.dateTo);
    if (from != null && to != null) {
      for (var d = from;
          !d.isAfter(to);
          d = d.add(const Duration(days: 1))) {
        final isoDate =
            '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
        days.add(WeekDaySessions(
          date: isoDate,
          sessions: plan?.content?.sessionsOn(isoDate) ?? const [],
        ));
      }
    }

    return WeekDetailData(
      folder: week.folder,
      dateFrom: week.dateFrom,
      dateTo: week.dateTo,
      planTitle: _extractPlanTitle(week.plan),
      planContent: plan?.content,
      days: days,
    );
  },
);

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
