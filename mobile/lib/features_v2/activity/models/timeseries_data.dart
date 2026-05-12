/// TimeseriesData — mirrors `GET /api/{user}/activities/{id}/timeseries`
/// response schema.
///
/// Per `.omc/plans/stride-mobile-m1.md` §3.1.2.
library;

class TimeseriesSeries {
  const TimeseriesSeries({
    this.hr,
    this.pace,
    this.altitude,
    this.cadence,
  });

  final List<num?>? hr;
  final List<num?>? pace;
  final List<num?>? altitude;
  final List<num?>? cadence;

  factory TimeseriesSeries.fromJson(Map<String, dynamic> json) {
    List<num?>? _parseList(dynamic raw) {
      if (raw == null) return null;
      return (raw as List).map((e) => e as num?).toList(growable: false);
    }

    return TimeseriesSeries(
      hr: _parseList(json['hr']),
      pace: _parseList(json['pace']),
      altitude: _parseList(json['altitude']),
      cadence: _parseList(json['cadence']),
    );
  }
}

class TimeseriesData {
  const TimeseriesData({
    required this.labelId,
    required this.durationSec,
    required this.pointCount,
    required this.intervalSec,
    required this.series,
  });

  final String labelId;
  final int durationSec;
  final int pointCount;
  final double intervalSec;
  final TimeseriesSeries series;

  factory TimeseriesData.fromJson(Map<String, dynamic> json) {
    return TimeseriesData(
      labelId: (json['label_id'] as String?) ?? '',
      durationSec: (json['duration_sec'] as num?)?.toInt() ?? 0,
      pointCount: (json['point_count'] as num?)?.toInt() ?? 0,
      intervalSec: (json['interval_sec'] as num?)?.toDouble() ?? 1.0,
      series: TimeseriesSeries.fromJson(
        (json['series'] as Map<String, dynamic>?) ?? {},
      ),
    );
  }
}
