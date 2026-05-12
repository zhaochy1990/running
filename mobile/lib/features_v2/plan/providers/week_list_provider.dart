/// weekListProvider — fetches the week index and enriches each entry.
///
/// Calls [StrideApi.listWeeks] to get the lightweight index, then for weeks
/// that have a plan, fires a secondary [StrideApi.getPlanDays] call to obtain
/// per-day session data for the mini-calendar and total-session count.
///
/// The secondary calls are fanned out in parallel (Future.wait) and failures
/// are silently swallowed — a week card without a mini-calendar is still
/// useful. This matches the M2 batch-3 spec: "先用占位（M2 后续 T27 后端可扩展）".
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
        final resp = await api.getPlanDays(userId, item.dateFrom, item.dateTo);
        if (resp.days.isEmpty) return item;

        // Build 7-element mini-calendar keyed by weekday (Mon=1 … Sun=7).
        final calMap = <int, String?>{};
        num totalDist = 0;
        num totalDur = 0;
        int totalSessions = 0;

        for (final day in resp.days) {
          final date = DateTime.tryParse(day.date);
          if (date == null) continue;
          // weekday: 1=Mon…7=Sun
          final weekday = date.weekday;
          if (day.sessions.isEmpty) {
            calMap[weekday] = 'rest';
          } else {
            // Use the first (primary) session kind for the color block.
            calMap[weekday] = day.sessions.first.kind;
            totalSessions += day.sessions.length;
            for (final s in day.sessions) {
              totalDist += s.totalDistanceM ?? 0;
              totalDur += s.totalDurationS ?? 0;
            }
          }
        }

        // Build ordered list Mon(1)…Sun(7).
        final miniCal = List<String?>.generate(7, (i) => calMap[i + 1]);

        return item.withMiniCalendar(
          miniCalendar: miniCal,
          totalSessions: totalSessions,
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
