/// TimeseriesChart — fl_chart line chart wrapper for HR and pace series.
///
/// Lazily triggered once the widget enters the viewport via [VisibilityDetector]
/// simulation using [_LazyLoader]. Calls [timeseriesProvider] on first build.
library;

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/tokens.dart';
import '../models/timeseries_data.dart';
import '../providers/timeseries_provider.dart';
import '../utils/pace_format.dart';

enum ChartField { hr, pace }

class TimeseriesChart extends ConsumerStatefulWidget {
  const TimeseriesChart({
    super.key,
    required this.activityId,
    required this.field,
    this.color,
  });

  final String activityId;
  final ChartField field;
  final Color? color;

  @override
  ConsumerState<TimeseriesChart> createState() => _TimeseriesChartState();
}

class _TimeseriesChartState extends ConsumerState<TimeseriesChart> {
  // Start loading immediately. The provider is autoDispose so resources
  // are released when the widget leaves the tree.
  // True viewport-triggered lazy-load is a future enhancement (M1.x).
  final bool _shouldLoad = true;

  @override
  Widget build(BuildContext context) {
    if (!_shouldLoad) {
      return const _ChartPlaceholder(message: '加载中...');
    }

    final fieldStr = widget.field == ChartField.hr ? 'hr' : 'pace';
    final params = (id: widget.activityId, fields: fieldStr);
    final async = ref.watch(timeseriesProvider(params));

    return async.when(
      loading: () => const _ChartPlaceholder(message: '加载中...'),
      error: (_, _) => const _ChartPlaceholder(message: '暂无数据'),
      data: (data) => _buildChart(data),
    );
  }

