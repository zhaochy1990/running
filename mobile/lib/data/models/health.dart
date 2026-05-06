import 'package:json_annotation/json_annotation.dart';

part 'health.g.dart';

@JsonSerializable()
class HealthRecord {
  const HealthRecord({
    required this.date,
    this.ati,
    this.cti,
    this.rhr,
    this.distanceM,
    this.durationS,
    this.trainingLoadRatio,
    this.trainingLoadState,
    this.fatigue,
    this.bodyBatteryHigh,
    this.bodyBatteryLow,
    this.stressAvg,
    this.sleepTotalS,
    this.sleepDeepS,
    this.sleepLightS,
    this.sleepRemS,
    this.sleepAwakeS,
    this.sleepScore,
    this.respirationAvg,
    this.spo2Avg,
    this.provider,
  });

  factory HealthRecord.fromJson(Map<String, dynamic> json) =>
      _$HealthRecordFromJson(json);

  final String date;
  final num? ati;
  final num? cti;
  final int? rhr;
  @JsonKey(name: 'distance_m')
  final num? distanceM;
  @JsonKey(name: 'duration_s')
  final num? durationS;
  @JsonKey(name: 'training_load_ratio')
  final num? trainingLoadRatio;
  @JsonKey(name: 'training_load_state')
  final String? trainingLoadState;
  final num? fatigue;
  @JsonKey(name: 'body_battery_high')
  final int? bodyBatteryHigh;
  @JsonKey(name: 'body_battery_low')
  final int? bodyBatteryLow;
  @JsonKey(name: 'stress_avg')
  final num? stressAvg;
  @JsonKey(name: 'sleep_total_s')
  final num? sleepTotalS;
  @JsonKey(name: 'sleep_deep_s')
  final num? sleepDeepS;
  @JsonKey(name: 'sleep_light_s')
  final num? sleepLightS;
  @JsonKey(name: 'sleep_rem_s')
  final num? sleepRemS;
  @JsonKey(name: 'sleep_awake_s')
  final num? sleepAwakeS;
  @JsonKey(name: 'sleep_score')
  final num? sleepScore;
  @JsonKey(name: 'respiration_avg')
  final num? respirationAvg;
  @JsonKey(name: 'spo2_avg')
  final num? spo2Avg;
  final String? provider;

  Map<String, dynamic> toJson() => _$HealthRecordToJson(this);
}

@JsonSerializable()
class HrvSnapshot {
  const HrvSnapshot({
    this.avgSleepHrv,
    this.hrvNormalLow,
    this.hrvNormalHigh,
    this.recoveryPct,
  });

  factory HrvSnapshot.fromJson(Map<String, dynamic> json) =>
      _$HrvSnapshotFromJson(json);

  @JsonKey(name: 'avg_sleep_hrv')
  final num? avgSleepHrv;
  @JsonKey(name: 'hrv_normal_low')
  final num? hrvNormalLow;
  @JsonKey(name: 'hrv_normal_high')
  final num? hrvNormalHigh;
  @JsonKey(name: 'recovery_pct')
  final num? recoveryPct;

  Map<String, dynamic> toJson() => _$HrvSnapshotToJson(this);
}

@JsonSerializable()
class HealthResponse {
  const HealthResponse({
    required this.health,
    required this.hrv,
    this.rhrBaseline,
  });

  factory HealthResponse.fromJson(Map<String, dynamic> json) =>
      _$HealthResponseFromJson(json);

  final List<HealthRecord> health;
  final HrvSnapshot hrv;
  @JsonKey(name: 'rhr_baseline')
  final num? rhrBaseline;

  Map<String, dynamic> toJson() => _$HealthResponseToJson(this);
}

@JsonSerializable()
class PMCRecord {
  const PMCRecord({
    required this.date,
    required this.tsb,
    required this.tsbZone,
    required this.tsbZoneLabel,
    this.ati,
    this.cti,
    this.rhr,
    this.fatigue,
    this.trainingLoadRatio,
    this.trainingLoadState,
    this.ctlRamp,
  });

  factory PMCRecord.fromJson(Map<String, dynamic> json) =>
      _$PMCRecordFromJson(json);

  final String date;
  final num? ati;
  final num? cti;
  final int? rhr;
  final num? fatigue;
  @JsonKey(name: 'training_load_ratio')
  final num? trainingLoadRatio;
  @JsonKey(name: 'training_load_state')
  final String? trainingLoadState;
  final num tsb;
  @JsonKey(name: 'tsb_zone')
  final String tsbZone;
  @JsonKey(name: 'tsb_zone_label')
  final String tsbZoneLabel;
  @JsonKey(name: 'ctl_ramp')
  final num? ctlRamp;

  Map<String, dynamic> toJson() => _$PMCRecordToJson(this);
}

@JsonSerializable()
class PMCSummary {
  const PMCSummary({
    this.currentCti,
    this.currentAti,
    this.currentTsb,
    this.currentTsbZone,
    this.currentTsbZoneLabel,
    this.currentFatigue,
    this.currentRhr,
    this.ctlRamp,
    this.date,
  });

  factory PMCSummary.fromJson(Map<String, dynamic> json) =>
      _$PMCSummaryFromJson(json);

  @JsonKey(name: 'current_cti')
  final num? currentCti;
  @JsonKey(name: 'current_ati')
  final num? currentAti;
  @JsonKey(name: 'current_tsb')
  final num? currentTsb;
  @JsonKey(name: 'current_tsb_zone')
  final String? currentTsbZone;
  @JsonKey(name: 'current_tsb_zone_label')
  final String? currentTsbZoneLabel;
  @JsonKey(name: 'current_fatigue')
  final num? currentFatigue;
  @JsonKey(name: 'current_rhr')
  final int? currentRhr;
  @JsonKey(name: 'ctl_ramp')
  final num? ctlRamp;
  final String? date;

  Map<String, dynamic> toJson() => _$PMCSummaryToJson(this);
}

@JsonSerializable()
class PMCResponse {
  const PMCResponse({required this.pmc, required this.summary});

  factory PMCResponse.fromJson(Map<String, dynamic> json) =>
      _$PMCResponseFromJson(json);

  final List<PMCRecord> pmc;
  final PMCSummary summary;

  Map<String, dynamic> toJson() => _$PMCResponseToJson(this);
}

@JsonSerializable()
class AbilityCurrent {
  const AbilityCurrent({
    required this.date,
    required this.source,
    this.l4Composite,
    this.l4MarathonEstimateS,
    this.distanceToTargetS,
    this.marathonTargetS,
    this.marathonTargetLabel,
  });

  factory AbilityCurrent.fromJson(Map<String, dynamic> json) =>
      _$AbilityCurrentFromJson(json);

  final String date;
  final String source;
  @JsonKey(name: 'l4_composite')
  final num? l4Composite;
  @JsonKey(name: 'l4_marathon_estimate_s')
  final num? l4MarathonEstimateS;
  @JsonKey(name: 'distance_to_target_s')
  final num? distanceToTargetS;
  @JsonKey(name: 'marathon_target_s')
  final num? marathonTargetS;
  @JsonKey(name: 'marathon_target_label')
  final String? marathonTargetLabel;

  Map<String, dynamic> toJson() => _$AbilityCurrentToJson(this);
}
