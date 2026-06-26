/// HealthOverviewProvider — fetches /health?days=14 (universal RHR / HRV)
/// and /pmc (STRIDE acute/chronic/form/ratio) and derives the
/// [HealthOverview] aggregate for the E1 screen. (COROS does not expose sleep
/// duration via its API, so no sleep metric here.)
///
/// Baseline RHR diff: computed here (P25 of 14-day RHR values).
/// HRV: taken from the `hrv` snapshot sub-object in the response.
/// Training load: STRIDE-computed (`/pmc` stride_summary) — NOT COROS
/// fatigue / training_load_ratio / training_load_state.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../models/health_overview.dart';

final healthOverviewProvider = FutureProvider.autoDispose<HealthOverview>((
  ref,
) async {
  final api = ref.watch(strideApiProvider);
  final userId = ref.watch(currentUserIdProvider);
  if (userId == null) throw Exception('用户未登录');

  final response = await api.getHealth(userId, days: 14);

  final records = response.health;
  if (records.isEmpty) return HealthOverview.empty;

  // Most-recent record for current values (universal sensor data only).
  final latest = records.first; // already ordered DESC

  final currentRhr = latest.rhr;

  // ── STRIDE training load (from /pmc, not COROS) ──────────────────────
  // Source acute/chronic/form/ratio from STRIDE's own daily_training_load
  // so no vendor-proprietary fatigue / load-state leaks into the UI.
  final pmc = await api.getPMC(userId);
  final strideSummary = pmc.strideSummary;
  final form = strideSummary?.currentForm?.toDouble();
  final loadRatio = strideSummary?.currentLoadRatio?.toDouble();
  final acuteLoad = strideSummary?.currentAcuteLoad?.toDouble();
  final chronicLoad = strideSummary?.currentChronicLoad?.toDouble();

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

  return HealthOverview(
    rhr: currentRhr,
    rhrBaselineDiff: rhrBaselineDiff,
    hrv: avgSleepHrv,
    hrvLow: hrvLow,
    hrvHigh: hrvHigh,
    form: form,
    loadRatio: loadRatio,
    acuteLoad: acuteLoad,
    chronicLoad: chronicLoad,
    dataDate: latest.date,
  );
});
