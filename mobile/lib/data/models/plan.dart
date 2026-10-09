/// Plan-domain wire models for the alive `weeks` endpoints.
/// Structured weekly-plan content lives in [weekly_plan.dart].
library;

/// Lightweight week index entry — covers what /api/{user}/weeks returns.
/// Hand-mapped so backend field drift doesn't break the parse.
class WeekIndexEntry {
  const WeekIndexEntry({
    required this.folder,
    required this.dateFrom,
    required this.dateTo,
    this.hasPlan = false,
    this.planTitle,
  });

  factory WeekIndexEntry.fromJson(Map<String, dynamic> json) {
    return WeekIndexEntry(
      folder: json['folder'] as String,
      dateFrom: json['date_from'] as String,
      dateTo: json['date_to'] as String,
      hasPlan: json['has_plan'] as bool? ?? false,
      planTitle: json['plan_title'] as String?,
    );
  }

  final String folder;
  final String dateFrom;
  final String dateTo;
  final bool hasPlan;
  final String? planTitle;
}

/// Full week — plan markdown + feedback. We only surface the markdown body;
/// structured sessions come from [WeeklyPlanDetail] (plan/weeks/{weekName}).
class WeekDetail {
  const WeekDetail({
    required this.folder,
    required this.dateFrom,
    required this.dateTo,
    this.plan,
    this.feedback,
  });

  factory WeekDetail.fromJson(Map<String, dynamic> json) {
    return WeekDetail(
      folder: json['folder'] as String,
      dateFrom: json['date_from'] as String,
      dateTo: json['date_to'] as String,
      plan: json['plan'] as String?,
      feedback: json['feedback'] as String?,
    );
  }

  final String folder;
  final String dateFrom;
  final String dateTo;
  final String? plan;
  final String? feedback;

  /// Week folder name（plan/weeks/{weekName} 用）: `YYYY-MM-DD_MM-DD`。
  String get weekName => '${dateFrom}_${dateTo.substring(5)}';
}
