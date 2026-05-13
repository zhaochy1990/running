/// AbilitySnapshot — model for E4 ability radar screen.
///
/// Maps the `GET /api/{user}/ability/current` response.
/// The 6 radar dimensions are carried in [l3Dimensions] as a
/// `Map<String, double>` keyed by dimension name.
library;

/// Strength band for a single ability dimension.
enum AbilityBand {
  weak,
  medium,
  strong;

  static AbilityBand from(double? score) {
    if (score == null) return AbilityBand.weak;
    if (score < 40) return AbilityBand.weak;
    if (score < 70) return AbilityBand.medium;
    return AbilityBand.strong;
  }

  String get label {
    switch (this) {
      case AbilityBand.weak:
        return '待提升';
      case AbilityBand.medium:
        return '中等';
      case AbilityBand.strong:
        return '强';
    }
  }
}

class AbilitySnapshot {

  factory AbilitySnapshot.fromJson(Map<String, dynamic> json) {
    // l3_dimensions may come as a nested map or be absent.
    final rawDims = json['l3_dimensions'] as Map<String, dynamic>? ?? {};
    final dims = rawDims.map(
      (k, v) => MapEntry(k, (v as num?)?.toDouble() ?? 0.0),
    );

    return AbilitySnapshot(
      date: json['date'] as String? ?? '',
      source: json['source'] as String? ?? '',
      l3Dimensions: dims,
      l4Composite: (json['l4_composite'] as num?)?.toDouble(),
      l4MarathonEstimateS:
          (json['l4_marathon_estimate_s'] as num?)?.toDouble(),
      distanceToTargetS:
          (json['distance_to_target_s'] as num?)?.toDouble(),
      marathonTargetS: (json['marathon_target_s'] as num?)?.toDouble(),
      marathonTargetLabel: json['marathon_target_label'] as String?,
    );
  }
  const AbilitySnapshot({
    required this.date,
    required this.source,
    required this.l3Dimensions,
    this.l4Composite,
    this.l4MarathonEstimateS,
    this.distanceToTargetS,
    this.marathonTargetS,
    this.marathonTargetLabel,
  });

  final String date;
  final String source;

  /// Six L3 dimension scores (0–100), keyed by dimension name.
  /// Expected keys: endurance / speed / threshold / vo2max / economy / freshness
  final Map<String, double> l3Dimensions;

  /// Overall composite score (0–100).
  final double? l4Composite;

  /// Current marathon estimate in seconds.
  final double? l4MarathonEstimateS;

  /// Gap to marathon target in seconds (positive = behind target).
  final double? distanceToTargetS;

  /// User's marathon target in seconds.
  final double? marathonTargetS;

  /// Human-readable target label (e.g. "Sub-4").
  final String? marathonTargetLabel;

  static const empty = AbilitySnapshot(
    date: '',
    source: '',
    l3Dimensions: {},
  );
}

/// Display metadata for one radar dimension.
class DimensionMeta {
  const DimensionMeta({
    required this.key,
    required this.label,
    required this.suggestion,
  });

  final String key;
  final String label;
  final String suggestion;

  static const List<DimensionMeta> all = [
    DimensionMeta(
      key: 'endurance',
      label: '耐力',
      suggestion: '增加有氧长跑里程，保持 Z2 区间的稳定训练',
    ),
    DimensionMeta(
      key: 'speed',
      label: '速度',
      suggestion: '加入短距离冲刺和速度间歇，提升神经肌肉效率',
    ),
    DimensionMeta(
      key: 'threshold',
      label: '阈值',
      suggestion: '每周安排一次乳酸阈值跑，保持配速稍低于LT区间',
    ),
    DimensionMeta(
      key: 'vo2max',
      label: 'VO₂max',
      suggestion: '增加高强度间歇（4×4分钟），提升最大摄氧量',
    ),
    DimensionMeta(
      key: 'economy',
      label: '经济性',
      suggestion: '注重步频与步幅效率，加入跑步技巧训练和力量训练',
    ),
    DimensionMeta(
      key: 'freshness',
      label: '新鲜度',
      suggestion: '保持合理的训练-恢复平衡，注重睡眠和营养补充',
    ),
  ];
}
