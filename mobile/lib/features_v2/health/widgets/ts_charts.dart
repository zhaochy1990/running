/// 训练状态页图表 —— uCharts→fl_chart 映射（#423/#465 口径）：
///   line straight width2 → LineChart barWidth 2、无点
///   column 逐点色 → BarChart 每 rod 单独 color
///   tooltip 深色盒 #101111 / 文字 #e3e2e5
///   x 轴约 3 个 label；y 网格 splitNumber 4（虚线）
library;

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';

import '../../../../core/theme/app_typography.dart';
import '../../../../core/theme/tokens.dart';

const _tooltipBg = Color(0xFF101111);
const _tooltipFg = Color(0xFFE3E2E5);
const _axisLabel = TextStyle(
  fontFamily: AppTypography.fontSans,
  fontSize: 10,
  color: StrideTokens.muted,
);

/// 折线序列；values 中 null → FlSpot.nullSpot（断线缺口，同 uCharts）。
class TsLineSeries {
  const TsLineSeries({
    required this.name,
    required this.color,
    required this.values,
  });

  final String name;
  final Color color;
  final List<double?> values;
}

class TsLineChart extends StatelessWidget {
  const TsLineChart({
    super.key,
    required this.labels,
    required this.series,
    required this.minY,
    required this.maxY,
    this.height = 160,
    this.tooltipLines,
  });

  final List<String> labels;
  final List<TsLineSeries> series;
  final double minY;
  final double maxY;
  final double height;

