import 'package:json_annotation/json_annotation.dart';

import 'activity.dart';

part 'plan.g.dart';

@JsonSerializable()
class PlannedSession {
  const PlannedSession({
    required this.id,
    required this.date,
    required this.sessionIndex,
    required this.kind,
    required this.pushable,
    this.title,
    this.totalDistanceM,
    this.totalDurationS,
    this.targetPace,
    this.targetHrZone,
    this.notes,
    this.providerWorkoutId,
    this.scheduledWorkoutId,
  });

  factory PlannedSession.fromJson(Map<String, dynamic> json) =>
      _$PlannedSessionFromJson(json);

  final int id;
  final String date;
  @JsonKey(name: 'session_index')
  final int sessionIndex;
  final String kind;
  final String? title;
  @JsonKey(name: 'total_distance_m')
  final num? totalDistanceM;
  @JsonKey(name: 'total_duration_s')
  final num? totalDurationS;
  @JsonKey(name: 'target_pace')
  final String? targetPace;
  @JsonKey(name: 'target_hr_zone')
  final String? targetHrZone;
  final String? notes;
  final bool pushable;
  @JsonKey(name: 'provider_workout_id')
  final String? providerWorkoutId;
  @JsonKey(name: 'scheduled_workout_id')
  final int? scheduledWorkoutId;

  Map<String, dynamic> toJson() => _$PlannedSessionToJson(this);
}

@JsonSerializable()
class PlannedNutrition {
  const PlannedNutrition({
    required this.date,
    this.kcalTarget,
    this.proteinG,
    this.carbsG,
    this.fatG,
    this.notes,
  });

  factory PlannedNutrition.fromJson(Map<String, dynamic> json) =>
      _$PlannedNutritionFromJson(json);

  final String date;
  @JsonKey(name: 'kcal_target')
  final num? kcalTarget;
  @JsonKey(name: 'protein_g')
  final num? proteinG;
  @JsonKey(name: 'carbs_g')
  final num? carbsG;
  @JsonKey(name: 'fat_g')
  final num? fatG;
  final String? notes;

  Map<String, dynamic> toJson() => _$PlannedNutritionToJson(this);
}

@JsonSerializable()
class PlannedVsActual {
  const PlannedVsActual({required this.planned, this.actual});

  factory PlannedVsActual.fromJson(Map<String, dynamic> json) =>
      _$PlannedVsActualFromJson(json);

  final PlannedSession planned;
  final Activity? actual;

  Map<String, dynamic> toJson() => _$PlannedVsActualToJson(this);
}

@JsonSerializable()
class PlanTodayResponse {
  const PlanTodayResponse({
    required this.date,
    required this.sessions,
    required this.plannedVsActual,
    this.nutrition,
  });

  factory PlanTodayResponse.fromJson(Map<String, dynamic> json) =>
      _$PlanTodayResponseFromJson(json);

  final String date;
  final List<PlannedSession> sessions;
  final PlannedNutrition? nutrition;
  @JsonKey(name: 'planned_vs_actual')
  final List<PlannedVsActual> plannedVsActual;

  Map<String, dynamic> toJson() => _$PlanTodayResponseToJson(this);
}

@JsonSerializable()
class PlanDay {
  const PlanDay({required this.date, required this.sessions, this.nutrition});

  factory PlanDay.fromJson(Map<String, dynamic> json) =>
      _$PlanDayFromJson(json);

  final String date;
  final List<PlannedSession> sessions;
  final PlannedNutrition? nutrition;

  Map<String, dynamic> toJson() => _$PlanDayToJson(this);
}

@JsonSerializable()
class PlanDaysResponse {
  const PlanDaysResponse({required this.days});

  factory PlanDaysResponse.fromJson(Map<String, dynamic> json) =>
      _$PlanDaysResponseFromJson(json);

  final List<PlanDay> days;

  Map<String, dynamic> toJson() => _$PlanDaysResponseToJson(this);
}
