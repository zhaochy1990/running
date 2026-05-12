/// B3 — first-sync progress provider.
///
/// Kicks off the lightweight onboarding sync once, then polls the
/// `/sync-status` endpoint every 2s to surface progress. Pauses on
/// app background and resumes on foreground (handled by the screen).
library;

import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';

enum SyncPhase { starting, login, activities, health, done, error }

class SyncProgress {
  const SyncProgress({
    this.phase = SyncPhase.starting,
    this.percent = 0,
    this.message,
    this.syncedActivities,
    this.syncedHealth,
    this.error,
  });

  final SyncPhase phase;
  final int percent;
  final String? message;
  final int? syncedActivities;
  final int? syncedHealth;
  final String? error;

  bool get isTerminal => phase == SyncPhase.done || phase == SyncPhase.error;

  SyncProgress copyWith({
    SyncPhase? phase,
    int? percent,
    String? message,
    int? syncedActivities,
    int? syncedHealth,
    String? error,
    bool clearError = false,
  }) {
    return SyncProgress(
      phase: phase ?? this.phase,
      percent: percent ?? this.percent,
      message: message ?? this.message,
      syncedActivities: syncedActivities ?? this.syncedActivities,
      syncedHealth: syncedHealth ?? this.syncedHealth,
      error: clearError ? null : (error ?? this.error),
    );
  }

  static const initial = SyncProgress();
}

class SyncProgressController extends StateNotifier<SyncProgress>
    with WidgetsBindingObserver {
  SyncProgressController(this._ref) : super(SyncProgress.initial) {
    WidgetsBinding.instance.addObserver(this);
    // Kick off automatically on construction.
    unawaited(start());
  }

  final Ref _ref;
  Timer? _poll;
  bool _disposed = false;

  static const _pollInterval = Duration(seconds: 2);

  @override
  void dispose() {
    _disposed = true;
    _poll?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (_disposed) return;
    if (state == AppLifecycleState.resumed && !this.state.isTerminal) {
      _scheduleNextPoll(immediate: true);
    } else if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.inactive) {
      _poll?.cancel();
    }
  }

  Future<void> start() async {
    state = SyncProgress.initial.copyWith(
      phase: SyncPhase.login,
      message: '正在登录 COROS...',
      clearError: true,
    );
    try {
      await _ref.read(strideApiProvider).startOnboardingSync();
    } on ApiException catch (e) {
      // Backend may return 409 if a sync is already running — treat
      // as success and fall through to polling.
      if (e.statusCode != 409) {
        state = state.copyWith(phase: SyncPhase.error, error: _mapError(e));
        return;
      }
    } catch (_) {
      state = state.copyWith(phase: SyncPhase.error, error: '网络异常，请检查网络后重试');
      return;
    }
    _scheduleNextPoll(immediate: true);
  }

  Future<void> retry() async {
    _poll?.cancel();
    await start();
  }

  void _scheduleNextPoll({bool immediate = false}) {
    _poll?.cancel();
    if (_disposed || state.isTerminal) return;
    _poll = Timer(immediate ? Duration.zero : _pollInterval, _tick);
  }

  Future<void> _tick() async {
    if (_disposed) return;
    try {
      final json =
          await _ref.read(strideApiProvider).getOnboardingSyncStatus();
      _applyStatus(json);
    } on ApiException catch (e) {
      state = state.copyWith(phase: SyncPhase.error, error: _mapError(e));
      return;
    } catch (_) {
      // Transient network glitch — keep polling.
    }
    if (!state.isTerminal) _scheduleNextPoll();
  }

  void _applyStatus(Map<String, dynamic> json) {
    final st = (json['state'] as String?)?.toLowerCase();
    final progress = (json['progress'] as Map?)?.cast<String, dynamic>() ?? {};
    final phaseRaw = (progress['phase'] as String?)?.toLowerCase();
    final percent = (progress['percent'] as num?)?.toInt() ?? state.percent;
    final message = progress['message'] as String?;
    final syncedAct = (progress['synced_activities'] as num?)?.toInt();
    final syncedHealth = (progress['synced_health'] as num?)?.toInt();

    SyncPhase phase;
    if (st == 'done') {
      phase = SyncPhase.done;
    } else if (st == 'error') {
      phase = SyncPhase.error;
    } else if (phaseRaw != null && phaseRaw.contains('health')) {
      phase = SyncPhase.health;
    } else if (phaseRaw != null && phaseRaw.contains('activit')) {
      phase = SyncPhase.activities;
    } else if (phaseRaw != null && phaseRaw.contains('login')) {
      phase = SyncPhase.login;
    } else {
      phase = state.phase;
    }

    state = state.copyWith(
      phase: phase,
      percent: percent,
      message: message,
      syncedActivities: syncedAct,
      syncedHealth: syncedHealth,
      error: phase == SyncPhase.error
          ? (json['error'] as String? ?? '同步失败，请重试')
          : null,
      clearError: phase != SyncPhase.error,
    );

    if (phase == SyncPhase.done) {
      // Refresh profile so router guard can advance.
      _ref.invalidate(currentUserProvider);
    }
  }

  String _mapError(ApiException e) {
    if (e.isServerError) return '服务端异常，请稍后重试';
    final raw = (e.detail is Map && (e.detail as Map)['detail'] != null)
        ? (e.detail as Map)['detail'].toString()
        : e.message;
    return raw.isEmpty ? '同步失败，请重试' : raw;
  }
}

final syncProgressProvider = StateNotifierProvider.autoDispose<
    SyncProgressController, SyncProgress>(
  (ref) => SyncProgressController(ref),
);
