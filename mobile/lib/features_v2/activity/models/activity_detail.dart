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
      avgCadence: (json['avg_cadence'] as num?)?.toInt(),
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
    this.avgCadence,
  });

  final int lapIndex;
  final double distanceKm;
  final num durationS;
  final String durationFmt;
  final String paceFmt;
  final int? avgHr;
  final int? maxHr;
  final int? avgCadence;
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

  ZoneV2 copyWith({int? zoneIndex, num? rangeMin, num? rangeMax}) {
    return ZoneV2(
      zoneType: zoneType,
      zoneIndex: zoneIndex ?? this.zoneIndex,
      durationS: durationS,
      percent: percent,
      rangeMin: rangeMin ?? this.rangeMin,
      rangeMax: rangeMax ?? this.rangeMax,
    );
  }
}

/// Zone helpers — port of `frontend/src/components/ZoneChart.tsx`.
abstract final class ZoneUtils {
  /// HR zones, sorted by [ZoneV2.zoneIndex] ascending.
  static List<ZoneV2> hrZones(List<ZoneV2> zones) {
    final filtered =
        zones.where((z) => z.zoneType == 'heartRate').toList(growable: false);
    return _sorted(filtered);
  }

  /// Pace zones, normalized 7→6, sorted ascending.
  static List<ZoneV2> paceZones(List<ZoneV2> zones) {
    final filtered =
        zones.where((z) => z.zoneType == 'pace').toList(growable: false);
    return _sorted(normalizePaceZones(filtered));
  }

  static List<ZoneV2> _sorted(List<ZoneV2> zones) {
    final copy = [...zones]..sort((a, b) => a.zoneIndex.compareTo(b.zoneIndex));
    return copy;
  }

  /// COROS pace API returns 7 zones (extra split at 100% of threshold pace),
  /// but the app displays 6. Merge API Z4 (94-100%) and Z5 (100-102%) into one
  /// "乳酸阈区" (94-102%), then relabel Z6→Z5 and Z7→Z6. If fewer than 7, pass
  /// through unchanged.
  static List<ZoneV2> normalizePaceZones(List<ZoneV2> zones) {
    if (zones.length < 7) return zones;
    final byIdx = {for (final z in zones) z.zoneIndex: z};
    final z4 = byIdx[4];
    final z5 = byIdx[5];
    final z6 = byIdx[6];
    final z7 = byIdx[7];
    final z1 = byIdx[1];
    final z2 = byIdx[2];
    final z3 = byIdx[3];
    if (z1 == null ||
        z2 == null ||
        z3 == null ||
        z4 == null ||
        z5 == null ||
        z6 == null ||
        z7 == null) {
      return zones;
    }
    final merged = ZoneV2(
      zoneType: 'pace',
      zoneIndex: 4,
      durationS: z4.durationS + z5.durationS,
      percent: z4.percent + z5.percent,
      rangeMin: z5.rangeMin, // faster end (smaller ms/km)
      rangeMax: z4.rangeMax, // slower end
    );
    return [
      z1,
      z2,
      z3,
      merged,
      z6.copyWith(zoneIndex: 5),
      z7.copyWith(zoneIndex: 6),
    ];
  }
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
      avgCadence: (json['avg_cadence'] as num?)?.toInt(),
      avgStepLenCm: json['avg_step_len_cm'] as num?,
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
    this.avgCadence,
    this.avgStepLenCm,
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
  final int? avgCadence;
  final num? avgStepLenCm;
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
      trainingDose:
          (json['stride_training_load'] as Map<String, dynamic>?)?['training_dose']
              as num?,
    );
  }
  const ActivityDetailV2({
    required this.activity,
    required this.laps,
    required this.zones,
    this.trainingDose,
  });

  final ActivityV2 activity;
  final List<LapV2> laps;
  final List<ZoneV2> zones;
  final num? trainingDose;
}
