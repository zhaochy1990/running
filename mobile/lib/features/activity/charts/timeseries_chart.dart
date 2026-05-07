import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_typography.dart';

/// Down-sampled line chart for HR/pace/altitude/cadence timeseries.
///
/// Uses LTTB-style stride sampling to keep chart frames < 16ms even
/// for 30-min runs (~1800 points). Target ~maxPoints samples on screen.
class TimeseriesChart extends StatelessWidget {
  const TimeseriesChart({
    required this.points,
    required this.color,
    required this.unit,
    this.invertY = false,
    this.minY,
    this.maxY,
    this.height = 160,
    this.maxPoints = 240,
    super.key,
  });

  final List<({double x, double y})> points;
  final Color color;
  final String unit;
  final bool invertY;
  final double? minY;
  final double? maxY;
  final double height;
  final int maxPoints;

  @override
  Widget build(BuildContext context) {
    if (points.isEmpty) {
      return SizedBox(
        height: height,
        child: const Center(
          child: Text('—', style: AppTypography.monoCaption),
        ),
      );
    }

    final sampled = _sample(points, maxPoints);
    final spots =
        sampled.map((p) => FlSpot(p.x, invertY ? -p.y : p.y)).toList(growable: false);

    final yValues = sampled.map((p) => p.y);
    final actualMin = minY ?? yValues.reduce((a, b) => a < b ? a : b);
    final actualMax = maxY ?? yValues.reduce((a, b) => a > b ? a : b);
    final padding = (actualMax - actualMin).abs() * 0.08;

    return SizedBox(
      height: height,
      child: LineChart(
        LineChartData(
          minX: spots.first.x,
          maxX: spots.last.x,
          minY: invertY ? -(actualMax + padding) : (actualMin - padding),
          maxY: invertY ? -(actualMin - padding) : (actualMax + padding),
          gridData: FlGridData(
            show: true,
            drawVerticalLine: false,
            horizontalInterval:
                ((actualMax - actualMin).abs() / 3).clamp(1, double.infinity),
            getDrawingHorizontalLine: (_) =>
                const FlLine(color: AppColors.gray200, strokeWidth: 0.5),
          ),
          borderData: FlBorderData(show: false),
          titlesData: FlTitlesData(
            topTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
            rightTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
            bottomTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
            leftTitles: AxisTitles(
              sideTitles: SideTitles(
                showTitles: true,
                reservedSize: 40,
                getTitlesWidget: (value, _) {
                  final v = invertY ? -value : value;
                  return Padding(
                    padding: const EdgeInsets.only(right: 4),
                    child: Text(
                      v.toStringAsFixed(0),
                      style: AppTypography.monoCaption.copyWith(fontSize: 10),
                    ),
                  );
                },
              ),
            ),
          ),
          lineBarsData: [
            LineChartBarData(
              spots: spots,
              isCurved: true,
              curveSmoothness: 0.18,
              preventCurveOverShooting: true,
              color: color,
              barWidth: 1.6,
              isStrokeCapRound: true,
              dotData: const FlDotData(show: false),
              belowBarData: BarAreaData(
                show: true,
                color: color.withValues(alpha: 0.08),
              ),
            ),
          ],
          lineTouchData: LineTouchData(
            handleBuiltInTouches: true,
            touchTooltipData: LineTouchTooltipData(
              getTooltipColor: (_) => AppColors.foreground.withValues(alpha: 0.92),
              tooltipRoundedRadius: 4,
              tooltipPadding:
                  const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              getTooltipItems: (spots) => spots.map((s) {
                final v = invertY ? -s.y : s.y;
                return LineTooltipItem(
                  '${v.toStringAsFixed(0)} $unit',
                  const TextStyle(
                    fontFamily: AppTypography.fontMono,
                    fontSize: 11,
                    color: Colors.white,
                  ),
                );
              }).toList(),
            ),
          ),
        ),
      ),
    );
  }

  /// Stride-sampling: pick every k-th point to bound rendering cost.
  /// LTTB would be more accurate but stride is good enough at this scale.
  static List<({double x, double y})> _sample(
    List<({double x, double y})> data,
    int target,
  ) {
    if (data.length <= target) return data;
    final step = data.length / target;
    final out = <({double x, double y})>[];
    for (var i = 0.0; i < data.length; i += step) {
      out.add(data[i.floor()]);
    }
    if (out.last != data.last) out.add(data.last);
    return out;
  }
}
