/// TimeseriesChart — fl_chart line chart wrapper for HR and pace series.
///
/// 数据来自 detail `?include=timeseries`（timeseriesProvider，与轨迹地图共用
/// 一份）。HR 线按 zones 档位色分段着色（#422：收掉旧 TODO 的渐变缺口），
/// 配速线保持单色。X 轴 = timeseries timestamp（厘秒）换算的经过秒。
library;

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/tokens.dart';
import '../models/activity_detail.dart';
import '../providers/activity_detail_provider.dart';
import '../providers/timeseries_provider.dart';
import '../utils/pace_format.dart';
import '../utils/track.dart';

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
  @override
  Widget build(BuildContext context) {
    final async = ref.watch(timeseriesProvider(widget.activityId));
    final zones = ref
        .watch(activityDetailProvider(widget.activityId))
        .valueOrNull
        ?.zones;

    return async.when(
      loading: () => const _ChartPlaceholder(message: '加载中...'),
      error: (_, _) => const _ChartPlaceholder(message: '暂无数据'),
      data: (points) => _buildChart(points, zones ?? const []),
    );
  }

  Widget _buildChart(List<TsPoint> points, List<ZoneV2> zones) {
    final isHr = widget.field == ChartField.hr;
    final values = <double>[];
    final elapsed = <double>[];
    num? t0;
    for (final p in points) {
      if (p.timestamp != null) {
        t0 ??= p.timestamp;
        break;
      }
    }
    for (final p in points) {
      final v = isHr ? p.hr : p.pace;
      if (v == null || v <= 0) continue;
      values.add(v.toDouble());
      elapsed.add(
        t0 != null && p.timestamp != null
            ? ((p.timestamp! - t0) / 100).toDouble()
            : elapsed.isEmpty
                ? 0
                : elapsed.last + 1,
      );
    }
    if (values.isEmpty) return const _ChartPlaceholder(message: '暂无数据');

    // 配速轴反转(-v)：快（小 s/km）在上、慢在下，符合跑者直觉。
    final spots = <FlSpot>[
      for (var i = 0; i < values.length; i++)
        FlSpot(elapsed[i], isHr ? values[i] : -values[i]),
    ];

    final color =
        widget.color ??
        (isHr ? StrideTokens.danger : StrideTokens.accent);
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
                      getDotPainter: (spot, percent, bar, index) =>
                          FlDotCirclePainter(
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
                final valueStr = isHr
                    ? '${spot.y.round()}'
                    : fmtPaceSeconds(-spot.y.round());
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
          lineBarsData: [
            LineChartBarData(
              spots: spots,
              isCurved: true,
              curveSmoothness: 0.25,
              gradient: isHr ? _hrZoneGradient(spots, zones) : null,
              color: isHr ? null : color,
              barWidth: 1.5,
              dotData: const FlDotData(show: false),
              belowBarData: BarAreaData(
                show: true,
                color: color.withValues(alpha: 0.06),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// HR 曲线的 zones 档位色渐变：每个点按心率所在区间取 zoneColors 档位色，
  /// 颜色切换处在相邻两点中点做硬边界（duplicate stop），整条线一个 bar。
  LinearGradient? _hrZoneGradient(List<FlSpot> spots, List<ZoneV2> zones) {
    final hrZones = [
      ...zones.where((z) => z.zoneType == 'heartRate'),
    ]..sort((a, b) => a.zoneIndex.compareTo(b.zoneIndex));
    // 区间缺范围数据时无从分档，退回单色。
    if (hrZones.isEmpty || hrZones.any((z) => z.rangeMin == null)) return null;

    Color bucket(double v) {
      // 取 rangeMin <= v 的最大档（最高区开放高边）；低于最小档归最低区。
      var idx = 0;
      for (var i = 0; i < hrZones.length; i++) {
        if (v >= hrZones[i].rangeMin!) idx = i;
      }
      return zoneColors[idx.clamp(0, zoneColors.length - 1)];
    }

    final colors = <Color>[bucket(spots.first.y)];
    final stops = <double>[0.0];
    for (var i = 1; i < spots.length; i++) {
      final c = bucket(spots[i].y);
      if (c != colors.last) {
        final span = spots.last.x - spots.first.x;
        final boundary =
            span > 0 ? ((spots[i - 1].x + spots[i].x) / 2 - spots.first.x) / span : 0.0;
        stops..add(boundary)..add(boundary);
        colors..add(colors.last)..add(c);
      }
    }
    stops.add(1.0);
    colors.add(colors.last);
    return LinearGradient(colors: colors, stops: stops);
  }

  double _xTickIntervalSec(double totalMinutes) {
    if (totalMinutes <= 10) return 120;
    if (totalMinutes <= 30) return 300;
    if (totalMinutes <= 60) return 600;
    return 1800;
  }

  String _fmtElapsed(int sec) {
    final m = sec ~/ 60;
    final s = sec % 60;
    return "00:${m.toString().padLeft(2, '0')}:${s.toString().padLeft(2, '0')}";
  }
}

String _fmtPace(int seconds) {
  final m = seconds ~/ 60;
  final s = seconds % 60;
  return "$m'${s.toString().padLeft(2, '0')}\"";
}

class _ChartPlaceholder extends StatelessWidget {
  const _ChartPlaceholder({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 150,
      child: Center(
        child: Text(
          message,
          style: const TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs12,
            color: StrideTokens.muted,
          ),
        ),
      ),
    );
  }
}
