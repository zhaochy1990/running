/// Domain models for the weekly review (D9) screen.
///
/// Mirrors the backend schema at
/// `GET /api/{user}/weeks/{folder}/review` (T12).
library;

class WeekReview {

  factory WeekReview.fromJson(Map<String, dynamic> j) => WeekReview(
        folder: j['folder'] as String,
        dateFrom: j['date_from'] as String,
        dateTo: j['date_to'] as String,
        summary: WeekSummary.fromJson(j['summary'] as Map<String, dynamic>),
        tsbSeries: (j['tsb_series'] as List<dynamic>? ?? [])
            .cast<Map<String, dynamic>>()
            .map(TsbPoint.fromJson)
            .toList(growable: false),
        sessions: (j['sessions'] as List<dynamic>? ?? [])
            .cast<Map<String, dynamic>>()
            .map(SessionReview.fromJson)
            .toList(growable: false),
        activityHighlights:
            (j['activity_highlights'] as List<dynamic>? ?? [])
                .cast<Map<String, dynamic>>()
                .map(ActivityHighlight.fromJson)
                .toList(growable: false),
        insights: (j['insights'] as List<dynamic>? ?? [])
            .cast<Map<String, dynamic>>()
            .map(Insight.fromJson)
            .toList(growable: false),
        nextWeekPreview: j['next_week_preview'] == null
            ? null
            : NextWeekPreview.fromJson(
                j['next_week_preview'] as Map<String, dynamic>),
      );
  const WeekReview({
    required this.folder,
    required this.dateFrom,
    required this.dateTo,
    required this.summary,
    required this.tsbSeries,
    required this.sessions,
    required this.activityHighlights,
    required this.insights,
    this.nextWeekPreview,
  });

  final String folder;
  final String dateFrom;
  final String dateTo;
  final WeekSummary summary;
  final List<TsbPoint> tsbSeries;
  final List<SessionReview> sessions;
  final List<ActivityHighlight> activityHighlights;
  final List<Insight> insights;
  final NextWeekPreview? nextWeekPreview;
}

class WeekSummary {

  factory WeekSummary.fromJson(Map<String, dynamic> j) => WeekSummary(
        totalDistanceKm: (j['total_distance_km'] as num?)?.toDouble() ?? 0,
        totalDurationSec: (j['total_duration_sec'] as num?)?.toInt() ?? 0,
        totalSessionsPlanned: (j['total_sessions_planned'] as num?)?.toInt() ?? 0,
        totalSessionsCompleted:
            (j['total_sessions_completed'] as num?)?.toInt() ?? 0,
        completionRate: (j['completion_rate'] as num?)?.toDouble(),
        strengthSessionsCompleted:
            (j['strength_sessions_completed'] as num?)?.toInt() ?? 0,
        avgRpe: (j['avg_rpe'] as num?)?.toDouble(),
      );
  const WeekSummary({
    required this.totalDistanceKm,
    required this.totalDurationSec,
    required this.totalSessionsPlanned,
    required this.totalSessionsCompleted,
    this.completionRate,
    required this.strengthSessionsCompleted,
    this.avgRpe,
  });

  final double totalDistanceKm;
  final int totalDurationSec;
  final int totalSessionsPlanned;
  final int totalSessionsCompleted;
  final double? completionRate;
  final int strengthSessionsCompleted;
  final double? avgRpe;
}

class TsbPoint {

  factory TsbPoint.fromJson(Map<String, dynamic> j) => TsbPoint(
        date: j['date'] as String,
        tsb: (j['tsb'] as num?)?.toDouble() ?? 0,
        ati: (j['ati'] as num?)?.toDouble() ?? 0,
        cti: (j['cti'] as num?)?.toDouble() ?? 0,
      );
  const TsbPoint({
    required this.date,
    required this.tsb,
    required this.ati,
    required this.cti,
  });

  final String date;
  final double tsb;
  final double ati;
  final double cti;
}

