/// C2 — Running profile providers.
///
/// [runningProfileProvider]  — async loader (GET); returns null on 404.
/// [runningProfileFormProvider] — form editing state + submit logic.
library;

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/api/stride_api.dart';
import '../models/running_profile.dart';

// ── Loader ────────────────────────────────────────────────────────────────────

/// Fetches the current user's running profile. Returns null when none exists (404).
final runningProfileProvider =
    FutureProvider.autoDispose<RunningProfile?>((ref) async {
  final api = ref.watch(strideApiProvider);
  return api.getRunningProfile();
});

// ── Form state ────────────────────────────────────────────────────────────────

class RunningProfileForm {
  const RunningProfileForm({
    this.profileId,
    this.runningAge,
    this.currentWeeklyKm,
    this.pbs = const {},
    this.injuries = const [],
    this.submitting = false,
    this.error,
  });

  final String? profileId;
  final RunningAge? runningAge;
  final WeeklyKm? currentWeeklyKm;

  /// Map of distance key → H:MM:SS string. Keys: "5K","10K","HM","FM".
  final Map<String, String> pbs;

  final List<String> injuries;
  final bool submitting;
  final String? error;

  bool get isComplete => runningAge != null && currentWeeklyKm != null;

  RunningProfileForm copyWith({
    String? profileId,
    RunningAge? runningAge,
    WeeklyKm? currentWeeklyKm,
    Map<String, String>? pbs,
    List<String>? injuries,
    bool? submitting,
    Object? error = _sentinel,
  }) {
    return RunningProfileForm(
      profileId: profileId ?? this.profileId,
      runningAge: runningAge ?? this.runningAge,
      currentWeeklyKm: currentWeeklyKm ?? this.currentWeeklyKm,
      pbs: pbs ?? this.pbs,
      injuries: injuries ?? this.injuries,
      submitting: submitting ?? this.submitting,
      error: identical(error, _sentinel) ? this.error : error as String?,
    );
  }

  RunningProfile toModel() => RunningProfile(
        profileId: profileId,
        runningAge: runningAge!,
        currentWeeklyKm: currentWeeklyKm!,
        pbs: pbs.entries
            .where((e) => e.value.trim().isNotEmpty)
            .map((e) => PB(distance: e.key, time: e.value.trim()))
            .toList(),
        injuries: injuries,
      );
}

const _sentinel = Object();

// ── Notifier ──────────────────────────────────────────────────────────────────

class RunningProfileNotifier extends StateNotifier<RunningProfileForm> {
  RunningProfileNotifier(this._ref) : super(const RunningProfileForm());

  RunningProfileNotifier.withState(super.s, this._ref);

  final Ref _ref;

  void loadFrom(RunningProfile profile) {
    final pbMap = <String, String>{};
    for (final pb in profile.pbs) {
      pbMap[pb.distance] = pb.time;
    }
    state = RunningProfileForm(
      profileId: profile.profileId,
      runningAge: profile.runningAge,
      currentWeeklyKm: profile.currentWeeklyKm,
      pbs: pbMap,
      injuries: List.of(profile.injuries),
    );
  }

  void setRunningAge(RunningAge a) => state = state.copyWith(runningAge: a);
  void setCurrentWeeklyKm(WeeklyKm k) =>
      state = state.copyWith(currentWeeklyKm: k);

  void setPB(String distance, String time) {
    final updated = Map<String, String>.of(state.pbs);
    if (time.trim().isEmpty) {
      updated.remove(distance);
    } else {
      updated[distance] = time.trim();
    }
    state = state.copyWith(pbs: updated);
  }

  void toggleInjury(String tag) {
    final current = List<String>.of(state.injuries);
    if (tag == 'none') {
      // "暂无" is mutually exclusive with everything else.
      state = state.copyWith(injuries: current.contains('none') ? [] : ['none']);
      return;
    }
    // Selecting any real injury clears "none".
    current.remove('none');
    if (current.contains(tag)) {
      current.remove(tag);
    } else {
      current.add(tag);
    }
    state = state.copyWith(injuries: current);
  }

  /// POST running profile. Returns true on success.
  Future<bool> submit() async {
    if (!state.isComplete || state.submitting) return false;
    state = state.copyWith(submitting: true, error: null);
    final api = _ref.read(strideApiProvider);
    try {
      final saved = await api.postRunningProfile(state.toModel().toJson());
      state = state.copyWith(submitting: false, profileId: saved.profileId);
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

final runningProfileFormProvider = StateNotifierProvider.autoDispose<
    RunningProfileNotifier, RunningProfileForm>(
  (ref) => RunningProfileNotifier(ref),
);