  /// 覆盖默认 tooltip 文案：tooltipLines[i] = x=i 处的行列表（首行为表头 label）。
  final List<List<String>>? tooltipLines;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: height,
      child: LineChart(
        LineChartData(
          minY: minY,
          maxY: maxY,
          minX: 0,
          maxX: (labels.length - 1).toDouble(),
          gridData: FlGridData(
            show: true,
            drawVerticalLine: false,
            horizontalInterval: (maxY - minY) / 4,
            getDrawingHorizontalLine: (_) => const FlLine(
              color: StrideTokens.grid,
              strokeWidth: 1,
              dashArray: [4, 4],
            ),
          ),
          titlesData: FlTitlesData(
            topTitles: const AxisTitles(),
            rightTitles: const AxisTitles(),
            leftTitles: AxisTitles(
              sideTitles: SideTitles(
                showTitles: true,
                reservedSize: 34,
                interval: (maxY - minY) / 4,
                getTitlesWidget: _leftTitle,
              ),
            ),
            bottomTitles: AxisTitles(
              sideTitles: SideTitles(
                showTitles: true,
                reservedSize: 18,
                interval: 1,
                getTitlesWidget: _bottomTitle,
              ),
            ),
          ),
          borderData: FlBorderData(show: false),
          lineBarsData: [
            for (final s in series)
              LineChartBarData(
                spots: [
                  for (var i = 0; i < s.values.length; i++)
                    s.values[i] == null
                        ? FlSpot.nullSpot
                        : FlSpot(i.toDouble(), s.values[i]!),
                ],
                barWidth: 2,
                color: s.color,
                dotData: const FlDotData(show: false),
                isStrokeCapRound: false,
              ),
          ],
          lineTouchData: LineTouchData(
            touchTooltipData: LineTouchTooltipData(
              getTooltipColor: (_) => _tooltipBg,
              tooltipRoundedRadius: 6,
              getTooltipItems: (spots) => [
                for (final spot in spots)
                  LineTooltipItem(
                    _tooltipText(spot.x.round(), spot.barIndex),
                    TextStyle(
                      color: series[spot.barIndex].color,
                      fontSize: 11,
                      fontFamily: AppTypography.fontSans,
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  String _tooltipText(int x, int barIndex) {
    final lines = tooltipLines?[x];
    if (lines != null && barIndex < lines.length) return lines[barIndex];
    final v = series[barIndex].values[x];
    return '${series[barIndex].name} ${v == null ? '—' : _num(v)}';
  }

  Widget _bottomTitle(double value, TitleMeta meta) {
    final i = value.round();
    // x 轴约 3 个 label（uCharts labelCount 3 口径）。
    final step = labels.length <= 3 ? 1 : (labels.length / 3).ceil();
    if (i % step != 0 || i >= labels.length) {
      return const SizedBox.shrink();
    }
    return SideTitleWidget(
      axisSide: meta.axisSide,
      child: Text(labels[i], style: _axisLabel),
    );
  }

  Widget _leftTitle(double value, TitleMeta meta) =>
      SideTitleWidget(
        axisSide: meta.axisSide,
        child: Text(_num(value), style: _axisLabel),
      );
}

/// 柱状图；values null → 无 rod（缺口），colors 逐点配色（Form 五档）。
class TsColumnChart extends StatelessWidget {
  const TsColumnChart({
    super.key,
    required this.labels,
    required this.values,
    required this.colors,
    required this.minY,
    required this.maxY,
    this.height = 140,
    this.tooltip,
  });

  final List<String> labels;
  final List<double?> values;
  final List<Color> colors;
  final double minY;
  final double maxY;
  final double height;

  /// x=i 处的 tooltip 文案（缺省「label · value」）。
  final String Function(int index, double value)? tooltip;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: height,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final slot = constraints.maxWidth / (values.length + 1);
          final rodWidth = (slot * 0.72).clamp(2.0, 18.0);
          return BarChart(
            BarChartData(
              minY: minY,
              maxY: maxY,
              alignment: BarChartAlignment.spaceEvenly,
              gridData: FlGridData(
                show: true,
                drawVerticalLine: false,
                horizontalInterval: (maxY - minY) / 4,
                getDrawingHorizontalLine: (_) => const FlLine(
                  color: StrideTokens.grid,
                  strokeWidth: 1,
                  dashArray: [4, 4],
                ),
              ),
              titlesData: FlTitlesData(
                topTitles: const AxisTitles(),
                rightTitles: const AxisTitles(),
                leftTitles: AxisTitles(
                  sideTitles: SideTitles(
                    showTitles: true,
                    reservedSize: 34,
                    interval: (maxY - minY) / 4,
                    getTitlesWidget: _leftTitle,
                  ),
                ),
                bottomTitles: AxisTitles(
                  sideTitles: SideTitles(
                    showTitles: true,
                    reservedSize: 18,
                    interval: 1,
                    getTitlesWidget: _bottomTitle,
                  ),
                ),
              ),
              borderData: FlBorderData(show: false),
              barTouchData: BarTouchData(
                touchTooltipData: BarTouchTooltipData(
                  getTooltipColor: (_) => _tooltipBg,
                  tooltipRoundedRadius: 6,
                  getTooltipItem: (group, _, rod, _) => BarTooltipItem(
                    tooltip?.call(group.x, rod.toY) ??
                        '${labels[group.x]} · ${_num(rod.toY)}',
                    const TextStyle(
                      color: _tooltipFg,
                      fontSize: 11,
                      fontFamily: AppTypography.fontSans,
                    ),
                  ),
                ),
              ),
              barGroups: [
                for (var i = 0; i < values.length; i++)
                  BarChartGroupData(
                    x: i,
                    barRods: [
                      if (values[i] != null)
                        BarChartRodData(
                          toY: values[i]!,
                          color: colors[i],
                          width: rodWidth,
                          borderRadius: BorderRadius.circular(2),
                        ),
                    ],
                  ),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _bottomTitle(double value, TitleMeta meta) {
    final i = value.round();
    final step = labels.length <= 3 ? 1 : (labels.length / 3).ceil();
    if (i % step != 0 || i >= labels.length) return const SizedBox.shrink();
    return SideTitleWidget(
      axisSide: meta.axisSide,
      child: Text(labels[i], style: _axisLabel),
    );
  }

  Widget _leftTitle(double value, TitleMeta meta) => SideTitleWidget(
        axisSide: meta.axisSide,
        child: Text(_num(value), style: _axisLabel),
      );
}

String _num(double v) =>
    v.abs() >= 100 ? v.round().toString() : v.toStringAsFixed(1);
