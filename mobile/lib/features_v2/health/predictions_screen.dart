/// E5 — 成绩预测 (Race Predictions).
///
/// Shows a hero card with the primary distance prediction, 4-distance
/// comparison rows, VO2max panel, optional target-gap progress bar,
/// and FM historical trend chart.
///
/// Data from `GET /api/{user}/race-predictions` + `/history`.
library;

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/app_typography.dart';
import '../../core/theme/pill_colors.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/pill.dart';
import '../_shared/widgets/top_bar.dart';
import 'models/race_prediction.dart';
import 'providers/race_prediction_provider.dart';

class PredictionsScreen extends ConsumerWidget {
  const PredictionsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(racePredictionProvider);

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: const StrideTopBar(title: '成绩预测'),
      body: async.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => _ErrorView(message: e.toString()),
        data: (prediction) => _PredictionsBody(prediction: prediction),
      ),
    );
  }
}

// ── Body ──────────────────────────────────────────────────────────────────────

class _PredictionsBody extends ConsumerWidget {
  const _PredictionsBody({required this.prediction});

  final RacePrediction prediction;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final historyAsync = ref.watch(racePredictionHistoryProvider);

    return ListView(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      children: [
        _HeroCard(prediction: prediction),
        const SizedBox(height: StrideTokens.spaceLg),
        _DistanceCompareCard(prediction: prediction),
        const SizedBox(height: StrideTokens.spaceLg),
        _Vo2maxCard(prediction: prediction),
        if (prediction.targetGap != null) ...[
          const SizedBox(height: StrideTokens.spaceLg),
          _TargetGapCard(gap: prediction.targetGap!),
        ],
        const SizedBox(height: StrideTokens.spaceLg),
        _HistoryCard(historyAsync: historyAsync),
        const SizedBox(height: StrideTokens.spaceXl),
      ],
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

String _formatTime(int totalSec) {
  final h = totalSec ~/ 3600;
  final m = (totalSec % 3600) ~/ 60;
  final s = totalSec % 60;
  if (h > 0) {
    return '$h:${m.toString().padLeft(2, '0')}:${s.toString().padLeft(2, '0')}';
  }
  return '$m:${s.toString().padLeft(2, '0')}';
}

String _formatPace(int paceSecPerKm) {
  final m = paceSecPerKm ~/ 60;
  final s = paceSecPerKm % 60;
  return "$m'${s.toString().padLeft(2, '0')}\"/km";
}

// ── Hero card ─────────────────────────────────────────────────────────────────

class _HeroCard extends StatelessWidget {
  const _HeroCard({required this.prediction});

  final RacePrediction prediction;

  @override
  Widget build(BuildContext context) {
    final primaryKey = prediction.distances.containsKey('FM')
        ? 'FM'
        : (prediction.distances.keys.isNotEmpty
            ? prediction.distances.keys.first
            : null);
    final primary =
        primaryKey != null ? prediction.distances[primaryKey] : null;

    const distanceLabels = {
      '5K': '5 公里',
      '10K': '10 公里',
      'HM': '半马',
      'FM': '全马',
    };
    final label = distanceLabels[primaryKey] ?? primaryKey ?? '全马';

    return Container(
      padding: const EdgeInsets.all(StrideTokens.space2xl),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Column(
        children: [
          Text(
            label,
            style: const TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs13,
              color: StrideTokens.muted,
            ),
          ),
          const SizedBox(height: StrideTokens.spaceXs),
          Text(
            primary != null
                ? _formatTime(primary.predictedTimeSec)
                : '--:--:--',
            style: const TextStyle(
              fontFamily: AppTypography.fontMono,
              fontSize: StrideTokens.fsDisplay40,
              fontWeight: FontWeight.w700,
              color: StrideTokens.fg,
            ),
          ),
          if (primary != null) ...[
            const SizedBox(height: StrideTokens.spaceXs),
            Text(
              _formatPace(primary.predictedPaceSecPerKm),
              style: const TextStyle(
                fontFamily: AppTypography.fontMono,
                fontSize: StrideTokens.fs14,
                color: StrideTokens.muted,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

// ── Distance compare card ─────────────────────────────────────────────────────

class _DistanceCompareCard extends StatelessWidget {
  const _DistanceCompareCard({required this.prediction});

  final RacePrediction prediction;

  @override
  Widget build(BuildContext context) {
    const distances = ['5K', '10K', 'HM', 'FM'];
    const labels = {'5K': '5K', '10K': '10K', 'HM': '半马', 'FM': '全马'};

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
            '各距离预测',
            style: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs14,
              fontWeight: FontWeight.w500,
              color: StrideTokens.fg,
            ),
          ),
          const SizedBox(height: StrideTokens.spaceMd),
          ...distances.map((key) {
            final dp = prediction.distances[key];
            return Padding(
              padding: const EdgeInsets.symmetric(
                  vertical: StrideTokens.spaceXs),
              child: Row(
                children: [
                  SizedBox(
                    width: 48,
                    child: Text(
                      labels[key] ?? key,
                      style: const TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs13,
                        color: StrideTokens.fgSoft,
                      ),
                    ),
                  ),
                  Expanded(
                    child: Text(
                      dp != null ? _formatTime(dp.predictedTimeSec) : '—',
                      style: const TextStyle(
                        fontFamily: AppTypography.fontMono,
                        fontSize: StrideTokens.fs15,
                        fontWeight: FontWeight.w600,
                        color: StrideTokens.fg,
                      ),
                    ),
                  ),
                  if (dp != null)
                    Text(
                      _formatPace(dp.predictedPaceSecPerKm),
                      style: const TextStyle(
                        fontFamily: AppTypography.fontMono,
                        fontSize: StrideTokens.fs12,
                        color: StrideTokens.muted,
                      ),
                    ),
                ],
              ),
            );
          }),
        ],
      ),
    );
  }
}

// ── VO2max card ───────────────────────────────────────────────────────────────

class _Vo2maxCard extends StatelessWidget {
  const _Vo2maxCard({required this.prediction});

  final RacePrediction prediction;

  @override
  Widget build(BuildContext context) {
    final vo2 = prediction.vo2max;
    final trend = prediction.vo2maxTrend;

    IconData trendIcon;
    Color trendColor;
    switch (trend) {
      case 'up':
        trendIcon = Icons.trending_up;
        trendColor = StrideTokens.accent;
      case 'down':
        trendIcon = Icons.trending_down;
        trendColor = StrideTokens.danger;
      default:
        trendIcon = Icons.trending_flat;
        trendColor = StrideTokens.muted;
    }

    return Container(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Row(
        children: [
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'VO₂max 估算',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs13,
                  color: StrideTokens.fgSoft,
                ),
              ),
              const SizedBox(height: StrideTokens.spaceXs),
              Row(
                children: [
                  Text(
                    vo2 != null ? vo2.toStringAsFixed(1) : '—',
                    style: const TextStyle(
                      fontFamily: AppTypography.fontMono,
                      fontSize: StrideTokens.fs22,
                      fontWeight: FontWeight.w700,
                      color: StrideTokens.fg,
                    ),
                  ),
                  if (vo2 != null) ...[
                    const SizedBox(width: StrideTokens.spaceXs),
                    const Text(
                      'ml/kg/min',
                      style: TextStyle(
                        fontFamily: AppTypography.fontMono,
                        fontSize: StrideTokens.fs11,
                        color: StrideTokens.muted,
                      ),
                    ),
                    const SizedBox(width: StrideTokens.spaceSm),
                    Icon(trendIcon, size: 18, color: trendColor),
                  ],
                ],
              ),
            ],
          ),
          const Spacer(),
          IconButton(
            icon: const Icon(Icons.refresh, color: StrideTokens.muted),
            onPressed: () {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('VO₂max 重新计算（v1 占位）')),
              );
            },
          ),
        ],
      ),
    );
  }
}

