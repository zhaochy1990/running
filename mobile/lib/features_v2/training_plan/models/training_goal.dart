/// C1 — Training goal model.
///
/// Serialises to/from the `/api/users/me/training-goal` JSON contract.
library;

enum GoalType { race, pb, fatLoss, health, maintain }

enum RaceDistance { fiveK, tenK, halfMarathon, fullMarathon, trail }

enum TimeSlot { morning, noon, evening }

enum StrengthWillingness { yes, no, conditional }

// ── JSON helpers ──────────────────────────────────────────────────────────────

GoalType _goalTypeFromJson(String v) => switch (v) {
      'race' => GoalType.race,
      'pb' => GoalType.pb,
      'fat_loss' => GoalType.fatLoss,
      'health' => GoalType.health,
      'maintain' => GoalType.maintain,
      _ => GoalType.health,
    };

String _goalTypeToJson(GoalType t) => switch (t) {
      GoalType.race => 'race',
      GoalType.pb => 'pb',
      GoalType.fatLoss => 'fat_loss',
      GoalType.health => 'health',
      GoalType.maintain => 'maintain',
    };

RaceDistance _raceDistanceFromJson(String v) => switch (v) {
      '5K' => RaceDistance.fiveK,
      '10K' => RaceDistance.tenK,
      'HM' => RaceDistance.halfMarathon,
      'FM' => RaceDistance.fullMarathon,
      'trail' => RaceDistance.trail,
      _ => RaceDistance.fullMarathon,
    };

String _raceDistanceToJson(RaceDistance d) => switch (d) {
      RaceDistance.fiveK => '5K',
      RaceDistance.tenK => '10K',
      RaceDistance.halfMarathon => 'HM',
      RaceDistance.fullMarathon => 'FM',
      RaceDistance.trail => 'trail',
    };

TimeSlot _timeSlotFromJson(String v) => switch (v) {
      'morning' => TimeSlot.morning,
      'noon' => TimeSlot.noon,
      'evening' => TimeSlot.evening,
      _ => TimeSlot.evening,
    };

String _timeSlotToJson(TimeSlot s) => switch (s) {
      TimeSlot.morning => 'morning',
      TimeSlot.noon => 'noon',
      TimeSlot.evening => 'evening',
    };

StrengthWillingness _strengthFromJson(String v) => switch (v) {
      'yes' => StrengthWillingness.yes,
      'no' => StrengthWillingness.no,
      'conditional' => StrengthWillingness.conditional,
      _ => StrengthWillingness.conditional,
    };

String _strengthToJson(StrengthWillingness w) => switch (w) {
      StrengthWillingness.yes => 'yes',
      StrengthWillingness.no => 'no',
      StrengthWillingness.conditional => 'conditional',
    };

// ── Model ─────────────────────────────────────────────────────────────────────

class TrainingGoal {
  const TrainingGoal({
    this.goalId,
    required this.type,
    this.raceDate,
    this.raceDistance,
    this.targetFinishTime,
    required this.weeklyTrainingDays,
    required this.availableTimeSlots,
    required this.strengthWillingness,
  });

  final String? goalId;
  final GoalType type;
  final DateTime? raceDate;
  final RaceDistance? raceDistance;

  /// Optional target finish time in H:MM:SS format.
  final String? targetFinishTime;

  /// Number of training days per week (3–6).
  final int weeklyTrainingDays;

  final List<TimeSlot> availableTimeSlots;
  final StrengthWillingness strengthWillingness;

  Map<String, dynamic> toJson() => {
        if (goalId != null) 'goal_id': goalId,
        'type': _goalTypeToJson(type),
        if (raceDate != null)
          'race_date': raceDate!.toIso8601String().substring(0, 10),
        if (raceDistance != null)
          'race_distance': _raceDistanceToJson(raceDistance!),
        if (targetFinishTime != null) 'target_finish_time': targetFinishTime,
        'weekly_training_days': weeklyTrainingDays,
        'available_time_slots':
            availableTimeSlots.map(_timeSlotToJson).toList(),
        'strength_willingness': _strengthToJson(strengthWillingness),
      };

  factory TrainingGoal.fromJson(Map<String, dynamic> json) {
    final rawSlots =
        (json['available_time_slots'] as List? ?? const []).cast<String>();
    final rawDate = json['race_date'] as String?;
    return TrainingGoal(
      goalId: json['goal_id'] as String?,
      type: _goalTypeFromJson(json['type'] as String? ?? 'health'),
      raceDate: rawDate != null ? DateTime.tryParse(rawDate) : null,
      raceDistance: json['race_distance'] != null
          ? _raceDistanceFromJson(json['race_distance'] as String)
          : null,
      targetFinishTime: json['target_finish_time'] as String?,
      weeklyTrainingDays: (json['weekly_training_days'] as num?)?.toInt() ?? 4,
      availableTimeSlots: rawSlots.map(_timeSlotFromJson).toList(),
      strengthWillingness: _strengthFromJson(
          json['strength_willingness'] as String? ?? 'conditional'),
    );
  }

  TrainingGoal copyWith({
    String? goalId,
    GoalType? type,
    Object? raceDate = _sentinel,
    Object? raceDistance = _sentinel,
    Object? targetFinishTime = _sentinel,
    int? weeklyTrainingDays,
    List<TimeSlot>? availableTimeSlots,
    StrengthWillingness? strengthWillingness,
  }) {
    return TrainingGoal(
      goalId: goalId ?? this.goalId,
      type: type ?? this.type,
      raceDate:
          identical(raceDate, _sentinel) ? this.raceDate : raceDate as DateTime?,
      raceDistance: identical(raceDistance, _sentinel)
          ? this.raceDistance
          : raceDistance as RaceDistance?,
      targetFinishTime: identical(targetFinishTime, _sentinel)
          ? this.targetFinishTime
          : targetFinishTime as String?,
      weeklyTrainingDays: weeklyTrainingDays ?? this.weeklyTrainingDays,
      availableTimeSlots: availableTimeSlots ?? this.availableTimeSlots,
      strengthWillingness: strengthWillingness ?? this.strengthWillingness,
    );
  }
}

const _sentinel = Object();
