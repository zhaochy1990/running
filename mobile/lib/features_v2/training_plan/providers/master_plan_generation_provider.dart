/// C4 — Master plan generation provider.
///
/// Calls POST /api/users/me/master-plan/generate, persists the job_id to
/// SharedPreferences, then polls GET .../jobs/{job_id} every 2 s until done.
library;

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../data/api/stride_api.dart';
import '../models/master_plan_job_status.dart';

const _kJobIdKey = 'master_plan_job_id';

// ── State ─────────────────────────────────────────────────────────────────────

class MasterPlanGenerationState {
  const MasterPlanGenerationState({
    this.jobStatus,
    this.loading = false,
    this.error,
  });

  final MasterPlanJobStatus? jobStatus;
  final bool loading;
  final String? error;

  bool get isTerminal => jobStatus?.isTerminal ?? false;

  MasterPlanGenerationState copyWith({
    MasterPlanJobStatus? jobStatus,
    bool? loading,
    String? Function()? error,
  }) {
    return MasterPlanGenerationState(
      jobStatus: jobStatus ?? this.jobStatus,
      loading: loading ?? this.loading,
      error: error != null ? error() : this.error,
    );
  }
}

// ── Notifier ──────────────────────────────────────────────────────────────────

class MasterPlanGenerationNotifier
    extends StateNotifier<MasterPlanGenerationState> {
  MasterPlanGenerationNotifier(this._ref)
      : super(const MasterPlanGenerationState()) {
    unawaited(_init());
  }

  final Ref _ref;
  Timer? _poll;
  bool _disposed = false;

  static const _pollInterval = Duration(seconds: 2);

  @override
  void dispose() {
    _disposed = true;
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _init() async {
    // Check for an in-flight job from a previous session.
    final prefs = await SharedPreferences.getInstance();
    final savedJobId = prefs.getString(_kJobIdKey);
    if (savedJobId != null && savedJobId.isNotEmpty) {
      // Resume polling the saved job.
      _pollJob(savedJobId);
      return;
    }
    // No saved job — start a new one.
    await startGeneration();
  }

  Future<void> startGeneration({String? goalId, String? profileId}) async {
    if (_disposed) return;
    state = state.copyWith(loading: true, error: () => null);
    try {
      final resp = await _ref.read(strideApiProvider).postMasterPlanGenerate(
            goalId: goalId,
            profileId: profileId,
          );
      final jobId = resp['job_id'] as String? ?? '';
      if (jobId.isEmpty) throw Exception('No job_id returned');

      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_kJobIdKey, jobId);

      state = state.copyWith(
        loading: false,
        jobStatus: MasterPlanJobStatus(jobId: jobId, status: 'pending'),
      );
      _pollJob(jobId);
    } catch (e) {
      if (!_disposed) {
        state = state.copyWith(loading: false, error: () => e.toString());
      }
    }
  }

  void _pollJob(String jobId) {
    _poll?.cancel();
    if (_disposed) return;
    _poll = Timer(_pollInterval, () => _tick(jobId));
  }

  Future<void> _tick(String jobId) async {
    if (_disposed) return;
    try {
      final json =
          await _ref.read(strideApiProvider).getMasterPlanJobStatus(jobId);
      final status = MasterPlanJobStatus.fromJson(json);
      if (!_disposed) {
        state = state.copyWith(jobStatus: status);
        if (status.isTerminal) {
          // Clear persisted job_id once terminal.
          final prefs = await SharedPreferences.getInstance();
          await prefs.remove(_kJobIdKey);
        }
      }
    } catch (_) {
      // Transient glitch — keep polling.
    }
    if (!_disposed && !(state.jobStatus?.isTerminal ?? false)) {
      _pollJob(jobId);
    }
  }

  Future<void> retry() async {
    _poll?.cancel();
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_kJobIdKey);
    state = const MasterPlanGenerationState();
    await startGeneration();
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

final masterPlanGenerationProvider = StateNotifierProvider.autoDispose<
    MasterPlanGenerationNotifier, MasterPlanGenerationState>(
  (ref) => MasterPlanGenerationNotifier(ref),
);
