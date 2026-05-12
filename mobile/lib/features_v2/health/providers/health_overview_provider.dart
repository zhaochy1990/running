/// HealthOverviewProvider — fetches /health?days=14 and derives
/// the [HealthOverview] aggregate for the E1 screen.
///
/// Baseline RHR diff: computed here (P25 of 14-day RHR values).
/// HRV: taken from the `hrv` snapshot sub-object in the response.
/// No new backend endpoints needed.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../models/health_overview.dart';

final healthOverviewProvider =
    FutureProvider.autoDispose<HealthOverview>((ref) async {
  final api = ref.watch(strideApiProvider);
  final userId = ref.watch(currentUserIdProvider);
  if (userId == null) throw Exception('用户未登录');

  final response = await api.getHealth(userId, days: 14);

  final records = response.health;
  if (records.isEmpty) return HealthOverview.empty;

  // Most-recent record for current values.
  final latest = records.first; // already ordered DESC

  final currentRhr = latest.rhr;
  final currentFatigue = latest.fatigue?.toDouble();
  final currentLoadState = latest.trainingLoadState;
  final currentLoadRatio = latest.trainingLoadRatio?.toDouble();

  // ── RHR baseline diff ────────────────────────────────────────────────
  int? rhrBaselineDiff;
  // Use the server-computed P10 baseline if available.
  final baseline = response.rhrBaseline?.toInt();
  if (currentRhr != null && baseline != null) {
    rhrBaselineDiff = currentRhr - baseline;
  }

  // ── HRV from snapshot ────────────────────────────────────────────────
  final hrv = response.hrv;
  final avgSleepHrv = hrv.avgSleepHrv?.toDouble();
  final hrvLow = hrv.hrvNormalLow?.toDouble();
  final hrvHigh = hrv.hrvNormalHigh?.toDouble();

  // ── Sleep history (7 days, oldest → newest) ──────────────────────────
  // HealthRecord.sleepTotalS in seconds; may be null for COROS users.
  final sleepHistory = records
      .take(7)
      .map((r) => r.sleepTotalS?.toDouble() ?? 0.0)
      .toList(growable: false)
      .reversed
      .toList(growable: false);
  final hasSleepData = sleepHistory.any((s) => s > 0);

  return HealthOverview(
    rhr: currentRhr,
    rhrBaselineDiff: rhrBaselineDiff,
    hrv: avgSleepHrv,
    hrvLow: hrvLow,
    hrvHigh: hrvHigh,
    fatigue: currentFatigue,
    fatigueBand: FatigueBand.from(currentFatigue),
    loadState: currentLoadState,
    loadRatio: currentLoadRatio,
    sleepHistory: hasSleepData ? sleepHistory : null,
    dataDate: latest.date,
  );
});