  Widget _buildChart(TimeseriesData data) {
    final List<num?>? rawSeries = widget.field == ChartField.hr
        ? data.series.hr
        : data.series.pace;

    if (rawSeries == null || rawSeries.isEmpty) {
      return const _ChartPlaceholder(message: '暂无数据');
    }

    // Filter out nulls; build FlSpot list.
    // For pace charts, negate Y so that fast (low s/km) appears HIGH on the
    // chart axis and slow (high s/km) appears LOW — matching runner intuition.
    final isPace = widget.field == ChartField.pace;
    final spots = <FlSpot>[];
    for (var i = 0; i < rawSeries.length; i++) {
      final v = rawSeries[i];
      if (v != null && v > 0) {
        final x = i * data.intervalSec;
        final y = isPace ? -v.toDouble() : v.toDouble();
        spots.add(FlSpot(x, y));
      }
    }

    if (spots.isEmpty) return const _ChartPlaceholder(message: '暂无数据');

    final color =
        widget.color ??
        (widget.field == ChartField.hr
            ? StrideTokens.danger
            : StrideTokens.accent);
    final allY = spots.map((s) => s.y).toList();
    final rawMinY = allY.reduce((a, b) => a < b ? a : b);
    final rawMaxY = allY.reduce((a, b) => a > b ? a : b);
    final yPadding = ((rawMaxY - rawMinY).abs() * 0.05).clamp(
      1.0,
      double.infinity,
    );
    final minY = (rawMinY - yPadding).floorToDouble();
    final maxY = (rawMaxY + yPadding).ceilToDouble();
    final avgY = allY.reduce((a, b) => a + b) / allY.length;

    // X axis: seconds → minutes ticks derived from total duration.
    final maxX = spots.last.x;
    final totalMinutes = maxX / 60.0;
    final xInterval = _xTickIntervalSec(totalMinutes);

    return SizedBox(
      height: 150,
      child: LineChart(
        LineChartData(
          minX: 0,
          maxX: maxX,
          minY: minY,
          maxY: maxY,
          gridData: FlGridData(
            show: true,
            drawVerticalLine: false,
            horizontalInterval: (maxY - minY) / 4,
            getDrawingHorizontalLine: (_) =>
                const FlLine(color: StrideTokens.grid, strokeWidth: 1),
          ),
          // Axis baseline: left + bottom border in muted color.
          borderData: FlBorderData(
            show: true,
            border: const Border(
              left: BorderSide(color: StrideTokens.border, width: 1),
              bottom: BorderSide(color: StrideTokens.border, width: 1),
            ),
          ),
          titlesData: FlTitlesData(
            leftTitles: AxisTitles(
              sideTitles: SideTitles(
                showTitles: true,
                reservedSize: 36,
                interval: (maxY - minY) / 4,
                getTitlesWidget: (val, _) => Text(
                  widget.field == ChartField.pace
                      ? _fmtPace(-val.toInt())
                      : val.toInt().toString(),
                  style: const TextStyle(
                    fontFamily: AppTypography.fontMono,
                    fontSize: StrideTokens.fs10,
                    color: StrideTokens.muted,
                  ),
                ),
              ),
            ),
            bottomTitles: AxisTitles(
              sideTitles: SideTitles(
                showTitles: true,
                reservedSize: 18,
                interval: xInterval,
                getTitlesWidget: (val, meta) {
                  // Skip the very last overflow label past the data range.
                  if (val > maxX + 1) return const SizedBox.shrink();
                  return Text(
                    '${(val / 60).round()}',
                    style: const TextStyle(
                      fontFamily: AppTypography.fontMono,
                      fontSize: StrideTokens.fs10,
                      color: StrideTokens.muted,
                    ),
                  );
                },
              ),
            ),
            topTitles: const AxisTitles(
              sideTitles: SideTitles(showTitles: false),
            ),
            rightTitles: const AxisTitles(
              sideTitles: SideTitles(showTitles: false),
            ),
          ),
          // Red dashed horizontal average line.
          extraLinesData: ExtraLinesData(
            horizontalLines: [
              HorizontalLine(
                y: avgY,
                color: StrideTokens.danger,
                strokeWidth: 1,
                dashArray: [4, 3],
              ),
            ],
          ),
          lineTouchData: LineTouchData(
            enabled: true,
            getTouchedSpotIndicator: (_, spotIndexes) => spotIndexes
                .map(
                  (_) => TouchedSpotIndicatorData(
                    const FlLine(
                      color: StrideTokens.muted,
                      strokeWidth: 1,
                      dashArray: [4, 3],
                    ),
                    FlDotData(
                      show: true,
                      getDotPainter: (_, __, ___, ____) => FlDotCirclePainter(
                        radius: 4,
                        color: color,
                        strokeWidth: 1.5,
                        strokeColor: StrideTokens.bg,
                      ),
                    ),
                  ),
                )
                .toList(),
            touchTooltipData: LineTouchTooltipData(
              getTooltipColor: (_) => StrideTokens.surface,
              tooltipBorder: const BorderSide(
                color: StrideTokens.border,
                width: 1,
              ),
              tooltipRoundedRadius: 6,
              getTooltipItems: (touchedSpots) => touchedSpots.map((spot) {
                final timeSec = spot.x.round();
                final valueStr = isPace
                    ? fmtPaceSeconds(-spot.y.round())
                    : '${spot.y.round()}';
                return LineTooltipItem(
                  '${_fmtElapsed(timeSec)}\n',
                  const TextStyle(
                    fontFamily: AppTypography.fontMono,
                    fontSize: StrideTokens.fs10,
                    color: StrideTokens.muted,
                    height: 1.6,
                  ),
                  children: [
                    TextSpan(
                      text: valueStr,
                      style: TextStyle(
                        fontFamily: AppTypography.fontMono,
                        fontSize: StrideTokens.fs13,
                        fontWeight: FontWeight.w700,
                        color: color,
                      ),
                    ),
                  ],
                );
              }).toList(),
            ),
          ),
          // TODO(M1.x): zone-gradient line coloring (out of scope this pass).
          lineBarsData: [
            LineChartBarData(
              spots: spots,
              isCurved: true,
              curveSmoothness: 0.25,
              color: color,
              barWidth: 1.5,
              dotData: const FlDotData(show: false),
              belowBarData: BarAreaData(
                show: true,
                color: color.withValues(alpha: 0.08),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// Choose a sensible minutes tick spacing (returned in seconds) so the X
  /// axis shows ~4 ticks regardless of run length.
  double _xTickIntervalSec(double totalMinutes) {
    if (totalMinutes <= 0) return 60;
    final rawMin = totalMinutes / 4;
    const steps = [1, 5, 10, 15, 20, 30, 60];
    var minutes = steps.last;
    for (final s in steps) {
      if (s >= rawMin) {
        minutes = s;
        break;
      }
    }
    return minutes * 60.0;
  }

  String _fmtPace(int secPerKm) {
    final m = secPerKm ~/ 60;
    final s = secPerKm % 60;
    return '$m:${s.toString().padLeft(2, '0')}';
  }

  // Tooltip: elapsed time as hh:mm:ss or mm:ss
  String _fmtElapsed(int totalSec) {
    final h = totalSec ~/ 3600;
    final m = (totalSec % 3600) ~/ 60;
    final s = totalSec % 60;
    final mm = m.toString().padLeft(2, '0');
    final ss = s.toString().padLeft(2, '0');
    return h > 0 ? '$h:$mm:$ss' : '$mm:$ss';
  }
}

class _ChartPlaceholder extends StatelessWidget {
  const _ChartPlaceholder({required this.message});
  final String message;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 80,
      child: Center(
        child: Text(
          message,
          style: const TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs13,
            color: StrideTokens.muted,
          ),
        ),
      ),
    );
  }
}
