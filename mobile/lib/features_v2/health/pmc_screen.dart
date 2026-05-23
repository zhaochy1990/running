/// E2 — PMC 训练负荷屏幕 (Performance Management Chart).
///
/// Displays ATL / CTL / TSB line chart with time-range seg control,
/// TSB zone band visualization, and a static AI interpretation card.
///
/// Data from `GET /api/{user}/pmc?days=N` via [pmcProvider].
library;

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/app_typography.dart';
import '../../core/theme/pill_colors.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/pill.dart';
import '../_shared/widgets/refreshable.dart';
import '../_shared/widgets/seg_control.dart';
import '../_shared/widgets/stat_row.dart';
import '../_shared/widgets/sync_icon.dart';
import '../_shared/widgets/top_bar.dart';
import 'models/pmc_data.dart';
import 'providers/pmc_provider.dart';

// ── Time-range options ────────────────────────────────────────────────────────

const _kRangeLabels = ['30天', '90天', '180天'];
const _kRangeDays = [30, 90, 180];

class PmcScreen extends ConsumerStatefulWidget {
  const PmcScreen({super.key});

  @override
  ConsumerState<PmcScreen> createState() => _PmcScreenState();
}

class _PmcScreenState extends ConsumerState<PmcScreen> {
  int _rangeIndex = 1; // default 90 days

  int get _days => _kRangeDays[_rangeIndex];

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(pmcProvider(_days));

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: const StrideTopBar(
        title: '训练负荷',
        actions: [SyncIconButton()],
      ),
      body: Column(
        children: [
          // ── Seg control ───────────────────────────────────────────────────
          Padding(
            padding: const EdgeInsets.fromLTRB(
              StrideTokens.spaceLg,
              StrideTokens.spaceMd,
              StrideTokens.spaceLg,
              0,
            ),
            child: StrideSegControl(
              options: _kRangeLabels,
              selectedIndex: _rangeIndex,
              onChanged: (i) {
                setState(() => _rangeIndex = i);
                ref.invalidate(pmcProvider(_kRangeDays[i]));
              },
            ),
          ),
          // ── Body ──────────────────────────────────────────────────────────
          Expanded(
            child: async.when(
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (e, _) => _ErrorView(message: e.toString()),
              data: (data) => _PmcBody(data: data, days: _days),
            ),
          ),
        ],
      ),
    );
  }
}

// ── Body ──────────────────────────────────────────────────────────────────────

class _PmcBody extends StatelessWidget {
  const _PmcBody({required this.data, required this.days});

  final PmcData data;
  final int days;

  @override
  Widget build(BuildContext context) {
    return StrideRefreshable<PmcData>(
      provider: pmcProvider(days).future,
      child: ListView(
        padding: const EdgeInsets.all(StrideTokens.spaceLg),
        children: [
          _ChartCard(data: data),
          const SizedBox(height: StrideTokens.spaceLg),
          _TsbBandCard(summary: data.summary),
          const SizedBox(height: StrideTokens.spaceLg),
          _AiCard(summary: data.summary),
          const SizedBox(height: StrideTokens.spaceXl),
        ],
      ),
    );
  }
}

// ── Chart card ────────────────────────────────────────────────────────────────

class _ChartCard extends StatelessWidget {
  const _ChartCard({required this.data});

  final PmcData data;

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
          _LegendRow(),
          const SizedBox(height: StrideTokens.spaceMd),
          SizedBox(
            height: 200,
            child: data.points.isEmpty
                ? const _ChartPlaceholder()
                : _PmcLineChart(points: data.points),
          ),
        ],
      ),
    );
  }
}

class _LegendRow extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return const Row(
      children: [
        _LegendDot(color: Color(0xFF3B82F6), label: 'ATL'),
        SizedBox(width: StrideTokens.spaceMd),
        _LegendDot(color: Color(0xFF16A34A), label: 'CTL'),
        SizedBox(width: StrideTokens.spaceMd),
        _LegendDot(color: Color(0xFFF59E0B), label: 'TSB'),
      ],
    );
  }
}

class _LegendDot extends StatelessWidget {
  const _LegendDot({required this.color, required this.label});

  final Color color;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: 4),
        Text(
          label,
          style: const TextStyle(
            fontFamily: AppTypography.fontMono,
            fontSize: StrideTokens.fs12,
            color: StrideTokens.fgSoft,
          ),
        ),
      ],
    );
  }
}

