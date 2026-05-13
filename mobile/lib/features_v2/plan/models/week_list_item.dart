/// WeekListItem — view-model for a single row in D2a 周列表.
///
/// Derived from [WeekIndexEntry] (lightweight index) plus an optional
/// [WeekDetail] / [PlanDaysResponse] for richer fields (mini-calendar,
/// completion rate). The fields that the backend doesn't yet return are
/// kept nullable with clear fallback behavior documented below.
library;

import '../../../data/models/plan.dart';

/// Status of a training week.
enum WeekStatus {
  /// The week is currently ongoing.
  inProgress,

  /// The week has ended (date_to < today).
  completed,

  /// The week starts in the future (date_from > today).
  upcoming,
}

/// Resolved view-model for a week card in D2a.
class WeekListItem {

  // ── Factory ──────────────────────────────────────────────────────────────

  /// Build from a [WeekIndexEntry] with current date for status inference.
  factory WeekListItem.fromIndexEntry(
    WeekIndexEntry entry, {
    required DateTime today,
    String? weekLabel,
  }) {
    final from = DateTime.tryParse(entry.dateFrom);
    final to = DateTime.tryParse(entry.dateTo);
    final todayDate = DateTime(today.year, today.month, today.day);

    WeekStatus status;
    if (from != null && to != null) {
      if (todayDate.isBefore(from)) {
        status = WeekStatus.upcoming;
      } else if (todayDate.isAfter(to)) {
        status = WeekStatus.completed;
      } else {
        status = WeekStatus.inProgress;
      }
    } else {
      status = WeekStatus.upcoming;
    }

    return WeekListItem(
      folder: entry.folder,
      dateFrom: entry.dateFrom,
      dateTo: entry.dateTo,
      status: status,
      hasPlan: entry.hasPlan,
      planTitle: entry.planTitle,
      weekLabel: weekLabel,
    );
  }
  const WeekListItem({
    required this.folder,
    required this.dateFrom,
    required this.dateTo,
    required this.status,
    required this.hasPlan,
    this.planTitle,
    this.weekLabel,
    this.completedSessions,
    this.totalSessions,
    this.weeklyDistanceM,
    this.weeklyDurationS,
    this.miniCalendar,
  });

  /// Backend folder key, e.g. "2026-05-11_05-17(W1基础)".
  final String folder;

  /// ISO date string for Monday.
  final String dateFrom;

  /// ISO date string for Sunday.
  final String dateTo;

  /// Week status derived from current date.
  final WeekStatus status;

  /// Whether a plan.md exists for this week.
  final bool hasPlan;

  /// Display title extracted from the plan, e.g. "W2 渐进负荷".
  final String? planTitle;

  /// Short label for the card header, e.g. "本周" / "W2 渐进" / date range.
  final String? weekLabel;

  /// Number of sessions completed (null = not yet calculated).
  final int? completedSessions;

  /// Total planned sessions (null = not available from index endpoint).
  final int? totalSessions;

  /// Total weekly distance in metres (sum of sessions, null if unavailable).
  final num? weeklyDistanceM;

  /// Total weekly duration in seconds (null if unavailable).
  final num? weeklyDurationS;

  /// 7-element list of session kinds for the mini calendar.
  /// Index 0 = Monday, index 6 = Sunday.
  /// Each element is a kind string: "E"/"M"/"T"/"I"/"R"/"strength"/"rest"/null.
  /// null means no plan for that day.
  ///
  /// MISMATCH NOTE: The [WeekIndexEntry] endpoint does NOT return per-day
  /// session data. This field requires a follow-up [getWeek] + [getPlanDays]
  /// call or a future backend extension. For M2 batch 3, this is populated
  /// via a secondary [getPlanDays] call in the provider; if that fails or the
  /// user has no plan, it falls back to null (mini-calendar hidden).
  final List<String?>? miniCalendar;

  /// Return a copy with enriched fields from a plan days fetch.
  WeekListItem withMiniCalendar({
    required List<String?> miniCalendar,
    int? totalSessions,
    num? weeklyDistanceM,
    num? weeklyDurationS,
  }) {
    return WeekListItem(
      folder: folder,
      dateFrom: dateFrom,
      dateTo: dateTo,
      status: status,
      hasPlan: hasPlan,
      planTitle: planTitle,
      weekLabel: weekLabel,
      completedSessions: completedSessions,
      totalSessions: totalSessions ?? this.totalSessions,
      weeklyDistanceM: weeklyDistanceM ?? this.weeklyDistanceM,
      weeklyDurationS: weeklyDurationS ?? this.weeklyDurationS,
      miniCalendar: miniCalendar,
    );
  }
}