// ── Target gap card ───────────────────────────────────────────────────────────

class _TargetGapCard extends StatelessWidget {
  const _TargetGapCard({required this.gap});

  final TargetGap gap;

  @override
  Widget build(BuildContext context) {
    final totalRange = (gap.currentTimeSec - gap.targetTimeSec).abs();
    final progress = totalRange > 0
        ? (1.0 - gap.gapSec / totalRange).clamp(0.0, 1.0)
        : (gap.gapSec <= 0 ? 1.0 : 0.0);

    final gapAbs = gap.gapSec.abs();
    final gapMin = gapAbs ~/ 60;
    final gapSec = gapAbs % 60;
    final gapText = gap.gapSec > 0
        ? '距目标还差 $gapMin 分 $gapSec 秒'
        : '已超越目标 $gapMin 分 $gapSec 秒';

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
              const Text(
                '目标进度',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs14,
                  fontWeight: FontWeight.w500,
                  color: StrideTokens.fg,
                ),
              ),
              const Spacer(),
              StridePill(
                text: gap.distance,
                variant: PillVariant.muted,
                dense: true,
              ),
            ],
          ),
          const SizedBox(height: StrideTokens.spaceMd),
          ClipRRect(
            borderRadius: BorderRadius.circular(StrideTokens.radiusPill),
            child: LinearProgressIndicator(
              value: progress,
              minHeight: 8,
              backgroundColor: StrideTokens.grid,
              valueColor: AlwaysStoppedAnimation<Color>(
                gap.gapSec <= 0 ? StrideTokens.accent : StrideTokens.warn,
              ),
            ),
          ),
          const SizedBox(height: StrideTokens.spaceSm),
          Text(
            gapText,
            style: const TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs12,
              color: StrideTokens.fgSoft,
            ),
          ),
        ],
      ),
    );
  }
}

