/// E3 — 趋势详情屏幕 (Health Trends).
///
/// Supports 2 universal-sensor dimensions (HRV/RHR) × 3 time ranges
/// (7/30/90天). Vendor-proprietary fatigue and COROS training_load_ratio
/// series are intentionally excluded. (COROS does not expose sleep duration
/// via its API, so no 睡眠 dimension.)
/// Data from `GET /api/{user}/health?days=N` via [trendsProvider].
library;

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../../data/models/health.dart';
import '../_shared/widgets/refreshable.dart';
import '../_shared/widgets/seg_control.dart';
import '../_shared/widgets/stat_row.dart';
import '../_shared/widgets/sync_icon.dart';
import '../_shared/widgets/top_bar.dart';
import 'providers/trends_provider.dart';

// ── Dimension config ──────────────────────────────────────────────────────────

enum _TrendDim {
  hrv,
  rhr;

  String get label {
    switch (this) {
      case _TrendDim.hrv:
        return 'HRV';
      case _TrendDim.rhr:
        return 'RHR';
    }
  }

  String get unit {
    switch (this) {
      case _TrendDim.hrv:
        return 'ms';
      case _TrendDim.rhr:
        return 'bpm';
    }
  }

  double? extract(HealthRecord r) {
    switch (this) {
      case _TrendDim.hrv:
        return null; // hrv is in snapshot, not per-record; skip
      case _TrendDim.rhr:
        return r.rhr?.toDouble();
    }
  }

  String format(double v) {
    switch (this) {
      case _TrendDim.hrv:
        return v.toStringAsFixed(0);
      case _TrendDim.rhr:
        return v.toStringAsFixed(0);
    }
  }
}

const _kDims = _TrendDim.values;
const _kRangeLabels = ['7天', '30天', '90天'];
const _kRangeDays = [7, 30, 90];

// ── Screen ────────────────────────────────────────────────────────────────────

class TrendsScreen extends ConsumerStatefulWidget {
  const TrendsScreen({super.key});

  @override
  ConsumerState<TrendsScreen> createState() => _TrendsScreenState();
}

class _TrendsScreenState extends ConsumerState<TrendsScreen> {
  int _dimIndex = 0;
  int _rangeIndex = 1; // default 30 days

  _TrendDim get _dim => _kDims[_dimIndex];
  int get _days => _kRangeDays[_rangeIndex];

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(trendsProvider(_days));

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: const StrideTopBar(title: '趋势详情', actions: [SyncIconButton()]),
      body: Column(
        children: [
          // ── Dimension seg ─────────────────────────────────────────────────
          Padding(
            padding: const EdgeInsets.fromLTRB(
              StrideTokens.spaceLg,
              StrideTokens.spaceMd,
              StrideTokens.spaceLg,
              0,
            ),
            child: StrideSegControl(
              options: _kDims.map((d) => d.label).toList(),
              selectedIndex: _dimIndex,
              onChanged: (i) => setState(() => _dimIndex = i),
            ),
          ),
          const SizedBox(height: StrideTokens.spaceSm),
          // ── Range seg ─────────────────────────────────────────────────────
          Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: StrideTokens.spaceLg,
            ),
            child: StrideSegControl(
              options: _kRangeLabels,
              selectedIndex: _rangeIndex,
              onChanged: (i) {
                setState(() => _rangeIndex = i);
                ref.invalidate(trendsProvider(_kRangeDays[i]));
              },
            ),
          ),
          // ── Body ──────────────────────────────────────────────────────────
          Expanded(
            child: async.when(
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (e, _) => _ErrorView(message: e.toString()),
              data: (records) =>
                  _TrendsBody(records: records, dim: _dim, days: _days),
            ),
          ),
        ],
      ),
    );
  }
}

// ── Body ──────────────────────────────────────────────────────────────────────