class _ChartPlaceholder extends StatelessWidget {
  const _ChartPlaceholder();

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: StrideTokens.bg,
        borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
      ),
      child: const Center(
        child: Text(
          '暂无训练负荷数据',
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

class _PmcLineChart extends StatelessWidget {
  const _PmcLineChart({required this.points});

  final List<PmcPoint> points;

  @override
  Widget build(BuildContext context) {
    final atlSpots = <FlSpot>[];
    final ctlSpots = <FlSpot>[];
    final tsbSpots = <FlSpot>[];

    for (int i = 0; i < points.length; i++) {
      final p = points[i];
      atlSpots.add(FlSpot(i.toDouble(), p.atl));
      ctlSpots.add(FlSpot(i.toDouble(), p.ctl));
      tsbSpots.add(FlSpot(i.toDouble(), p.tsb));
    }

    final allVals = [
      ...points.map((p) => p.atl),
      ...points.map((p) => p.ctl),
      ...points.map((p) => p.tsb),
    ];
    final minY = (allVals.reduce((a, b) => a < b ? a : b) - 5).floorToDouble();
    final maxY = (allVals.reduce((a, b) => a > b ? a : b) + 5).ceilToDouble();

    return LineChart(
      LineChartData(
        minY: minY,
        maxY: maxY,
        clipData: const FlClipData.all(),
        gridData: FlGridData(
          show: true,
          drawVerticalLine: false,
          horizontalInterval: 20,
          getDrawingHorizontalLine: (value) {
            final isZero = value == 0;
            return FlLine(
              color: isZero
                  ? StrideTokens.fgSoft.withAlpha(80)
                  : StrideTokens.grid,
              strokeWidth: isZero ? 1.2 : 1.0,
              dashArray: isZero ? null : [4, 4],
            );
          },
        ),
        borderData: FlBorderData(show: false),
        titlesData: FlTitlesData(
          leftTitles: AxisTitles(
            sideTitles: SideTitles(
              showTitles: true,
              reservedSize: 30,
              interval: 20,
              getTitlesWidget: (val, meta) => Text(
                val.toInt().toString(),
                style: const TextStyle(
                  fontFamily: AppTypography.fontMono,
                  fontSize: StrideTokens.fs10,
                  color: StrideTokens.muted,
                ),
              ),
            ),
          ),
          rightTitles:
              const AxisTitles(sideTitles: SideTitles(showTitles: false)),
          topTitles:
              const AxisTitles(sideTitles: SideTitles(showTitles: false)),
          bottomTitles:
              const AxisTitles(sideTitles: SideTitles(showTitles: false)),
        ),
        lineTouchData: LineTouchData(
          touchTooltipData: LineTouchTooltipData(
            getTooltipColor: (_) => StrideTokens.surface,
            tooltipBorder: const BorderSide(color: StrideTokens.border2),
            getTooltipItems: (spots) => spots.map((s) {
              final labels = ['ATL', 'CTL', 'TSB'];
              final colors = [
                const Color(0xFF3B82F6),
                const Color(0xFF16A34A),
                const Color(0xFFF59E0B),
              ];
              final idx = s.barIndex;
              return LineTooltipItem(
                '${labels[idx]}: ${s.y.toStringAsFixed(1)}',
                TextStyle(
                  fontFamily: AppTypography.fontMono,
                  fontSize: StrideTokens.fs11,
                  color: colors[idx],
                  fontWeight: FontWeight.w500,
                ),
              );
            }).toList(),
          ),
        ),
        lineBarsData: [
          _line(atlSpots, const Color(0xFF3B82F6)),
          _line(ctlSpots, const Color(0xFF16A34A)),
          _line(tsbSpots, const Color(0xFFF59E0B)),
        ],
        extraLinesData: ExtraLinesData(
          horizontalLines: [
            HorizontalLine(
              y: 20,
              color: StrideTokens.muted2.withAlpha(80),
              strokeWidth: 1,
              dashArray: [4, 4],
            ),
            HorizontalLine(
              y: -20,
              color: StrideTokens.muted2.withAlpha(80),
              strokeWidth: 1,
              dashArray: [4, 4],
            ),
          ],
        ),
      ),
    );
  }

  LineChartBarData _line(List<FlSpot> spots, Color color) {
    return LineChartBarData(
      spots: spots,
      isCurved: true,
      curveSmoothness: 0.3,
      color: color,
      barWidth: 2,
      dotData: const FlDotData(show: false),
      belowBarData: BarAreaData(show: false),
    );
  }
}

// ── TSB band card ─────────────────────────────────────────────────────────────

class _TsbBandCard extends StatelessWidget {
  const _TsbBandCard({required this.summary});

  final PmcSummary summary;

  @override
  Widget build(BuildContext context) {
    final tsb = summary.currentTsb;
    final zone = summary.tsbZone;

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
          const Text(
            'TSB 状态区间',
            style: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs14,
              fontWeight: FontWeight.w500,
              color: StrideTokens.fg,
            ),
          ),
          const SizedBox(height: StrideTokens.spaceMd),
          _BandRow(
            label: '比赛就绪',
            range: '10 ~ 25',
            zone: TsbZone.raceReady,
            current: zone,
          ),
          _BandRow(
            label: '过渡区',
            range: '-10 ~ 10',
            zone: TsbZone.transitional,
            current: zone,
          ),
          _BandRow(
            label: '正常训练',
            range: '-30 ~ -10',
            zone: TsbZone.productive,
            current: zone,
          ),
          _BandRow(
            label: '过度负荷',
            range: '< -30',
            zone: TsbZone.overload,
            current: zone,
          ),
          _BandRow(
            label: '减量过多',
            range: '> 25',
            zone: TsbZone.detraining,
            current: zone,
          ),
          const SizedBox(height: StrideTokens.spaceMd),
          StrideStatRow(
            items: [
              StatItem(label: 'ATL', value: summary.currentAtl?.toStringAsFixed(1) ?? '—'),
              StatItem(label: 'CTL', value: summary.currentCtl?.toStringAsFixed(1) ?? '—'),
              StatItem(
                label: 'TSB',
                value: tsb != null
                    ? (tsb >= 0
                        ? '+${tsb.toStringAsFixed(1)}'
                        : tsb.toStringAsFixed(1))
                    : '—',
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _BandRow extends StatelessWidget {
  const _BandRow({
    required this.label,
    required this.range,
    required this.zone,
    required this.current,
  });

  final String label;
  final String range;
  final TsbZone zone;
  final TsbZone? current;

  bool get _active => current == zone;

  PillVariant get _pillVariant {
    switch (zone) {
      case TsbZone.raceReady:
        return PillVariant.green;
      case TsbZone.transitional:
        return PillVariant.muted;
      case TsbZone.productive:
        return PillVariant.warn;
      case TsbZone.overload:
        return PillVariant.danger;
      case TsbZone.detraining:
        return PillVariant.warn;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Expanded(
            child: Text(
              label,
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs13,
                fontWeight: _active ? FontWeight.w600 : FontWeight.w400,
                color: _active ? StrideTokens.fg : StrideTokens.muted,
              ),
            ),
          ),
          Text(
            range,
            style: TextStyle(
              fontFamily: AppTypography.fontMono,
              fontSize: StrideTokens.fs12,
              color: _active ? StrideTokens.fgSoft : StrideTokens.muted2,
            ),
          ),
          if (_active) ...[
            const SizedBox(width: StrideTokens.spaceSm),
            StridePill(text: '当前', variant: _pillVariant, dense: true),
          ],
        ],
      ),
    );
  }
}

// ── AI card ───────────────────────────────────────────────────────────────────

class _AiCard extends StatelessWidget {
  const _AiCard({required this.summary});

  final PmcSummary summary;

  String get _text {
    final zone = summary.tsbZone;
    if (zone == null) return '暂无足够数据生成解读，完成更多训练后再查看。';
    return zone.interpretation;
  }

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
          const Row(
            children: [
              Icon(Icons.auto_awesome, size: 16, color: StrideTokens.accent),
              SizedBox(width: StrideTokens.spaceXs),
              Text(
                'AI 解读',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs14,
                  fontWeight: FontWeight.w500,
                  color: StrideTokens.fg,
                ),
              ),
              SizedBox(width: StrideTokens.spaceSm),
              StridePill(text: 'v1 静态', variant: PillVariant.muted, dense: true),
            ],
          ),
          const SizedBox(height: StrideTokens.spaceMd),
          Text(
            _text,
            style: const TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs13,
              color: StrideTokens.fgSoft,
              height: 1.6,
            ),
          ),
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
            const Icon(Icons.error_outline, size: 40, color: StrideTokens.muted),
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