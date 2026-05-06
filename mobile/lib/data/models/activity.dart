import 'package:json_annotation/json_annotation.dart';

part 'activity.g.dart';

/// Mirrors `stride_core` Activity row + Activity dataclass in
/// `frontend/src/api.ts:243`. Field names match the JSON 1:1.
@JsonSerializable()
class Activity {
  const Activity({
    required this.labelId,
    required this.sportType,
    required this.sportName,
    required this.date,
    required this.distanceM,
    required this.distanceKm,
    required this.durationS,
    required this.durationFmt,
    required this.paceFmt,
    this.name,
    this.avgPaceSKm,
    this.avgHr,
    this.maxHr,
    this.avgCadence,
    this.caloriesKcal,
    this.trainingLoad,
    this.vo2max,
    this.trainType,
    this.ascentM,
    this.aerobicEffect,
    this.anaerobicEffect,
    this.temperature,
    this.humidity,
    this.feelsLike,
    this.windSpeed,
    this.feelType,
    this.sportNote,
    this.commentary,
    this.commentaryGeneratedBy,
    this.commentaryGeneratedAt,
  });

  factory Activity.fromJson(Map<String, dynamic> json) =>
      _$ActivityFromJson(json);

  @JsonKey(name: 'label_id')
  final String labelId;
  final String? name;
  @JsonKey(name: 'sport_type')
  final int sportType;
  @JsonKey(name: 'sport_name')
  final String sportName;
  final String date;
  @JsonKey(name: 'distance_m')
  final num distanceM;
  @JsonKey(name: 'distance_km')
  final num distanceKm;
  @JsonKey(name: 'duration_s')
  final int durationS;
  @JsonKey(name: 'duration_fmt')
  final String durationFmt;
  @JsonKey(name: 'avg_pace_s_km')
  final num? avgPaceSKm;
  @JsonKey(name: 'pace_fmt')
  final String paceFmt;
  @JsonKey(name: 'avg_hr')
  final int? avgHr;
  @JsonKey(name: 'max_hr')
  final int? maxHr;
  @JsonKey(name: 'avg_cadence')
  final int? avgCadence;
  @JsonKey(name: 'calories_kcal')
  final num? caloriesKcal;
  @JsonKey(name: 'training_load')
  final num? trainingLoad;
  final num? vo2max;
  @JsonKey(name: 'train_type')
  final String? trainType;
  @JsonKey(name: 'ascent_m')
  final num? ascentM;
  @JsonKey(name: 'aerobic_effect')
  final num? aerobicEffect;
  @JsonKey(name: 'anaerobic_effect')
  final num? anaerobicEffect;
  final num? temperature;
  final num? humidity;
  @JsonKey(name: 'feels_like')
  final num? feelsLike;
  @JsonKey(name: 'wind_speed')
  final num? windSpeed;
  @JsonKey(name: 'feel_type')
  final int? feelType;
  @JsonKey(name: 'sport_note')
  final String? sportNote;
  final String? commentary;
  @JsonKey(name: 'commentary_generated_by')
  final String? commentaryGeneratedBy;
  @JsonKey(name: 'commentary_generated_at')
  final String? commentaryGeneratedAt;

  Map<String, dynamic> toJson() => _$ActivityToJson(this);
}

@JsonSerializable()
class Lap {
  const Lap({
    required this.lapIndex,
    required this.lapType,
    required this.distanceM,
    required this.distanceKm,
    required this.durationS,
    required this.durationFmt,
    required this.paceFmt,
    this.avgPace,
    this.adjustedPace,
    this.avgHr,
    this.maxHr,
    this.avgCadence,
    this.avgPower,
    this.ascentM,
    this.descentM,
  });

  factory Lap.fromJson(Map<String, dynamic> json) => _$LapFromJson(json);

  @JsonKey(name: 'lap_index')
  final int lapIndex;
  @JsonKey(name: 'lap_type')
  final String lapType;
  @JsonKey(name: 'distance_m')
  final num distanceM;
  @JsonKey(name: 'distance_km')
  final num distanceKm;
  @JsonKey(name: 'duration_s')
  final num durationS;
  @JsonKey(name: 'duration_fmt')
  final String durationFmt;
  @JsonKey(name: 'avg_pace')
  final num? avgPace;
  @JsonKey(name: 'pace_fmt')
  final String paceFmt;
  @JsonKey(name: 'adjusted_pace')
  final num? adjustedPace;
  @JsonKey(name: 'avg_hr')
  final int? avgHr;
  @JsonKey(name: 'max_hr')
  final int? maxHr;
  @JsonKey(name: 'avg_cadence')
  final int? avgCadence;
  @JsonKey(name: 'avg_power')
  final num? avgPower;
  @JsonKey(name: 'ascent_m')
  final num? ascentM;
  @JsonKey(name: 'descent_m')
  final num? descentM;