class _TrendsBody extends StatelessWidget {
  const _TrendsBody({
    required this.records,
    required this.dim,
    required this.days,
  });

  final List<HealthRecord> records;
  final _TrendDim dim;
  final int days;

  @override
  Widget build(BuildContext context) {
    // records are newest-first; extract dim values in order (oldest→newest).
    final ordered = records.reversed.toList();
    final values = ordered.map((r) => dim.extract(r)).toList();

    // Compute stats.
    final nonNull = values.whereType<double>().toList();
    final current = nonNull.isNotEmpty ? nonNull.last : null;
    final avg7 = _avg(
      values.length > 7 ? values.sublist(values.length - 7) : values,
    );
    final trend = _trendArrow(values);

    return StrideRefreshable<List<HealthRecord>>(
      provider: trendsProvider(days).future,
      child: ListView(
        padding: const EdgeInsets.all(StrideTokens.spaceLg),
        children: [
          _ChartCard(values: values, dim: dim),
          const SizedBox(height: StrideTokens.spaceLg),
          _StatsCard(dim: dim, current: current, avg7: avg7, trend: trend),
          const SizedBox(height: StrideTokens.spaceXl),
        ],
      ),
    );
  }

  static double? _avg(List<double?> vals) {
    final nonNull = vals.whereType<double>().toList();
    if (nonNull.isEmpty) return null;
    return nonNull.reduce((a, b) => a + b) / nonNull.length;
  }

  static String _trendArrow(List<double?> vals) {
    final nonNull = vals.whereType<double>().toList();
    if (nonNull.length < 3) return '—';
    final recent = nonNull.sublist(nonNull.length - 3);
    final older = nonNull.sublist(
      nonNull.length - (nonNull.length >= 7 ? 7 : nonNull.length),
      nonNull.length - 3,
    );
    if (older.isEmpty) return '—';
    final avgRecent = recent.reduce((a, b) => a + b) / recent.length;
    final avgOlder = older.reduce((a, b) => a + b) / older.length;
    final diff = avgRecent - avgOlder;
    if (diff.abs() < 0.5) return '→';
    return diff > 0 ? '↑' : '↓';
  }
}

// ── Chart card ────────────────────────────────────────────────────────────────

class _ChartCard extends StatelessWidget {
  const _ChartCard({required this.values, required this.dim});

  final List<double?> values;
  final _TrendDim dim;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(
                dim.label,
                style: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs14,
                  fontWeight: FontWeight.w500,
                  color: StrideTokens.fg,
                ),
              ),
              const SizedBox(width: StrideTokens.spaceXs),
              Text(
                dim.unit,
                style: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs12,
                  color: StrideTokens.muted,
                ),
              ),
            ],
          ),
          const SizedBox(height: StrideTokens.spaceMd),
          SizedBox(
            height: 180,
            child: values.every((v) => v == null)
                ? const _NoDataPlaceholder()
                : _TrendsLineChart(values: values, dim: dim),
          ),
        ],
      ),
    );
  }
}

class _NoDataPlaceholder extends StatelessWidget {
  const _NoDataPlaceholder();

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: StrideTokens.bg,
        borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
      ),
      child: const Center(
        child: Text(
          '该维度暂无数据',
          style: TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs13,
            color: StrideTokens.muted,
          ),
        ),
      ),
    );
  }
}

class _TrendsLineChart extends StatelessWidget {
  const _TrendsLineChart({required this.values, required this.dim});

  final List<double?> values;
  final _TrendDim dim;

