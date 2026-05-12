/// HealthOverview — derived model for the E1 health overview screen.
///
/// Built by [healthOverviewProvider] from the `/health?days=14` response.
/// RHR baseline diff is computed on the client from the 14-day history;
/// HRV values come from the snapshot in `health.hrv`.
library;

/// Maps a fatigue value to a display band.
enum FatigueBand {
  recovered, // < 40
  normal, // 40-49
  fatigued, // 50-59
  high; // >= 60

  static FatigueBand from(double? fatigue) {
    if (fatigue == null) return FatigueBand.normal;
    if (fatigue < 40) return FatigueBand.recovered;
    if (fatigue < 50) return FatigueBand.normal;
    if (fatigue < 60) return FatigueBand.fatigued;
    return FatigueBand.high;
  }

  String get label {
    switch (this) {
      case FatigueBand.recovered:
        return '已恢复';
      case FatigueBand.normal:
        return '正常';
      case FatigueBand.fatigued:
        return '疲劳';
      case FatigueBand.high:
        return '高疲劳';
    }
  }
}

class HealthOverview {
  const HealthOverview({
    this.rhr,
    this.rhrBaselineDiff,
    this.hrv,
    this.hrvLow,
    this.hrvHigh,
    this.fatigue,
    required this.fatigueBand,
    this.loadState,
    this.loadRatio,
    this.sleepHistory,
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

  /// Latest fatigue score (0-100).
  final double? fatigue;

  /// Derived fatigue band.
  final FatigueBand fatigueBand;

  /// COROS training load state label (e.g. "Optimal", "High", "Very High").
  final String? loadState;

  /// Training load ratio (ATI/CTI, i.e. ACWR).
  final double? loadRatio;

  /// Last 7 days sleep total (seconds per day), oldest → newest.
  /// May be empty if no sleep data available.
  final List<double>? sleepHistory;

  /// Date of the most-recent health record used.
  final String? dataDate;

  static const empty = HealthOverview(fatigueBand: FatigueBand.normal);
}
