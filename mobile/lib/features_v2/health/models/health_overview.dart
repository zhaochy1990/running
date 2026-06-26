/// HealthOverview — derived model for the E1 health overview screen.
///
/// Built by [healthOverviewProvider] from the `/health?days=14` response
/// (universal RHR / HRV) PLUS the `/pmc` response for the STRIDE
/// training-load metric. No vendor-proprietary fatigue / load-state scores.
/// RHR baseline diff is computed on the client from the 14-day history;
/// HRV values come from the snapshot in `health.hrv`.
library;

class HealthOverview {
  const HealthOverview({
    this.rhr,
    this.rhrBaselineDiff,
    this.hrv,
    this.hrvLow,
    this.hrvHigh,
    this.form,
    this.loadRatio,
    this.acuteLoad,
    this.chronicLoad,
    this.dataDate,
  });

  /// Current (most-recent) resting heart rate, bpm.
  final int? rhr;

  /// Difference from 14-day P25 baseline (positive = elevated).
  /// null if insufficient data.
  final int? rhrBaselineDiff;

  /// Average sleep HRV from dashboard snapshot.
  final double? hrv;

  /// HRV normal-range low.
  final double? hrvLow;

  /// HRV normal-range high.
  final double? hrvHigh;

  /// STRIDE form (chronic − acute). null if insufficient data.
  final double? form;

  /// STRIDE acute/chronic load ratio (ACWR), computed by STRIDE — not COROS.
  final double? loadRatio;

  /// STRIDE acute load (ATL).
  final double? acuteLoad;

  /// STRIDE chronic load (CTL).
  final double? chronicLoad;

  /// Date of the most-recent health record used.
  final String? dataDate;

  static const empty = HealthOverview();
}
