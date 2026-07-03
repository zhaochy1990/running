/// MasterPlan domain models for C6/C7/C8 screens.
///
/// Mirrors the backend stride_core.master_plan schema.
library;

// ── Enums ─────────────────────────────────────────────────────────────────────

enum MilestoneType {
  race,
  testRun,
  longRun,
  strengthTest;

  static MilestoneType fromJson(String v) => switch (v) {
        'race' => race,
        'test_run' => testRun,
        'long_run' => longRun,
        'strength_test' => strengthTest,
        _ => testRun,
      };

  String get label => switch (this) {
        race => '比赛',
        testRun => '测试跑',
        longRun => '长距离',
        strengthTest => '力量测试',
      };
}

// ── Component models ──────────────────────────────────────────────────────────

class PlanMilestone {

  factory PlanMilestone.fromJson(Map<String, dynamic> json) => PlanMilestone(
        id: json['id'] as String,
        type: MilestoneType.fromJson(json['type'] as String? ?? ''),
        date: json['date'] as String? ?? '',
        phaseId: json['phase_id'] as String? ?? '',
        target: json['target'] as String? ?? '',
        completedActual: json['completed_actual'] as String?,
      );
  const PlanMilestone({
    required this.id,
    required this.type,
    required this.date,
    required this.phaseId,
    required this.target,
    this.completedActual,
  });

  final String id;
  final MilestoneType type;
  final String date; // ISO YYYY-MM-DD
  final String phaseId;
  final String target;
  final String? completedActual;
}

class PlanPhase {

  factory PlanPhase.fromJson(Map<String, dynamic> json) => PlanPhase(
        id: json['id'] as String,
        name: json['name'] as String? ?? '',
        startDate: json['start_date'] as String? ?? '',
        endDate: json['end_date'] as String? ?? '',
        focus: json['focus'] as String? ?? '',
        weeklyDistanceKmLow:
            (json['weekly_distance_km_low'] as num?)?.toDouble() ?? 0,
        weeklyDistanceKmHigh:
            (json['weekly_distance_km_high'] as num?)?.toDouble() ?? 0,
        keySessionTypes: (json['key_session_types'] as List? ?? const [])
            .cast<String>(),
        milestoneIds:
            (json['milestone_ids'] as List? ?? const []).cast<String>(),
      );
  const PlanPhase({
    required this.id,
    required this.name,
    required this.startDate,
    required this.endDate,
    required this.focus,
    required this.weeklyDistanceKmLow,
    required this.weeklyDistanceKmHigh,
    required this.keySessionTypes,
    required this.milestoneIds,
  });

  final String id;
  final String name;
  final String startDate; // ISO YYYY-MM-DD
  final String endDate; // ISO YYYY-MM-DD
  final String focus;
  final double weeklyDistanceKmLow;
  final double weeklyDistanceKmHigh;
  final List<String> keySessionTypes;
  final List<String> milestoneIds;
}

// ── NextMilestone (derived field from /current endpoint) ─────────────────────

class NextMilestone {

  factory NextMilestone.fromJson(Map<String, dynamic> json) => NextMilestone(
        id: json['id'] as String? ?? '',
        date: json['date'] as String? ?? '',
        target: json['target'] as String? ?? '',
        daysUntil: (json['days_until'] as num?)?.toInt() ?? 0,
      );
  const NextMilestone({
    required this.id,
    required this.date,
    required this.target,
    required this.daysUntil,
  });

  final String id;
  final String date;
  final String target;
  final int daysUntil;
}

// ── MasterPlan (top-level) ────────────────────────────────────────────────────

class MasterPlan {

  factory MasterPlan.fromJson(Map<String, dynamic> json) => MasterPlan(
        planId: json['plan_id'] as String? ?? '',
        userId: json['user_id'] as String? ?? '',
        status: json['status'] as String? ?? '',
        startDate: json['start_date'] as String? ?? '',
        endDate: json['end_date'] as String? ?? '',
        phases: (json['phases'] as List? ?? const [])
            .cast<Map<String, dynamic>>()
            .map(PlanPhase.fromJson)
            .toList(growable: false),
        milestones: (json['milestones'] as List? ?? const [])
            .cast<Map<String, dynamic>>()
            .map(PlanMilestone.fromJson)
            .toList(growable: false),
        trainingPrinciples:
            (json['training_principles'] as List? ?? const []).cast<String>(),
        generatedBy: json['generated_by'] as String? ?? '',
        version: (json['version'] as num?)?.toInt() ?? 1,
        createdAt: json['created_at'] as String? ?? '',
        updatedAt: json['updated_at'] as String? ?? '',
        currentPhaseId: json['current_phase_id'] as String?,
        currentWeekNumber: (json['current_week_number'] as num?)?.toInt(),
        totalWeeks: (json['total_weeks'] as num?)?.toInt(),
        nextMilestone: json['next_milestone'] is Map<String, dynamic>
            ? NextMilestone.fromJson(
                json['next_milestone'] as Map<String, dynamic>)
            : null,
      );
  const MasterPlan({
    required this.planId,
    required this.userId,
    required this.status,
    required this.startDate,
    required this.endDate,
    required this.phases,
    required this.milestones,
    required this.trainingPrinciples,
    required this.generatedBy,
    required this.version,
    required this.createdAt,
    required this.updatedAt,
    // Derived fields from /current endpoint
    this.currentPhaseId,
    this.currentWeekNumber,
    this.totalWeeks,
    this.nextMilestone,
  });

  final String planId;
  final String userId;
  final String status;
  final String startDate;
  final String endDate;
  final List<PlanPhase> phases;
  final List<PlanMilestone> milestones;
  final List<String> trainingPrinciples;
  final String generatedBy;
  final int version;
  final String createdAt;
  final String updatedAt;

  // Derived (only present on /current response)
  final String? currentPhaseId;
  final int? currentWeekNumber;
  final int? totalWeeks;
  final NextMilestone? nextMilestone;

  /// Completion ratio 0.0–1.0 based on current week vs total weeks.
  double get completionRatio {
    final total = totalWeeks ?? 0;
    final current = currentWeekNumber ?? 0;
    if (total <= 0) return 0.0;
    return (current / total).clamp(0.0, 1.0);
  }
}

// ── MasterPlanVersionSummary (for C8 history list) ────────────────────────────

class MasterPlanVersionSummary {

  factory MasterPlanVersionSummary.fromJson(Map<String, dynamic> json) =>
      MasterPlanVersionSummary(
        versionId: json['version_id'] as String? ?? '',
        version: (json['version'] as num?)?.toInt() ?? 0,
        changedAt: json['changed_at'] as String? ?? '',
        changeReason: json['change_reason'] as String? ?? '',
        changeSummary: json['change_summary'] as String? ?? '',
      );
  const MasterPlanVersionSummary({
    required this.versionId,
    required this.version,
    required this.changedAt,
    required this.changeReason,
    required this.changeSummary,
  });

  final String versionId;
  final int version;
  final String changedAt;
  final String changeReason;
  final String changeSummary;
}
