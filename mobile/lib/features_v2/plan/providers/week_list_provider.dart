/// weekListProvider — fetches the week index and enriches each entry.
///
/// Calls [StrideApi.listWeeks] to get the lightweight index, then for weeks
/// that have a plan, fires a secondary [StrideApi.getWeeklyPlan] call to
/// obtain per-day session data for the mini-calendar and total-session count.
///
/// The secondary calls are fanned out in parallel (Future.wait) and failures
/// are silently swallowed — a week card without a mini-calendar is still
/// useful.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../models/week_list_item.dart';

final weekListProvider =
    FutureProvider.autoDispose<List<WeekListItem>>((ref) async {
  final api = ref.watch(strideApiProvider);
  final userId = ref.watch(currentUserIdProvider);
  if (userId == null) throw Exception('用户未登录');

  final entries = await api.listWeeks(userId);
  final today = DateTime.now();

  // Sort descending (most-recent first) — the backend may return any order.
  final sorted = [...entries]
    ..sort((a, b) => b.dateFrom.compareTo(a.dateFrom));

  // Determine "本周" label for the first in-progress entry.
  String? currentWeekFolder;
  for (final e in sorted) {
    final from = DateTime.tryParse(e.dateFrom);
    final to = DateTime.tryParse(e.dateTo);
    final todayDate = DateTime(today.year, today.month, today.day);
    if (from != null &&
        to != null &&
        !todayDate.isBefore(from) &&
        !todayDate.isAfter(to)) {
      currentWeekFolder = e.folder;
      break;
    }
  }

  // Build base items.
  final items = sorted.map((entry) {
    final isCurrent = entry.folder == currentWeekFolder;
    return WeekListItem.fromIndexEntry(
      entry,
      today: today,
      weekLabel: isCurrent ? '本周' : null,
    );
  }).toList(growable: false);

  // Enrich with mini-calendar for weeks that have a plan.
  // Fan out in parallel; failures silently fall back to no mini-calendar.
  final enriched = await Future.wait(
    items.map((item) async {
      if (!item.hasPlan) return item;
      try {
        final weekName =
            '${item.dateFrom}_${item.dateTo.substring(5)}';
        final plan = await api.getWeeklyPlan(userId, weekName);
        final sessions = plan.content?.sessions ?? const [];
        if (sessions.isEmpty) return item;

        // Build 7-element mini-calendar keyed by weekday (Mon=1 … Sun=7).
        final calMap = <int, String?>{};
        num totalDist = 0;
        num totalDur = 0;

        for (final s in sessions) {
          final date = DateTime.tryParse(s.date);
          if (date == null) continue;
          calMap[date.weekday] = s.kind;
          totalDist += s.totalDistanceM ?? 0;
          totalDur += s.totalDurationS ?? 0;
        }

        // Build ordered list Mon(1)…Sun(7).
        final miniCal = List<String?>.generate(7, (i) => calMap[i + 1]);

        return item.withMiniCalendar(
          miniCalendar: miniCal,
          totalSessions: sessions.length,
          weeklyDistanceM: totalDist > 0 ? totalDist : null,
          weeklyDurationS: totalDur > 0 ? totalDur : null,
        );
      } catch (_) {
        // Silently degrade — card still renders without mini-calendar.
        return item;
      }
    }),
  );

  return enriched;
});
