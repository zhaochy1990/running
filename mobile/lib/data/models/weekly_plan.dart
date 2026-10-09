/// Structured weekly plan wire types — mirrors `GET /api/{user}/plan/weeks/{weekName}`
/// (Go weekly_plan.go `weeklyPlanDetailResponse`), same contract the miniprogram
/// consumes (`types/plan.ts`). Hand-mapped (no codegen) so nullable fields don't
/// explode when the backend drifts.
library;

/// content_version == 2 时 content 为结构化对象；== 1 时为 markdown 字符串。
class WeeklyPlanDetail {
  const WeeklyPlanDetail({
    required this.planId,
    required this.weekName,
    required this.dateFrom,
    required this.dateTo,
    this.status,
    this.content,
  });

  factory WeeklyPlanDetail.fromJson(Map<String, dynamic> json) {
    final rawContent = json['content'];
    return WeeklyPlanDetail(
      planId: json['plan_id'] as String? ?? '',
      weekName: json['week_name'] as String? ?? '',
      dateFrom: json['date_from'] as String? ?? '',
      dateTo: json['date_to'] as String? ?? '',
      status: json['status'] as String?,
      content: rawContent is Map<String, dynamic>
          ? WeeklyPlanContent.fromJson(rawContent)
          : null,
    );
  }

  final String planId;
  final String weekName;
  final String dateFrom;
  final String dateTo;
  final String? status;

  /// 结构化课表内容；content_version==1（纯 markdown）或缺失时为 null。
  final WeeklyPlanContent? content;
}

class WeeklyPlanContent {
  const WeeklyPlanContent({
    this.sessions = const [],
    this.nutrition = const [],
    this.notesMd,
    this.coachNotes,
  });