// ── History chart card ────────────────────────────────────────────────────────

class _HistoryCard extends StatelessWidget {
  const _HistoryCard({required this.historyAsync});

  final AsyncValue<List<PredictionHistoryPoint>> historyAsync;

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
              const Text(
                '全马预测趋势',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs14,
                  fontWeight: FontWeight.w500,
                  color: StrideTokens.fg,
                ),
              ),
              const Spacer(),
              const StridePill(
                text: '近 6 月',
                variant: PillVariant.muted,
                dense: true,
              ),
            ],
          ),
          const SizedBox(height: StrideTokens.spaceMd),
          historyAsync.when(
            loading: () => const SizedBox(
              height: 100,
              child: Center(
                  child: CircularProgressIndicator(strokeWidth: 2)),
            ),
            error: (_, __) => const SizedBox(
              height: 60,
              child: Center(
                child: Text(
                  '暂无历史数据',
                  style: TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs12,
                    color: StrideTokens.muted,
                  ),
                ),
              ),
            ),
            data: (history) => history.isEmpty
                ? const SizedBox(
                    height: 60,
                    child: Center(
                      child: Text(
                        '暂无历史数据',
                        style: TextStyle(
                          fontFamily: AppTypography.fontSans,
                          fontSize: StrideTokens.fs12,
                          color: StrideTokens.muted,
                        ),
                      ),
                    ),
                  )
                : _TrendChart(history: history),
          ),
        ],
      ),
    );
  }
}

class _TrendChart extends StatelessWidget {
  const _TrendChart({required this.history});

  final List<PredictionHistoryPoint> history;

  @override
  Widget build(BuildContext context) {
    final spots = history.asMap().entries.map((e) {
      return FlSpot(
          e.key.toDouble(), e.value.predictedTimeSec.toDouble());
    }).toList();

    final minY = history
        .map((p) => p.predictedTimeSec.toDouble())
        .reduce((a, b) => a < b ? a : b);
    final maxY = history
        .map((p) => p.predictedTimeSec.toDouble())
        .reduce((a, b) => a > b ? a : b);
    final padding = ((maxY - minY) * 0.2).clamp(60.0, 600.0);

    return SizedBox(
      height: 120,
      child: LineChart(
        LineChartData(
          minY: minY - padding,
          maxY: maxY + padding,
          gridData: FlGridData(show: false),
          borderData: FlBorderData(show: false),
          titlesData: const FlTitlesData(
            leftTitles:
                AxisTitles(sideTitles: SideTitles(showTitles: false)),
            topTitles:
                AxisTitles(sideTitles: SideTitles(showTitles: false)),
            rightTitles:
                AxisTitles(sideTitles: SideTitles(showTitles: false)),
            bottomTitles:
                AxisTitles(sideTitles: SideTitles(showTitles: false)),
          ),
          lineBarsData: [
            LineChartBarData(
              spots: spots,
              isCurved: true,
              color: StrideTokens.accent,
              barWidth: 2,
              dotData: const FlDotData(show: false),
              belowBarData: BarAreaData(
                show: true,
                color: StrideTokens.accent.withAlpha(25),
              ),
            ),
          ],
        ),
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
            const Icon(Icons.error_outline,
                size: 40, color: StrideTokens.muted),
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
