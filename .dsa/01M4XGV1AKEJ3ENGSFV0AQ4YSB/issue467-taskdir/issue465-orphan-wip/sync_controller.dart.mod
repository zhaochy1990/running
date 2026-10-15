library;

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../../activity/providers/activity_detail_provider.dart';
import '../../activity/providers/timeseries_provider.dart';
import '../../health/providers/ability_snapshot_provider.dart';
import '../../health/providers/pb_records_provider.dart';
import '../../health/providers/race_prediction_provider.dart';
import '../../health/providers/training_status_provider.dart';
import '../../watch/watch_providers.dart';

/// SyncController — process-wide singleton owning the in-flight
/// incremental watch sync. Re-entry from the same user joins the active
/// request; another user cannot reuse or publish the previous account's result.
///
/// Contract (#462): `POST /api/{user}/sync {mode:'incremental'}` (no
/// idempotency key) → poll `GET /api/pipelines/{run_id}` (2s interval,
/// 60min deadline, mirroring the miniprogram pollPipeline) → invalidate
/// every watch-data provider only when the run is done.
class SyncState {
  const SyncState({this.syncing = false, this.lastSyncedAt, this.error});

  final bool syncing;
  final DateTime? lastSyncedAt;
  final Object? error;

  SyncState copyWith({
    bool? syncing,
    DateTime? lastSyncedAt,
    Object? error,
    bool clearError = false,
  }) {
    return SyncState(
      syncing: syncing ?? this.syncing,
      lastSyncedAt: lastSyncedAt ?? this.lastSyncedAt,
      error: clearError ? null : (error ?? this.error),
    );
  }
}

/// Singleton sync state owner.
///
/// On `triggerSync` failure the controller does two things deliberately:
///   1. Stores the exception in `state.error` (for future inspection —
///      no current screen renders it; reserved for a persistent badge).
///   2. Rethrows so the calling screen's `try { await triggerSync(); }
///      catch (e) { SnackBar(...) }` path can show user-facing feedback.
///
/// When a screen starts watching `state.error` for display, that screen
/// must NOT also catch the rethrown exception or the error will render
/// twice.
class SyncController extends Notifier<SyncState> {
  ({String userId, Future<void> future})? _inFlight;

  static const _pollInterval = Duration(seconds: 2);
  static const _pollTimeout = Duration(minutes: 60);

  @override
  SyncState build() => const SyncState();

  /// Trigger a server-side COROS sync. Returns the in-flight call if a sync
  /// is already running so every caller observes the same result.
  Future<void> triggerSync() {
    final userId = ref.read(currentUserIdProvider);
    if (userId == null) {
      return Future<void>.error(StateError('当前用户尚未加载，请稍后重试'));
    }
    final inFlight = _inFlight;
    if (inFlight != null) {
      if (inFlight.userId != userId) {
        return Future<void>.error(StateError('账号已切换，请稍后重试'));
      }
      return inFlight.future;
    }

    final completer = Completer<void>();
    late final Future<void> trackedSync;
    trackedSync = completer.future.whenComplete(() {
      if (identical(_inFlight?.future, trackedSync)) {
        _inFlight = null;
      }
    });
    _inFlight = (userId: userId, future: trackedSync);
    unawaited(
      _runSync(userId).then(
        (_) => completer.complete(),
        onError: (Object error, StackTrace stackTrace) {
          completer.completeError(error, stackTrace);
        },
      ),
    );
    return trackedSync;
  }

  Future<void> _runSync(String userId) async {
    state = state.copyWith(syncing: true, clearError: true);
    try {
      final res = await ref.read(strideApiProvider).triggerSync(userId, full: false);
      await _awaitRunDone(res.runId);
      if (ref.read(currentUserIdProvider) != userId) {
        throw StateError('账号已切换，同步结果已忽略');
      }
      ref.invalidate(trainingStatusProvider);
      ref.invalidate(abilitySnapshotProvider);
      ref.invalidate(racePredictionProvider);
      ref.invalidate(racePredictionHistoryProvider);
      ref.invalidate(pbRecordsProvider);
      ref.invalidate(activityDetailProvider);
      ref.invalidate(timeseriesProvider);
      // last_sync_at 由服务端在 run 成功后写 sync_meta，这里回读刷新。
      ref.invalidate(watchInfoProvider);
      state = state.copyWith(
        syncing: false,
        lastSyncedAt: DateTime.now(),
        clearError: true,
      );
    } catch (e) {
      if (ref.read(currentUserIdProvider) == userId) {
        state = state.copyWith(syncing: false, error: e);
      } else {
        state = const SyncState();
      }
      rethrow;
    }
  }

  /// 轮询 run 直到 done / failed / 60min 上限。先查状态后查 deadline：
  /// 恰在到点时完成的 run 按 done 结算。
  Future<void> _awaitRunDone(String runId) async {
    final deadline = DateTime.now().add(_pollTimeout);
    while (true) {
      final run = await ref.read(strideApiProvider).getPipelineRun(runId);
      if (run.isDone) return;
      if (run.isFailed) {
        throw Exception(run.errorMessage ?? '同步失败');
      }
      if (DateTime.now().isAfter(deadline)) {
        throw Exception('同步超时');
      }
      await Future<void>.delayed(_pollInterval);
    }
  }
}

final syncControllerProvider = NotifierProvider<SyncController, SyncState>(
  SyncController.new,
);

/// 同步失败 toast 文案（与小程序 profile 页一致）：错误内容 > 15 字
/// 截断为「同步失败」，短文案（如「同步超时」、服务端 error 体）直接展示。
String syncErrorText(Object e) {
  final raw = e is ApiException
      ? e.message
      : e.toString().replaceFirst('Exception: ', '');
  return raw.length > 15 ? '同步失败' : raw;
}