  @override
  Widget build(BuildContext context) {
    // Build spots — skip null values (gaps in data).
    final spots = <FlSpot>[];
    for (int i = 0; i < values.length; i++) {
      final v = values[i];
      if (v != null) spots.add(FlSpot(i.toDouble(), v));
    }

    if (spots.isEmpty) return const _NoDataPlaceholder();

    final ys = spots.map((s) => s.y).toList();
    final minY = (ys.reduce((a, b) => a < b ? a : b) * 0.9).floorToDouble();
    final maxY = (ys.reduce((a, b) => a > b ? a : b) * 1.1).ceilToDouble();

    return LineChart(
      LineChartData(
        minY: minY,
        maxY: maxY,
        clipData: const FlClipData.all(),
        gridData: FlGridData(
          show: true,
          drawVerticalLine: false,
          getDrawingHorizontalLine: (_) => const FlLine(
            color: StrideTokens.grid,
            strokeWidth: 1,
            dashArray: [4, 4],
          ),
        ),
        borderData: FlBorderData(show: false),
        titlesData: FlTitlesData(
          leftTitles: AxisTitles(
            sideTitles: SideTitles(
              showTitles: true,
              reservedSize: 36,
              getTitlesWidget: (val, meta) => Text(
                dim.format(val),
                style: const TextStyle(
                  fontFamily: AppTypography.fontMono,
                  fontSize: StrideTokens.fs10,
                  color: StrideTokens.muted,
                ),
              ),
            ),
          ),
          rightTitles: const AxisTitles(
            sideTitles: SideTitles(showTitles: false),
          ),
          topTitles: const AxisTitles(
            sideTitles: SideTitles(showTitles: false),
          ),
          bottomTitles: const AxisTitles(
            sideTitles: SideTitles(showTitles: false),
          ),
        ),
        lineTouchData: LineTouchData(
          touchTooltipData: LineTouchTooltipData(
            getTooltipColor: (_) => StrideTokens.surface,
            tooltipBorder: const BorderSide(color: StrideTokens.border2),
            getTooltipItems: (spots) => spots.map((s) {
              return LineTooltipItem(
                '${dim.format(s.y)} ${dim.unit}',
                const TextStyle(
                  fontFamily: AppTypography.fontMono,
                  fontSize: StrideTokens.fs11,
                  color: StrideTokens.accent,
                  fontWeight: FontWeight.w500,
                ),
              );
            }).toList(),
          ),
        ),
        lineBarsData: [
          LineChartBarData(
            spots: spots,
            isCurved: true,
            curveSmoothness: 0.3,
            color: StrideTokens.accent,
            barWidth: 2,
            dotData: FlDotData(
              show: spots.length <= 14,
              getDotPainter: (_, _, _, _) => FlDotCirclePainter(
                radius: 3,
                color: StrideTokens.accent,
                strokeWidth: 0,
                strokeColor: Colors.transparent,
              ),
            ),
            belowBarData: BarAreaData(
              show: true,
              color: StrideTokens.accent.withAlpha(20),
            ),
          ),
        ],
      ),
    );
  }
}

// ── Stats card ────────────────────────────────────────────────────────────────

class _StatsCard extends StatelessWidget {
  const _StatsCard({
    required this.dim,
    required this.current,
    required this.avg7,
    required this.trend,
  });

  final _TrendDim dim;
  final double? current;
  final double? avg7;
  final String trend;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: StrideStatRow(
        items: [
          StatItem(
            label: '当前值',
            value: current != null ? dim.format(current!) : '—',
            unit: dim.unit,
          ),
          StatItem(
            label: '7日均',
            value: avg7 != null ? dim.format(avg7!) : '—',
            unit: dim.unit,
          ),
          StatItem(label: '趋势', value: trend),
        ],
      ),
    );
  }
}

// ── Error view ────────────────────────────────────────────────────────────────

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(StrideTokens.space2xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(
              Icons.error_outline,
              size: 40,
              color: StrideTokens.muted,
            ),
            const SizedBox(height: StrideTokens.spaceMd),
            const Text(
              '加载失败',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs15,
                fontWeight: FontWeight.w500,
                color: StrideTokens.fg,
              ),
            ),
            const SizedBox(height: StrideTokens.spaceXs),
            Text(
              message,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs12,
                color: StrideTokens.muted,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