  Map<String, dynamic> toJson() => _$LapToJson(this);
}

@JsonSerializable()
class Zone {
  const Zone({
    required this.zoneType,
    required this.zoneIndex,
    required this.rangeUnit,
    required this.durationS,
    required this.percent,
    this.rangeMin,
    this.rangeMax,
  });

  factory Zone.fromJson(Map<String, dynamic> json) => _$ZoneFromJson(json);

  @JsonKey(name: 'zone_type')
  final String zoneType;
  @JsonKey(name: 'zone_index')
  final int zoneIndex;
  @JsonKey(name: 'range_min')
  final num? rangeMin;
  @JsonKey(name: 'range_max')
  final num? rangeMax;
  @JsonKey(name: 'range_unit')
  final String rangeUnit;
  @JsonKey(name: 'duration_s')
  final num durationS;
  final num percent;

  Map<String, dynamic> toJson() => _$ZoneToJson(this);
}

@JsonSerializable()
class TimeseriesPoint {
  const TimeseriesPoint({
    this.timestamp,
    this.distance,
    this.heartRate,
    this.speed,
    this.adjustedPace,
    this.cadence,
    this.altitude,
    this.power,
  });

  factory TimeseriesPoint.fromJson(Map<String, dynamic> json) =>
      _$TimeseriesPointFromJson(json);

  final num? timestamp;
  final num? distance;
  @JsonKey(name: 'heart_rate')
  final num? heartRate;
  final num? speed;
  @JsonKey(name: 'adjusted_pace')
  final num? adjustedPace;
  final num? cadence;
  final num? altitude;
  final num? power;

  Map<String, dynamic> toJson() => _$TimeseriesPointToJson(this);
}

@JsonSerializable()
class Segment {
  const Segment({
    required this.segName,
    required this.lapIndex,
    required this.lapType,
    required this.distanceM,
    required this.distanceKm,
    required this.durationS,
    required this.durationFmt,
    required this.paceFmt,
    this.mode,
    this.avgPace,
    this.adjustedPace,
    this.avgHr,
    this.maxHr,
    this.avgCadence,
    this.avgPower,
    this.ascentM,
    this.descentM,
  });

  factory Segment.fromJson(Map<String, dynamic> json) =>
      _$SegmentFromJson(json);

  @JsonKey(name: 'seg_name')
  final String segName;
  final int? mode;
  @JsonKey(name: 'lap_index')
  final int lapIndex;
  @JsonKey(name: 'lap_type')
  final String lapType;
  @JsonKey(name: 'distance_m')
  final num distanceM;
  @JsonKey(name: 'distance_km')
  final num distanceKm;
  @JsonKey(name: 'duration_s')
  final num durationS;
  @JsonKey(name: 'duration_fmt')
  final String durationFmt;
  @JsonKey(name: 'avg_pace')
  final num? avgPace;
  @JsonKey(name: 'pace_fmt')
  final String paceFmt;
  @JsonKey(name: 'adjusted_pace')
  final num? adjustedPace;
  @JsonKey(name: 'avg_hr')
  final int? avgHr;
  @JsonKey(name: 'max_hr')
  final int? maxHr;
  @JsonKey(name: 'avg_cadence')
  final int? avgCadence;
  @JsonKey(name: 'avg_power')
  final num? avgPower;
  @JsonKey(name: 'ascent_m')
  final num? ascentM;
  @JsonKey(name: 'descent_m')
  final num? descentM;

  Map<String, dynamic> toJson() => _$SegmentToJson(this);
}

@JsonSerializable()
class ActivityDetailResponse {
  const ActivityDetailResponse({
    required this.activity,
    required this.laps,
    required this.segments,
    required this.zones,
    required this.timeseries,
  });

  factory ActivityDetailResponse.fromJson(Map<String, dynamic> json) =>
      _$ActivityDetailResponseFromJson(json);

  final Activity activity;
  final List<Lap> laps;
  final List<Segment> segments;
  final List<Zone> zones;
  final List<TimeseriesPoint> timeseries;

  Map<String, dynamic> toJson() => _$ActivityDetailResponseToJson(this);
}
