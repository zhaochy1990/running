/// C1 — Training goal providers.
///
/// [trainingGoalProvider]  — async loader (GET); returns null on 404.
/// [trainingGoalFormProvider] — form editing state + submit logic.
library;

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/api/stride_api.dart';
import '../models/training_goal.dart';

// ── Loader ────────────────────────────────────────────────────────────────────

/// Fetches the current user's training goal. Returns null when none exists (404).
final trainingGoalProvider =
    FutureProvider.autoDispose<TrainingGoal?>((ref) async {
  final api = ref.watch(strideApiProvider);
  return api.getTrainingGoal();
});

// ── Form state ────────────────────────────────────────────────────────────────

class TrainingGoalForm {
  const TrainingGoalForm({
    this.goalId,
    this.type,
    this.raceDate,
    this.raceDistance,
    this.targetFinishTime,
    this.weeklyTrainingDays = 4,
    this.availableTimeSlots = const [],
    this.strengthWillingness,
    this.submitting = false,
    this.error,
  });

  final String? goalId;
  final GoalType? type;
  final DateTime? raceDate;
  final RaceDistance? raceDistance;
  final String? targetFinishTime;
  final int weeklyTrainingDays;
  final List<TimeSlot> availableTimeSlots;
  final StrengthWillingness? strengthWillingness;
  final bool submitting;
  final String? error;

  bool get isComplete {
    if (type == null) return false;
    if (availableTimeSlots.isEmpty) return false;
    if (strengthWillingness == null) return false;
    if (type == GoalType.race && raceDate == null) return false;
    if (type == GoalType.race && raceDistance == null) return false;
    return true;
  }

  TrainingGoalForm copyWith({
    String? goalId,
    GoalType? type,
    Object? raceDate = _sentinel,
    Object? raceDistance = _sentinel,
    Object? targetFinishTime = _sentinel,
    int? weeklyTrainingDays,
    List<TimeSlot>? availableTimeSlots,
    StrengthWillingness? strengthWillingness,
    bool? submitting,
    Object? error = _sentinel,
  }) {
    return TrainingGoalForm(
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
      submitting: submitting ?? this.submitting,
      error: identical(error, _sentinel) ? this.error : error as String?,
    );
  }

  TrainingGoal toModel() => TrainingGoal(
        goalId: goalId,
        type: type!,
        raceDate: raceDate,
        raceDistance: raceDistance,
        targetFinishTime: targetFinishTime,
        weeklyTrainingDays: weeklyTrainingDays,
        availableTimeSlots: availableTimeSlots,
        strengthWillingness: strengthWillingness!,
      );
}

const _sentinel = Object();

// ── Notifier ──────────────────────────────────────────────────────────────────

class TrainingGoalNotifier extends StateNotifier<TrainingGoalForm> {
  TrainingGoalNotifier(this._ref) : super(const TrainingGoalForm());

  TrainingGoalNotifier.withState(super.s, this._ref);

  final Ref _ref;

  void loadFrom(TrainingGoal goal) {
    state = TrainingGoalForm(
      goalId: goal.goalId,
      type: goal.type,
      raceDate: goal.raceDate,
      raceDistance: goal.raceDistance,
      targetFinishTime: goal.targetFinishTime,
      weeklyTrainingDays: goal.weeklyTrainingDays,
      availableTimeSlots: List.of(goal.availableTimeSlots),
      strengthWillingness: goal.strengthWillingness,
    );
  }

  void setType(GoalType t) {
    // Clear race fields when switching away from race.
    if (t != GoalType.race) {
      state = state.copyWith(
        type: t,
        raceDate: null,
        raceDistance: null,
        targetFinishTime: null,
      );
    } else {
      state = state.copyWith(type: t);
    }
  }

  void setRaceDate(DateTime? d) => state = state.copyWith(raceDate: d);
  void setRaceDistance(RaceDistance? d) =>
      state = state.copyWith(raceDistance: d);
  void setTargetFinishTime(String? t) =>
      state = state.copyWith(targetFinishTime: t);
  void setWeeklyTrainingDays(int v) =>
      state = state.copyWith(weeklyTrainingDays: v);
  void setStrengthWillingness(StrengthWillingness w) =>
      state = state.copyWith(strengthWillingness: w);

  void toggleTimeSlot(TimeSlot slot) {
    final current = List<TimeSlot>.of(state.availableTimeSlots);
    if (current.contains(slot)) {
      current.remove(slot);
    } else {
      current.add(slot);
    }
    state = state.copyWith(availableTimeSlots: current);
  }

  /// POST (create) or PUT (update) depending on whether a goalId already
  /// exists. Returns true on success; populates [error] on failure.
  Future<bool> submit() async {
    if (!state.isComplete || state.submitting) return false;
    state = state.copyWith(submitting: true, error: null);
    final api = _ref.read(strideApiProvider);
    try {
      final model = state.toModel();
      final saved = state.goalId != null
          ? await api.putTrainingGoal(model.toJson())
          : await api.postTrainingGoal(model.toJson());
      state = state.copyWith(submitting: false, goalId: saved.goalId);
      return true;
    } on DioException catch (e) {
      final data = e.response?.data;
      final detail =
          data is Map<String, dynamic> ? data['detail']?.toString() : null;
      state = state.copyWith(
        submitting: false,
        error: detail ?? e.message,
      );
      return false;
    } catch (e) {
      state = state.copyWith(submitting: false, error: e.toString());
      return false;
    }
  }
}

final trainingGoalFormProvider = StateNotifierProvider.autoDispose<
    TrainingGoalNotifier, TrainingGoalForm>(
  (ref) => TrainingGoalNotifier(ref),
);
