/// PbRecord — model for E6 personal best records screen.
///
/// Maps `GET /api/{user}/pbs` response.
library;

class PbHistoryPoint {
  const PbHistoryPoint({
    required this.date,
    required this.bestSoFarSec,
  });

  final String date;
  final int bestSoFarSec;

  factory PbHistoryPoint.fromJson(Map<String, dynamic> json) {
    return PbHistoryPoint(
      date: json['date'] as String? ?? '',
      bestSoFarSec: (json['best_so_far_sec'] as num?)?.toInt() ?? 0,
    );
  }
}

class PbRecord {
  const PbRecord({
    required this.distance,
    this.pbTimeSec,
    this.achievedAt,
    this.labelId,
    this.history,
  });

  /// Distance label: "5K", "10K", "HM", "FM".
  final String distance;

  /// PB time in seconds. Null means no record yet.
  final int? pbTimeSec;

  /// ISO date string when the PB was set.
  final String? achievedAt;

  /// Activity label_id for navigation to activity detail.
  final String? labelId;

  /// Best-so-far progression over time.
  final List<PbHistoryPoint>? history;

  factory PbRecord.fromJson(Map<String, dynamic> json) {
    final rawHistory = json['history'] as List?;
    final history = rawHistory
        ?.cast<Map<String, dynamic>>()
        .map(PbHistoryPoint.fromJson)
        .toList(growable: false);

    return PbRecord(
      distance: json['distance'] as String? ?? '',
      pbTimeSec: (json['pb_time_sec'] as num?)?.toInt(),
      achievedAt: json['achieved_at'] as String?,
      labelId: json['label_id'] as String?,
      history: history,
    );
  }
}

class PbsResponse {
  const PbsResponse({required this.pbs});

  final List<PbRecord> pbs;

  factory PbsResponse.fromJson(Map<String, dynamic> json) {
    final raw = (json['pbs'] as List? ?? const [])
        .cast<Map<String, dynamic>>();
    return PbsResponse(
      pbs: raw.map(PbRecord.fromJson).toList(growable: false),
    );
  }

  static const empty = PbsResponse(pbs: []);
}
