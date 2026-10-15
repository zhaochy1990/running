/// 训练状态页 wire 模型 —— 与 Go API 三个数据面端点一一对应
/// （契约同小程序 `types/health.ts`，stride-devops#465）：
///
///   GET /api/{user}/stride/training-load?days=N
///   GET /api/{user}/hrv?days=N
///   GET /api/{user}/stride/zones
library;

import 'package:json_annotation/json_annotation.dart';

part 'training_status.g.dart';

// ── /stride/training-load ────────────────────────────────────────────────────

/// One daily PMC row. dose/acute/chronic/form 由 Go 端保证非 null
/// （missing tail 已在服务端投影为 zero-dose assumed rest）。
@JsonSerializable()
class StrideTrainingLoadRecord {
  const StrideTrainingLoadRecord({
    required this.date,
    required this.algorithmVersion,
    required this.trainingDose,
    required this.acuteLoad,
    required this.chronicLoad,
    required this.form,
    this.loadRatio,
    required this.coverageStatus,
    this.readinessGate,
    this.readinessReasons = const [],
  });

  factory StrideTrainingLoadRecord.fromJson(Map<String, dynamic> json) =>
      _$StrideTrainingLoadRecordFromJson(json);

  /// 上海 YYYY-MM-DD。
  final String date;
  @JsonKey(name: 'algorithm_version')
  final int algorithmVersion;
  @JsonKey(name: 'training_dose')
  final double trainingDose;
  @JsonKey(name: 'acute_load')
  final double acuteLoad;
  @JsonKey(name: 'chronic_load')
  final double chronicLoad;
  final double form;
  @JsonKey(name: 'load_ratio')
  final double? loadRatio;
  final String coverageStatus;

  /// green / yellow / red；unknown 覆盖日期为 null。
  @JsonKey(name: 'readiness_gate')
  final String? readinessGate;
  @JsonKey(name: 'readiness_reasons')
  final List<String> readinessReasons;

  Map<String, dynamic> toJson() => _$StrideTrainingLoadRecordToJson(this);

  /// 该日数据未确认（coverage unknown）→ 图表按缺口处理。
  bool get isUnknown => coverageStatus == 'unknown';
}

@JsonSerializable()
class StrideTrainingLoadResponse {
  const StrideTrainingLoadResponse({this.current, required this.series});

  factory StrideTrainingLoadResponse.fromJson(Map<String, dynamic> json) =>
      _$StrideTrainingLoadResponseFromJson(json);

  final StrideTrainingLoadRecord? current;

  /// oldest → newest。
  final List<StrideTrainingLoadRecord> series;

  Map<String, dynamic> toJson() => _$StrideTrainingLoadResponseToJson(this);
}

// ── /hrv ─────────────────────────────────────────────────────────────────────

/// One daily HRV row（页面只消费 date + last_night_avg，其余字段不解析）。
@JsonSerializable()
class HrvDailyRecord {
  const HrvDailyRecord({required this.date, this.lastNightAvg});

  factory HrvDailyRecord.fromJson(Map<String, dynamic> json) =>
      _$HrvDailyRecordFromJson(json);

  final String date;
  @JsonKey(name: 'last_night_avg')
  final int? lastNightAvg;

  Map<String, dynamic> toJson() => _$HrvDailyRecordToJson(this);
}

@JsonSerializable()
class HrvDailyResponse {
  const HrvDailyResponse({required this.hrv});

  factory HrvDailyResponse.fromJson(Map<String, dynamic> json) =>
      _$HrvDailyResponseFromJson(json);

  /// oldest → newest。
  final List<HrvDailyRecord> hrv;

  Map<String, dynamic> toJson() => _$HrvDailyResponseToJson(this);
}

// ── /stride/zones ────────────────────────────────────────────────────────────

@JsonSerializable()
class StrideThreshold {
  const StrideThreshold({
    this.speedMps,
    this.pacePerKmSec,
    this.hrBpm,
    this.speedConfidence,
    this.hrConfidence,
    required this.asOfDate,
    required this.calibrationId,
  });

  factory StrideThreshold.fromJson(Map<String, dynamic> json) =>
      _$StrideThresholdFromJson(json);

  @JsonKey(name: 'speed_mps')
  final double? speedMps;

  /// 阈值配速（s/km），如 300 → 5:00/km。
  @JsonKey(name: 'pace_per_km_sec')
  final int? pacePerKmSec;
  @JsonKey(name: 'hr_bpm')
  final double? hrBpm;
  @JsonKey(name: 'speed_confidence')
  final String? speedConfidence;
  @JsonKey(name: 'hr_confidence')
  final String? hrConfidence;
  @JsonKey(name: 'as_of_date')
  final String asOfDate;
  @JsonKey(name: 'calibration_id')
  final int calibrationId;

  Map<String, dynamic> toJson() => _$StrideThresholdToJson(this);
}

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

  /// 慢侧边界（'M:SS' /km）；开放边界为 null。
  @JsonKey(name: 'lower_pace')
  final String? lowerPace;

  /// 快侧边界（'M:SS' /km）。
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
  @JsonKey(name: 'pace_zones', defaultValue: [])
  final List<StridePaceZone> paceZones;
  @JsonKey(name: 'hr_zones', defaultValue: [])
  final List<StrideHrZone> hrZones;

  Map<String, dynamic> toJson() => _$StrideZonesResponseToJson(this);

  bool get hasZones =>
      threshold != null && paceZones.isNotEmpty && hrZones.isNotEmpty;
}