class SessionReview {

  factory SessionReview.fromJson(Map<String, dynamic> j) => SessionReview(
        date: j['date'] as String,
        sessionIndex: (j['session_index'] as num?)?.toInt() ?? 0,
        plannedSummary: j['planned_summary'] as String? ?? '',
        plannedKind: j['planned_kind'] as String? ?? 'run',
        plannedDistanceM: (j['planned_distance_m'] as num?)?.toDouble(),
        completed: j['completed'] as bool? ?? false,
        actualLabelId: j['actual_label_id'] as String?,
        actualDistanceM: (j['actual_distance_m'] as num?)?.toDouble(),
        actualDurationSec: (j['actual_duration_sec'] as num?)?.toInt(),
        actualAvgHr: (j['actual_avg_hr'] as num?)?.toInt(),
        rpe: (j['rpe'] as num?)?.toInt(),
        moodTags: (j['mood_tags'] as List<dynamic>?)?.cast<String>(),
        adherencePct: (j['adherence_pct'] as num?)?.toInt(),
      );
  const SessionReview({
    required this.date,
    required this.sessionIndex,
    required this.plannedSummary,
    required this.plannedKind,
    this.plannedDistanceM,
    required this.completed,
    this.actualLabelId,
    this.actualDistanceM,
    this.actualDurationSec,
    this.actualAvgHr,
    this.rpe,
    this.moodTags,
    this.adherencePct,
  });

  final String date;
  final int sessionIndex;
  final String plannedSummary;
  final String plannedKind;
  final double? plannedDistanceM;
  final bool completed;
  final String? actualLabelId;
  final double? actualDistanceM;
  final int? actualDurationSec;
  final int? actualAvgHr;
  final int? rpe;
  final List<String>? moodTags;
  final int? adherencePct;
}

class ActivityHighlight {

  factory ActivityHighlight.fromJson(Map<String, dynamic> j) =>
      ActivityHighlight(
        labelId: j['label_id'] as String,
        date: j['date'] as String,
        name: j['name'] as String? ?? '',
        commentaryExcerpt: j['commentary_excerpt'] as String? ?? '',
      );
  const ActivityHighlight({
    required this.labelId,
    required this.date,
    required this.name,
    required this.commentaryExcerpt,
  });

  final String labelId;
  final String date;
  final String name;
  final String commentaryExcerpt;
}

/// Insight level — mirrors the backend "positive" | "warning" | "neutral".
enum InsightLevel { positive, warning, neutral }

class Insight {

  factory Insight.fromJson(Map<String, dynamic> j) => Insight(
        type: j['type'] as String? ?? '',
        level: _levelFromString(j['level'] as String? ?? 'neutral'),
        text: j['text'] as String? ?? '',
      );
  const Insight({
    required this.type,
    required this.level,
    required this.text,
  });

  final String type;
  final InsightLevel level;
  final String text;

  static InsightLevel _levelFromString(String s) {
    switch (s) {
      case 'positive':
        return InsightLevel.positive;
      case 'warning':
        return InsightLevel.warning;
      default:
        return InsightLevel.neutral;
    }
  }
}

class NextWeekPreview {

  factory NextWeekPreview.fromJson(Map<String, dynamic> j) => NextWeekPreview(
        folder: j['folder'] as String,
        planTitle: j['plan_title'] as String?,
        totalPlannedDistanceKm:
            (j['total_planned_distance_km'] as num?)?.toDouble() ?? 0,
        sessionsCount: (j['sessions_count'] as num?)?.toInt() ?? 0,
        keySessionSummary: j['key_session_summary'] as String?,
      );
  const NextWeekPreview({
    required this.folder,
    this.planTitle,
    required this.totalPlannedDistanceKm,
    required this.sessionsCount,
    this.keySessionSummary,
  });

  final String folder;
  final String? planTitle;
  final double totalPlannedDistanceKm;
  final int sessionsCount;
  final String? keySessionSummary;
}
