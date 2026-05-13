/// RacePrediction — model for E5 race predictions screen.
///
/// Maps `GET /api/{user}/race-predictions` response.
library;

class DistancePrediction {

  factory DistancePrediction.fromJson(Map<String, dynamic> json) {
    return DistancePrediction(
      predictedTimeSec:
          (json['predicted_time_sec'] as num?)?.toInt() ?? 0,
      predictedPaceSecPerKm:
          (json['predicted_pace_sec_per_km'] as num?)?.toInt() ?? 0,
    );
  }
  const DistancePrediction({
    required this.predictedTimeSec,
    required this.predictedPaceSecPerKm,
  });

  final int predictedTimeSec;
  final int predictedPaceSecPerKm;
}

class TargetGap {

  factory TargetGap.fromJson(Map<String, dynamic> json) {
    return TargetGap(
      distance: json['distance'] as String? ?? '',
      targetTimeSec: (json['target_time_sec'] as num?)?.toInt() ?? 0,
      currentTimeSec: (json['current_time_sec'] as num?)?.toInt() ?? 0,
      gapSec: (json['gap_sec'] as num?)?.toInt() ?? 0,
    );
  }
  const TargetGap({
    required this.distance,
    required this.targetTimeSec,
    required this.currentTimeSec,
    required this.gapSec,
  });

  final String distance;
  final int targetTimeSec;
  final int currentTimeSec;
  final int gapSec;
}

class RacePrediction {

  factory RacePrediction.fromJson(Map<String, dynamic> json) {
    final rawDistances =
        json['distances'] as Map<String, dynamic>? ?? {};
    final distances = rawDistances.map(
      (k, v) => MapEntry(
        k,
        DistancePrediction.fromJson(v as Map<String, dynamic>),
      ),
    );

    TargetGap? targetGap;
    final rawGap = json['target_gap'];
    if (rawGap != null) {
      targetGap = TargetGap.fromJson(rawGap as Map<String, dynamic>);
    }

    return RacePrediction(
      distances: distances,
      vo2max: (json['vo2max'] as num?)?.toDouble(),
      vo2maxTrend: json['vo2max_trend'] as String?,
      targetGap: targetGap,
    );
  }
  const RacePrediction({
    required this.distances,
    this.vo2max,
    this.vo2maxTrend,
    this.targetGap,
  });

  /// Predictions keyed by distance label: "5K", "10K", "HM", "FM".
  final Map<String, DistancePrediction> distances;
  final double? vo2max;

  /// "up" | "down" | "flat" | null
  final String? vo2maxTrend;
  final TargetGap? targetGap;

  static const empty = RacePrediction(distances: {});
}

/// A single historical prediction data point for trend charts.
class PredictionHistoryPoint {

  factory PredictionHistoryPoint.fromJson(Map<String, dynamic> json) {
    return PredictionHistoryPoint(
      date: json['date'] as String? ?? '',
      predictedTimeSec:
          (json['predicted_time_sec'] as num?)?.toInt() ?? 0,
    );
  }
  const PredictionHistoryPoint({
    required this.date,
    required this.predictedTimeSec,
  });

  final String date;
  final int predictedTimeSec;
}
