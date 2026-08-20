library;

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../../activity/providers/activity_detail_provider.dart';
import '../../activity/providers/timeseries_provider.dart';
import '../../health/providers/ability_snapshot_provider.dart';
import '../../health/providers/health_overview_provider.dart';
import '../../health/providers/pb_records_provider.dart';
import '../../health/providers/pmc_provider.dart';
import '../../health/providers/race_prediction_provider.dart';
import '../../health/providers/trends_provider.dart';
import '../../home/providers/home_provider.dart';
import '../../review/providers/week_review_provider.dart';

/// SyncController — process-wide singleton owning the in-flight
/// COROS sync state. Re-entry from the same user joins the active request;
/// another user cannot reuse or publish the previous account's result.
///
/// Successful sync invalidates every watch-data provider so any active
/// screen re-fetches.  The list is hard-coded; future watch-data
/// providers must be appended here.
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
      await ref.read(strideApiProvider).triggerSync(userId);
      if (ref.read(currentUserIdProvider) != userId) {
        throw StateError('账号已切换，同步结果已忽略');
      }
      ref.invalidate(homeProvider);
      ref.invalidate(healthOverviewProvider);
      ref.invalidate(pmcProvider);
      ref.invalidate(abilitySnapshotProvider);
      ref.invalidate(racePredictionProvider);
      ref.invalidate(racePredictionHistoryProvider);
      ref.invalidate(pbRecordsProvider);
      ref.invalidate(trendsProvider);
      ref.invalidate(activityDetailProvider);
      ref.invalidate(timeseriesProvider);
      ref.invalidate(weekReviewProvider);
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
}

final syncControllerProvider = NotifierProvider<SyncController, SyncState>(
  SyncController.new,
);
