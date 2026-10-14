/// 训练状态页 wire 模型 —— 与 Go API 契约一致（stride-devops#465）。
///
///   GET /api/{user}/stride/training-load?days=N  负荷 current + series
///   GET /api/{user}/hrv?days=N                   逐日 HRV
///   GET /api/{user}/stride/zones                 阈值 + 配速/心率区间
///
/// 字段名与 Go DTO（src/go/internal/api/stride.go / health.go）snake_case 一致。
library;

import 'package:json_annotation/json_annotation.dart';

part 'training_status.g.dart';

/// /stride/training-load 的一天（daily_training_load 行 + readiness）。
@JsonSerializable()
class TrainingLoadRecord {
  const TrainingLoadRecord({
    required this.date,
    this.algorithmVersion,
    this.trainingDose,
    this.acuteLoad,
    this.chronicLoad,
    this.form,
    this.loadRatio,
    this.coverageStatus,
    this.readinessGate,
    this.readinessReasons = const [],
  });

  factory TrainingLoadRecord.fromJson(Map<String, dynamic> json) =>
      _$TrainingLoadRecordFromJson(json);

  /// 上海 YYYY-MM-DD。
  final String date;
  @JsonKey(name: 'algorithm_version')
  final int? algorithmVersion;
  @JsonKey(name: 'training_dose')
  final num? trainingDose;
  @JsonKey(name: 'acute_load')
  final num? acuteLoad;
  @JsonKey(name: 'chronic_load')
  final num? chronicLoad;
  final num? form;
  @JsonKey(name: 'load_ratio')
  final num? loadRatio;

  /// normal / assumed_rest / unknown —— unknown 日前端渲染为缺口。
  @JsonKey(name: 'coverage_status')
  final String? coverageStatus;
  @JsonKey(name: 'readiness_gate')
  final String? readinessGate;
  @JsonKey(name: 'readiness_reasons')
  final List<String> readinessReasons;

  bool get isUnknown => coverageStatus == 'unknown';

  Map<String, dynamic> toJson() => _$TrainingLoadRecordToJson(this);
}

@JsonSerializable()
class TrainingLoadResponse {
  const TrainingLoadResponse({this.current, this.series = const []});

  factory TrainingLoadResponse.fromJson(Map<String, dynamic> json) =>
      _$TrainingLoadResponseFromJson(json);

  final TrainingLoadRecord? current;
  final List<TrainingLoadRecord> series;

  Map<String, dynamic> toJson() => _$TrainingLoadResponseToJson(this);
}

/// /hrv 的一天（手表逐日 HRV 读数）。
@JsonSerializable()
class HrvDailyRecord {
  const HrvDailyRecord({
    required this.date,
    this.weeklyAvg,
    this.lastNightAvg,
    this.status,
    this.provider,
  });

  factory HrvDailyRecord.fromJson(Map<String, dynamic> json) =>
      _$HrvDailyRecordFromJson(json);

  final String date;
  @JsonKey(name: 'weekly_avg')
  final num? weeklyAvg;
  @JsonKey(name: 'last_night_avg')
  final num? lastNightAvg;
  final String? status;
  final String? provider;

  Map<String, dynamic> toJson() => _$HrvDailyRecordToJson(this);
}

@JsonSerializable()
class HrvSummary {
  const HrvSummary({this.date, this.lastNightAvg, this.weeklyAvg});

  factory HrvSummary.fromJson(Map<String, dynamic> json) =>
      _$HrvSummaryFromJson(json);

  final String? date;
  @JsonKey(name: 'last_night_avg')
  final num? lastNightAvg;
  @JsonKey(name: 'weekly_avg')
  final num? weeklyAvg;

  Map<String, dynamic> toJson() => _$HrvSummaryToJson(this);
}

@JsonSerializable()
class HrvResponse {
  const HrvResponse({this.hrv = const [], HrvSummary? summary})
      : summary = summary ?? const HrvSummary();

  factory HrvResponse.fromJson(Map<String, dynamic> json) =>
      _$HrvResponseFromJson(json);

  final List<HrvDailyRecord> hrv;
  final HrvSummary summary;

  Map<String, dynamic> toJson() => _$HrvResponseToJson(this);
}

/// STRIDE 自研阈值（running_calibration 最新快照）。
@JsonSerializable()
class StrideThreshold {
  const StrideThreshold({
    this.speedMps,
    this.pacePerKmSec,
    this.hrBpm,
    this.speedConfidence = '',
    this.hrConfidence = '',
    this.asOfDate = '',
  });

  factory StrideThreshold.fromJson(Map<String, dynamic> json) =>
      _$StrideThresholdFromJson(json);

  @JsonKey(name: 'speed_mps')
  final num? speedMps;

  /// 阈值配速（s/km），如 300 = 5:00/km。
  @JsonKey(name: 'pace_per_km_sec')
  final int? pacePerKmSec;
  @JsonKey(name: 'hr_bpm')
  final num? hrBpm;
  @JsonKey(name: 'speed_confidence')
  final String speedConfidence;
  @JsonKey(name: 'hr_confidence')
  final String hrConfidence;
  @JsonKey(name: 'as_of_date')
  final String asOfDate;

  Map<String, dynamic> toJson() => _$StrideThresholdToJson(this);
}

/// 配速区间；lower_pace 慢侧 / upper_pace 快侧（'M:SS'/km，开边界为 null）。
@JsonSerializable()
class StridePaceZone {
  const StridePaceZone({
    required this.name,
    required this.label,
    this.lowerPace,
    this.upperPace,
  });

  factory StridePaceZone.fromJson(Map<String, dynamic> json) =>
      _$StridePaceZoneFromJson(json);

  final String name;
  final String label;
  @JsonKey(name: 'lower_pace')
  final String? lowerPace;
  @JsonKey(name: 'upper_pace')
  final String? upperPace;

  Map<String, dynamic> toJson() => _$StridePaceZoneToJson(this);
}

@JsonSerializable()
class StrideHrZone {
  const StrideHrZone({
    required this.name,
    required this.label,
    this.lowerBpm,
    this.upperBpm,
  });

  factory StrideHrZone.fromJson(Map<String, dynamic> json) =>
      _$StrideHrZoneFromJson(json);

  final String name;
  final String label;
  @JsonKey(name: 'lower_bpm')
  final int? lowerBpm;
  @JsonKey(name: 'upper_bpm')
  final int? upperBpm;

  Map<String, dynamic> toJson() => _$StrideHrZoneToJson(this);
}

@JsonSerializable()
class StrideZonesResponse {
  const StrideZonesResponse({
    this.threshold,
    this.paceZones = const [],
    this.hrZones = const [],
  });

  factory StrideZonesResponse.fromJson(Map<String, dynamic> json) =>
      _$StrideZonesResponseFromJson(json);

  final StrideThreshold? threshold;
  @JsonKey(name: 'pace_zones')
  final List<StridePaceZone> paceZones;
  @JsonKey(name: 'hr_zones')
  final List<StrideHrZone> hrZones;

  bool get hasZones =>
      threshold != null && paceZones.isNotEmpty && hrZones.isNotEmpty;

  Map<String, dynamic> toJson() => _$StrideZonesResponseToJson(this);
}
