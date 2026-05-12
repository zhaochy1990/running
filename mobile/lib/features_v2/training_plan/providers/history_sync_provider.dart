/// C3 — 3-year history sync provider.
///
/// Kicks off POST /api/users/me/full-sync, then polls
/// GET /api/users/me/full-sync-status every 2s until terminal.
/// App lifecycle-aware: pauses on background, resumes on foreground.
library;

import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/api/stride_api.dart';

// ── State ─────────────────────────────────────────────────────────────────────

enum HistorySyncPhase { starting, running, done, error }

class HistorySyncState {
  const HistorySyncState({
    this.phase = HistorySyncPhase.starting,
    this.percent = 0,
    this.message,
    this.syncedCount,
    this.error,
  });

  final HistorySyncPhase phase;

  /// 0-100
  final int percent;

  /// Stage message from backend e.g. "同步活动 2025-12 / 2024-08"
  final String? message;

  /// Number of activities synced so far
  final int? syncedCount;

  final String? error;

  bool get isTerminal =>
      phase == HistorySyncPhase.done || phase == HistorySyncPhase.error;

  HistorySyncState copyWith({
    HistorySyncPhase? phase,
    int? percent,
    String? message,
    int? syncedCount,
    String? Function()? error,
  }) {
    return HistorySyncState(
      phase: phase ?? this.phase,
      percent: percent ?? this.percent,
      message: message ?? this.message,
      syncedCount: syncedCount ?? this.syncedCount,
      error: error != null ? error() : this.error,
    );
  }

  static const initial = HistorySyncState();
}

// ── Notifier ──────────────────────────────────────────────────────────────────

class HistorySyncNotifier extends StateNotifier<HistorySyncState>
    with WidgetsBindingObserver {
  HistorySyncNotifier(this._ref) : super(HistorySyncState.initial) {
    WidgetsBinding.instance.addObserver(this);
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
  void didChangeAppLifecycleState(AppLifecycleState lifecycle) {
    if (_disposed) return;
    if (lifecycle == AppLifecycleState.resumed && !state.isTerminal) {
      _scheduleNextPoll(immediate: true);
    } else if (lifecycle == AppLifecycleState.paused ||
        lifecycle == AppLifecycleState.inactive) {
      _poll?.cancel();
    }
  }

  Future<void> start() async {
    if (_disposed) return;
    state = HistorySyncState.initial.copyWith(
      phase: HistorySyncPhase.starting,
      error: () => null,
    );

    try {
      await _ref.read(strideApiProvider).startFullSync();
    } catch (e) {
      // 409 = already running — fall through to polling.
      final msg = e.toString();
      if (!msg.contains('409')) {
        state = state.copyWith(
          phase: HistorySyncPhase.error,
          error: () => '启动同步失败，请重试',
        );
        return;
      }
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
      final json = await _ref.read(strideApiProvider).getFullSyncStatus();
      _applyStatus(json);
    } catch (_) {
      // Transient glitch — keep polling.
    }
    if (!state.isTerminal) _scheduleNextPoll();
  }

  void _applyStatus(Map<String, dynamic> json) {
    final st = (json['status'] as String?)?.toLowerCase() ??
        (json['state'] as String?)?.toLowerCase();
    final progress = (json['progress'] as num?)?.toInt() ?? state.percent;
    final message = json['message'] as String?;
    final syncedCount = (json['synced_count'] as num?)?.toInt();

    HistorySyncPhase phase;
    if (st == 'completed' || st == 'done' || progress == 100) {
      phase = HistorySyncPhase.done;
    } else if (st == 'error' || st == 'failed') {
      phase = HistorySyncPhase.error;
    } else {
      phase = HistorySyncPhase.running;
    }

    state = state.copyWith(
      phase: phase,
      percent: progress,
      message: message,
      syncedCount: syncedCount,
      error: phase == HistorySyncPhase.error
          ? () => json['error'] as String? ?? '同步失败，请重试'
          : () => null,
    );
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

final historySyncProvider =
    StateNotifierProvider.autoDispose<HistorySyncNotifier, HistorySyncState>(
  (ref) => HistorySyncNotifier(ref),
);
