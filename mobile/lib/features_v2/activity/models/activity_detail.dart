/// ActivityDetailV2 — trimmed model for the v2 activity detail screen.
///
/// Wraps the `GET /api/{user}/activities/{id}` response (without timeseries
/// by default). Field names match the JSON returned by the backend.
library;

class LapV2 {

  factory LapV2.fromJson(Map<String, dynamic> json) {
    return LapV2(
      lapIndex: (json['lap_index'] as num?)?.toInt() ?? 0,
      distanceKm: (json['distance_km'] as num?)?.toDouble() ?? 0.0,
      durationS: (json['duration_s'] as num?) ?? 0,
      durationFmt: (json['duration_fmt'] as String?) ?? '',
      paceFmt: (json['pace_fmt'] as String?) ?? '',
      avgHr: (json['avg_hr'] as num?)?.toInt(),
      maxHr: (json['max_hr'] as num?)?.toInt(),
    );
  }
  const LapV2({
    required this.lapIndex,
    required this.distanceKm,
    required this.durationS,
    required this.durationFmt,
    required this.paceFmt,
    this.avgHr,
    this.maxHr,
  });

  final int lapIndex;
  final double distanceKm;
  final num durationS;
  final String durationFmt;
  final String paceFmt;
  final int? avgHr;
  final int? maxHr;
}

class ZoneV2 {

  factory ZoneV2.fromJson(Map<String, dynamic> json) {
    return ZoneV2(
      zoneType: (json['zone_type'] as String?) ?? '',
      zoneIndex: (json['zone_index'] as num?)?.toInt() ?? 0,
      durationS: (json['duration_s'] as num?) ?? 0,
      percent: (json['percent'] as num?) ?? 0,
      rangeMin: json['range_min'] as num?,
      rangeMax: json['range_max'] as num?,
    );
  }
  const ZoneV2({
    required this.zoneType,
    required this.zoneIndex,
    required this.durationS,
    required this.percent,
    this.rangeMin,
    this.rangeMax,
  });

  final String zoneType;
  final int zoneIndex;
  final num durationS;
  final num percent;
  final num? rangeMin;
  final num? rangeMax;
}

class ActivityV2 {

  factory ActivityV2.fromJson(Map<String, dynamic> json) {
    return ActivityV2(
      labelId: (json['label_id'] as String?) ?? '',
      name: json['name'] as String?,
      sportName: (json['sport_name'] as String?) ?? '',
      date: (json['date'] as String?) ?? '',
      distanceKm: (json['distance_km'] as num?)?.toDouble() ?? 0.0,
      durationFmt: (json['duration_fmt'] as String?) ?? '',
      paceFmt: (json['pace_fmt'] as String?) ?? '',
      avgHr: (json['avg_hr'] as num?)?.toInt(),
      maxHr: (json['max_hr'] as num?)?.toInt(),
      caloriesKcal: json['calories_kcal'] as num?,
      ascentM: json['ascent_m'] as num?,
      avgPaceSKm: json['avg_pace_s_km'] as num?,
      sportNote: json['sport_note'] as String?,
      commentary: json['commentary'] as String?,
      commentaryGeneratedBy: json['commentary_generated_by'] as String?,
    );
  }
  const ActivityV2({
    required this.labelId,
    required this.sportName,
    required this.date,
    required this.distanceKm,
    required this.durationFmt,
    required this.paceFmt,
    this.name,
    this.avgHr,
    this.maxHr,
    this.caloriesKcal,
    this.ascentM,
    this.avgPaceSKm,
    this.sportNote,
    this.commentary,
    this.commentaryGeneratedBy,
  });

  final String labelId;
  final String? name;
  final String sportName;
  final String date;
  final double distanceKm;
  final String durationFmt;
  final String paceFmt;
  final int? avgHr;
  final int? maxHr;
  final num? caloriesKcal;
  final num? ascentM;
  final num? avgPaceSKm;
  final String? sportNote;
  final String? commentary;
  final String? commentaryGeneratedBy;
}

class ActivityDetailV2 {

  factory ActivityDetailV2.fromJson(Map<String, dynamic> json) {
    return ActivityDetailV2(
      activity: ActivityV2.fromJson(
        (json['activity'] as Map<String, dynamic>?) ?? {},
      ),
      laps: ((json['laps'] as List?) ?? [])
          .cast<Map<String, dynamic>>()
          .map(LapV2.fromJson)
          .toList(growable: false),
      zones: ((json['zones'] as List?) ?? [])
          .cast<Map<String, dynamic>>()
          .map(ZoneV2.fromJson)
          .toList(growable: false),
    );
  }
  const ActivityDetailV2({
    required this.activity,
    required this.laps,
    required this.zones,
  });

  final ActivityV2 activity;
  final List<LapV2> laps;
  final List<ZoneV2> zones;
}
