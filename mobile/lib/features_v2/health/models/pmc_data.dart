/// PmcData — derived model for the E2 PMC screen.
///
/// Wraps the `/pmc?days=N` response into a flat model the screen can
/// consume directly.  [PmcPoint] mirrors the backend `PMCRecord` fields;
/// [PmcSummary] re-uses the backend `PMCSummary` values.
library;

import '../../../data/models/health.dart';

/// One data-point on the PMC chart.
///
/// ATL/CTL are STRIDE-computed acute/chronic load (from `daily_training_load`),
/// NOT COROS `ati/cti`. TSB (form) = CTL − ATL, also STRIDE-derived.
class PmcPoint {
  factory PmcPoint.fromStride(PMCStrideRecord r) {
    final atl = r.acuteLoad?.toDouble() ?? 0.0;
    final ctl = r.chronicLoad?.toDouble() ?? 0.0;
    // Prefer the stored STRIDE form; fall back to chronic − acute.
    final tsb = r.form?.toDouble() ?? (ctl - atl);
    return PmcPoint(date: r.date, atl: atl, ctl: ctl, tsb: tsb);
  }
  const PmcPoint({
    required this.date,
    required this.atl,
    required this.ctl,
    required this.tsb,
  });

  /// ISO date string, e.g. "2026-05-12".
  final String date;

  /// STRIDE acute load (ATL).
  final double atl;

  /// STRIDE chronic load (CTL).
  final double ctl;

  /// STRIDE form (Training Stress Balance) = CTL − ATL.
  final double tsb;
}

/// TSB zone classification for display.
enum TsbZone {
  raceReady, // TSB  10 ..  25
  transitional, // TSB -10 ..  10
  productive, // TSB -30 .. -10
  overload, // TSB      < -30
  detraining; // TSB       > 25

  static TsbZone from(double tsb) {
    if (tsb > 25) return TsbZone.detraining;
    if (tsb >= 10) return TsbZone.raceReady;
    if (tsb >= -10) return TsbZone.transitional;
    if (tsb >= -30) return TsbZone.productive;
    return TsbZone.overload;
  }

  String get label {
    switch (this) {
      case TsbZone.raceReady:
        return '比赛就绪';
      case TsbZone.transitional:
        return '过渡区';
      case TsbZone.productive:
        return '正常训练';
      case TsbZone.overload:
        return '过度负荷';
      case TsbZone.detraining:
        return '减量过多';
    }
  }

  String get interpretation {
    switch (this) {
      case TsbZone.raceReady:
        return '状态峰值区间，适合比赛或高质量测试。保持轻量维护性训练，避免大量消耗。';
      case TsbZone.transitional:
        return '负荷与恢复基本平衡，适合维持训练。可适当增加强度或量来推动进步。';
      case TsbZone.productive:
        return '正处于有效训练压力区间，体能正在积累。确保每晚充足睡眠与蛋白质摄入。';
      case TsbZone.overload:
        return '训练压力过高，建议主动减量恢复（低强度跑或完全休息），避免受伤风险。';
      case TsbZone.detraining:
        return '减量过多，体能可能下滑。在恢复充分的前提下适当增加训练量。';
    }
  }
}

/// Aggregated summary for the current state.
class PmcSummary {
  /// Build the summary from STRIDE-computed values (`stride_summary`).
  /// TSB/form, ATL, CTL all come from STRIDE — not COROS ati/cti.
  factory PmcSummary.fromStride(PMCStrideSummary s) {
    final atl = s.currentAcuteLoad?.toDouble();
    final ctl = s.currentChronicLoad?.toDouble();
    final tsb =
        s.currentForm?.toDouble() ??
        ((atl != null && ctl != null) ? ctl - atl : null);
    return PmcSummary(
      currentAtl: atl,
      currentCtl: ctl,
      currentTsb: tsb,
      tsbZone: tsb != null ? TsbZone.from(tsb) : null,
    );
  }
  const PmcSummary({
    this.currentAtl,
    this.currentCtl,
    this.currentTsb,
    this.tsbZone,
  });

  final double? currentAtl;
  final double? currentCtl;
  final double? currentTsb;
  final TsbZone? tsbZone;
}

/// Top-level model passed from provider → screen.
class PmcData {
  const PmcData({required this.points, required this.summary});

  final List<PmcPoint> points;
  final PmcSummary summary;

  static const empty = PmcData(points: [], summary: PmcSummary());
}
