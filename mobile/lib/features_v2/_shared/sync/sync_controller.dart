// mobile/lib/features_v2/_shared/sync/sync_controller.dart
//
// SyncController — process-wide singleton owning the in-flight
// COROS sync state.  Re-entry while syncing is silently dropped so a
// second tap on any sync button (or on a different screen's button)
// while a sync is running is a no-op.
//
// Successful sync invalidates every watch-data provider so any active
// screen re-fetches.  The list is hard-coded; future watch-data
// providers must be appended here.
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

class SyncController extends Notifier<SyncState> {
  @override
  SyncState build() => const SyncState();

  /// Trigger a server-side COROS sync.  No-op (returns the resolved
  /// future of the in-flight call) if a sync is already running.
  Future<void> triggerSync() async {
    if (state.syncing) return;
    final userId = ref.read(currentUserIdProvider);
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
