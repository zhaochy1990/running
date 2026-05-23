library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../../health/providers/ability_snapshot_provider.dart';
import '../../health/providers/health_overview_provider.dart';
import '../../health/providers/pb_records_provider.dart';
import '../../health/providers/pmc_provider.dart';
import '../../health/providers/race_prediction_provider.dart';
import '../../health/providers/trends_provider.dart';
import '../../home/providers/home_provider.dart';

/// SyncController — process-wide singleton owning the in-flight
/// COROS sync state.  Re-entry while syncing is silently dropped so a
/// second tap on any sync button (or on a different screen's button)
/// while a sync is running is a no-op.
///
/// Successful sync invalidates every watch-data provider so any active
/// screen re-fetches.  The list is hard-coded; future watch-data
/// providers must be appended here.
class SyncState {
  const SyncState({
    this.syncing = false,
    this.lastSyncedAt,
    this.error,
  });

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
  @override
  SyncState build() => const SyncState();

  /// Trigger a server-side COROS sync.  No-op (returns the resolved
  /// future of the in-flight call) if a sync is already running.
  Future<void> triggerSync() async {
    if (state.syncing) return;
    final userId = ref.read(currentUserIdProvider);
    // userId == null is unreachable in production because the v2 router
    // redirects unauthenticated requests to /v2/auth/start before any
    // data screen mounts. Silently return as a defensive no-op.
    if (userId == null) return;

    state = state.copyWith(syncing: true, clearError: true);
    try {
      await ref.read(strideApiProvider).triggerSync(userId);
      ref.invalidate(homeProvider);
      ref.invalidate(healthOverviewProvider);
      ref.invalidate(pmcProvider);
      ref.invalidate(abilitySnapshotProvider);
      ref.invalidate(racePredictionProvider);
      ref.invalidate(racePredictionHistoryProvider);
      ref.invalidate(pbRecordsProvider);
      ref.invalidate(trendsProvider);
      state = state.copyWith(
        syncing: false,
        lastSyncedAt: DateTime.now(),
        clearError: true,
      );
    } catch (e) {
      state = state.copyWith(syncing: false, error: e);
      rethrow;
    }
  }
}

final syncControllerProvider =
    NotifierProvider<SyncController, SyncState>(SyncController.new);