  factory WeeklyPlanContent.fromJson(Map<String, dynamic> json) {
    return WeeklyPlanContent(
      sessions: (json['sessions'] as List? ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(PlannedSession.fromJson)
          .toList(growable: false),
      nutrition: (json['nutrition'] as List? ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(PlannedNutrition.fromJson)
          .toList(growable: false),
      notesMd: json['notes_md'] as String?,
      coachNotes: json['coach_notes'] as String?,
    );
  }

  final List<PlannedSession> sessions;
  final List<PlannedNutrition> nutrition;
  final String? notesMd;
  final String? coachNotes;

  /// 指定日期的全部课节（按 session_index 升序）。
  List<PlannedSession> sessionsOn(String date) {
    final day = sessions.where((s) => s.date == date).toList()
      ..sort((a, b) => a.sessionIndex.compareTo(b.sessionIndex));
    return day;
  }

  /// 指定日期的营养安排。
  PlannedNutrition? nutritionOn(String date) {
    for (final n in nutrition) {
      if (n.date == date) return n;
    }
    return null;
  }
}

/// spec.schema 两种取值：run-workout/v1 与 strength-workout/v1。
sealed class WorkoutSpec {
  const WorkoutSpec({required this.name, this.note});

  factory WorkoutSpec.fromJson(Map<String, dynamic> json) {
    final schema = json['schema'] as String? ?? '';
    return switch (schema) {
      'run-workout/v1' => RunWorkoutSpec.fromJson(json),
      'strength-workout/v1' => StrengthWorkoutSpec.fromJson(json),
      _ => _UnknownWorkoutSpec.fromJson(json),
    };
  }

  final String name;
  final String? note;
}

class RunWorkoutSpec extends WorkoutSpec {
  const RunWorkoutSpec({required super.name, super.note, required this.blocks});

  factory RunWorkoutSpec.fromJson(Map<String, dynamic> json) {
    return RunWorkoutSpec(
      name: json['name'] as String? ?? '',
      note: json['note'] as String?,
      blocks: (json['blocks'] as List? ?? const [])
          .whereType<Map<String, dynamic>>()
          .map((b) => WorkoutBlock.fromJson(b))
          .toList(growable: false),
    );
  }

  final List<WorkoutBlock> blocks;
}

class StrengthWorkoutSpec extends WorkoutSpec {
  const StrengthWorkoutSpec({
    required super.name,
    super.note,
    required this.exercises,
  });

  factory StrengthWorkoutSpec.fromJson(Map<String, dynamic> json) {
    return StrengthWorkoutSpec(
      name: json['name'] as String? ?? '',
      note: json['note'] as String?,
      exercises: (json['exercises'] as List? ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(StrengthExercise.fromJson)
          .toList(growable: false),
    );
  }

  final List<StrengthExercise> exercises;
}

class _UnknownWorkoutSpec extends WorkoutSpec {
  _UnknownWorkoutSpec.fromJson(Map<String, dynamic> json)
    : super(name: json['name'] as String? ?? '');
}

class WorkoutBlock {
  const WorkoutBlock({required this.steps, this.repeat = 1});

  factory WorkoutBlock.fromJson(Map<String, dynamic> json) {
    return WorkoutBlock(
      steps: (json['steps'] as List? ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(WorkoutStep.fromJson)
          .toList(growable: false),
      repeat: json['repeat'] as int? ?? 1,
    );
  }

  final List<WorkoutStep> steps;
  final int repeat;
}

class WorkoutStep {
  const WorkoutStep({
    required this.stepKind,
    required this.target,
    this.hrCapBpm,
  });

  factory WorkoutStep.fromJson(Map<String, dynamic> json) {
    return WorkoutStep(
      stepKind: json['step_kind'] as String? ?? 'work',
      target: WorkoutTarget.fromJson(
        json['target'] as Map<String, dynamic>? ?? const {},
      ),
      hrCapBpm: json['hr_cap_bpm'] as num?,
    );
  }

  /// warmup / work / recovery / cooldown / rest
  final String stepKind;
  final WorkoutTarget target;
  final num? hrCapBpm;
}

class WorkoutTarget {
  const WorkoutTarget({required this.kind, this.low, this.high});

  factory WorkoutTarget.fromJson(Map<String, dynamic> json) {
    return WorkoutTarget(
      kind: json['kind'] as String? ?? 'open',
      low: json['low'] as num?,
      high: json['high'] as num?,
    );
  }

  /// pace_s_km / hr_bpm / power_w / open
  final String kind;
  final num? low;
  final num? high;
}

class StrengthExercise {
  const StrengthExercise({
    required this.displayName,
    required this.sets,
    required this.targetKind,
    required this.targetValue,
    this.restSeconds,
  });

  factory StrengthExercise.fromJson(Map<String, dynamic> json) {
    return StrengthExercise(
      displayName: json['display_name'] as String? ?? '动作',
      sets: json['sets'] as int? ?? 1,
      targetKind: json['target_kind'] as String? ?? 'reps',
      targetValue: json['target_value'] as num? ?? 0,
      restSeconds: json['rest_seconds'] as int?,
    );
  }

  final String displayName;
  final int sets;
  /// reps | time_s
  final String targetKind;
  final num targetValue;
  final int? restSeconds;
}

/// 单日营养安排（课表内嵌，与营养偏好 M5 域无关）。
class PlannedNutrition {
  const PlannedNutrition({
    required this.date,
    this.kcalTarget,
    this.carbsG,
    this.proteinG,
    this.fatG,
    this.waterMl,
    this.meals = const [],
    this.notesMd,
  });

  factory PlannedNutrition.fromJson(Map<String, dynamic> json) {
    return PlannedNutrition(
      date: json['date'] as String? ?? '',
      kcalTarget: json['kcal_target'] as num?,
      carbsG: json['carbs_g'] as num?,
      proteinG: json['protein_g'] as num?,
      fatG: json['fat_g'] as num?,
      waterMl: json['water_ml'] as num?,
      meals: (json['meals'] as List? ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(PlannedMeal.fromJson)
          .toList(growable: false),
      notesMd: json['notes_md'] as String?,
    );
  }

  final String date;
  final num? kcalTarget;
  final num? carbsG;
  final num? proteinG;
  final num? fatG;
  final num? waterMl;
  final List<PlannedMeal> meals;
  final String? notesMd;
}

class PlannedMeal {
  const PlannedMeal({
    required this.name,
    this.timeHint,
    this.kcal,
    this.itemsMd,
  });

  factory PlannedMeal.fromJson(Map<String, dynamic> json) {
    return PlannedMeal(
      name: json['name'] as String? ?? '餐次',
      timeHint: json['time_hint'] as String?,
      kcal: json['kcal'] as num?,
      itemsMd: json['items_md'] as String?,
    );
  }

  final String name;
  final String? timeHint;
  final num? kcal;
  final String? itemsMd;
}

/// 课节（content.sessions[] 元素）。
class PlannedSession {
  const PlannedSession({
    required this.date,
    required this.sessionIndex,
    required this.kind,
    required this.summary,
    this.spec,
    this.notesMd,
    this.totalDistanceM,
    this.totalDurationS,
    this.scheduledWorkoutId,
  });

  factory PlannedSession.fromJson(Map<String, dynamic> json) {
    final rawSpec = json['spec'];
    return PlannedSession(
      date: json['date'] as String? ?? '',
      sessionIndex: json['session_index'] as int? ?? 0,
      kind: json['kind'] as String? ?? 'note',
      summary: json['summary'] as String? ?? '',
      spec: rawSpec is Map<String, dynamic>
          ? WorkoutSpec.fromJson(rawSpec)
          : null,
      notesMd: json['notes_md'] as String?,
      totalDistanceM: json['total_distance_m'] as num?,
      totalDurationS: json['total_duration_s'] as num?,
      scheduledWorkoutId: json['scheduled_workout_id'] as int?,
    );
  }

  /// 上海本地 YYYY-MM-DD
  final String date;
  final int sessionIndex;
  /// run / strength / rest / cross / note
  final String kind;
  final String summary;
  final WorkoutSpec? spec;
  final String? notesMd;
  final num? totalDistanceM;
  final num? totalDurationS;
  final int? scheduledWorkoutId;

  /// run/strength 且有完整 spec 时可推送到手表。
  bool get pushable => (kind == 'run' || kind == 'strength') && spec != null;

  /// 展示名：spec.name → summary → null（调用方回退 kindLabel）。
  String? get displayName {
    final n = spec?.name ?? '';
    if (n.isNotEmpty) return n;
    if (summary.isNotEmpty) return summary;
    return null;
  }
}

/// kind → 中文标签。
String kindLabel(String kind) {
  return switch (kind) {
    'run' => '跑步',
    'strength' => '力量',
    'rest' => '休息',
    'cross' => '交叉',
    'note' => '备注',
    _ => kind,
  };
}
