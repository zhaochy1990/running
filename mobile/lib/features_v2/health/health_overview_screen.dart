/// E1 — 健康概览 (Health Overview).
///
/// Displays 4 metric cards in a 2×2 grid (RHR, HRV, Fatigue, Load),
/// a sleep mini-bar-chart, and a static AI-interpretation card.
///
/// Data from `GET /api/{user}/health?days=14` via [healthOverviewProvider].
library;

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/router/routes_v2.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/pill_colors.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/pill.dart';
import '../_shared/widgets/refreshable.dart';
import '../_shared/widgets/screen_hero.dart';
import '../_shared/widgets/sync_icon.dart';
import 'models/health_overview.dart';
import 'providers/health_overview_provider.dart';
import 'widgets/metric_card.dart';

class HealthOverviewScreen extends ConsumerWidget {
  const HealthOverviewScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(healthOverviewProvider);

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            const StrideScreenHero(
              eyebrow: '身体指标 · 今日',
              title: '健康概览',
              deck: '同步自手表的静息心率、HRV、训练负荷与睡眠。',
              trailing: SyncIconButton(),
            ),
            Expanded(
              child: async.when(
                loading: () =>
                    const Center(child: CircularProgressIndicator()),
                error: (e, _) => _ErrorView(message: e.toString()),
                data: (overview) => _OverviewBody(overview: overview),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ── Body ──────────────────────────────────────────────────────────────────────

class _OverviewBody extends StatelessWidget {
  const _OverviewBody({required this.overview});

  final HealthOverview overview;

  @override
  Widget build(BuildContext context) {
    return StrideRefreshable<HealthOverview>(
      provider: healthOverviewProvider.future,
      child: ListView(
        padding: const EdgeInsets.all(StrideTokens.spaceLg),
        children: [
          _MetricGrid(overview: overview),
          const SizedBox(height: StrideTokens.spaceLg),
          _SleepCard(overview: overview),
          const SizedBox(height: StrideTokens.spaceLg),
          _AiInterpretCard(overview: overview),
          const SizedBox(height: StrideTokens.spaceXl),
          const _DetailEntries(),
          const SizedBox(height: StrideTokens.spaceXl),
        ],
      ),
    );
  }
}

// ── 2×2 metric grid ───────────────────────────────────────────────────────────

class _MetricGrid extends StatelessWidget {
  const _MetricGrid({required this.overview});

  final HealthOverview overview;

  @override
  Widget build(BuildContext context) {
    final rhrValue = overview.rhr != null ? '${overview.rhr}' : '—';
    final rhrUnit = overview.rhr != null ? 'bpm' : null;
    final rhrPillVariant = _rhrPillVariant(overview.rhrBaselineDiff);
    final rhrPillText = _rhrPillText(overview.rhrBaselineDiff);

    final hrvValue =
        overview.hrv != null ? overview.hrv!.toStringAsFixed(0) : '—';
    final hrvUnit = overview.hrv != null ? 'ms' : null;
    final String? hrvSubtitle;
    if (overview.hrvLow != null && overview.hrvHigh != null) {
      hrvSubtitle =
          '区间 ${overview.hrvLow!.toStringAsFixed(0)}–${overview.hrvHigh!.toStringAsFixed(0)}';
    } else {
      hrvSubtitle = null;
    }

    final fatigueValue =
        overview.fatigue != null ? overview.fatigue!.toStringAsFixed(0) : '—';
    final fatiguePill = overview.fatigueBand.label;
    final fatiguePillVariant = _fatiguePillVariant(overview.fatigueBand);

    final loadValue = overview.loadRatio != null
        ? overview.loadRatio!.toStringAsFixed(2)
        : '—';
    final loadStateText = overview.loadState;

    return GridView(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 2,
        mainAxisSpacing: StrideTokens.spaceMd,
        crossAxisSpacing: StrideTokens.spaceMd,
        childAspectRatio: 1.1,
      ),
      children: [
        // Card 1 — RHR
        MetricCard(
          title: '静息心率',
          value: rhrValue,
          unit: rhrUnit,
          pill: rhrPillText,
          pillVariant: rhrPillVariant,
          delta: overview.rhrBaselineDiff,
          deltaPositiveIsBad: true,
        ),
        // Card 2 — HRV
        MetricCard(
          title: '睡眠 HRV',
          value: hrvValue,
          unit: hrvUnit,
          subtitle: hrvSubtitle,
          pill: _hrvPillText(overview.hrv, overview.hrvLow, overview.hrvHigh),
          pillVariant:
              _hrvPillVariant(overview.hrv, overview.hrvLow, overview.hrvHigh),
        ),
        // Card 3 — Fatigue
        MetricCard(
          title: '疲劳值',
          value: fatigueValue,
          pill: fatiguePill,
          pillVariant: fatiguePillVariant,
        ),
        // Card 4 — Training load
        MetricCard(
          title: '训练负荷',
          value: loadValue,
          unit: 'ACWR',
          subtitle: loadStateText,
        ),
      ],
    );
  }

  static PillVariant _rhrPillVariant(int? diff) {
    if (diff == null) return PillVariant.muted;
    if (diff <= 2) return PillVariant.green;
    if (diff <= 5) return PillVariant.warn;
    return PillVariant.danger;
  }

  static String? _rhrPillText(int? diff) {
    if (diff == null) return null;
    if (diff <= 2) return '正常';
    if (diff <= 5) return '略高';
    return '偏高';
  }

  static PillVariant _fatiguePillVariant(FatigueBand band) {
    switch (band) {
      case FatigueBand.recovered:
        return PillVariant.green;
      case FatigueBand.normal:
        return PillVariant.muted;
      case FatigueBand.fatigued:
        return PillVariant.warn;
      case FatigueBand.high:
        return PillVariant.danger;
    }
  }

  static String? _hrvPillText(double? hrv, double? low, double? high) {
    if (hrv == null) return null;
    if (low != null && hrv < low) return '偏低';
    if (high != null && hrv > high) return '偏高';
    return '区间内';
  }

  static PillVariant _hrvPillVariant(
      double? hrv, double? low, double? high) {
    if (hrv == null) return PillVariant.muted;
    if (low != null && hrv < low) return PillVariant.warn;
    if (high != null && hrv > high) return PillVariant.warn;
    return PillVariant.green;
  }
}

// ── Sleep card ────────────────────────────────────────────────────────────────

class _SleepCard extends StatelessWidget {
  const _SleepCard({required this.overview});

  final HealthOverview overview;

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
              Text(
                '睡眠时长',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs14,
                  fontWeight: FontWeight.w500,
                  color: StrideTokens.fg,
                ),
              ),
              Spacer(),
              StridePill(
                text: '近 7 天',
                variant: PillVariant.muted,
                dense: true,
              ),
            ],
          ),
          const SizedBox(height: StrideTokens.spaceMd),
          if (overview.sleepHistory == null || overview.sleepHistory!.isEmpty)
            _SleepPlaceholder()
          else
            _SleepBarChart(sleepHistory: overview.sleepHistory!),
        ],
      ),
    );
  }
}

class _SleepPlaceholder extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Container(
      height: 80,
      decoration: BoxDecoration(
        color: StrideTokens.bg,
        borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
      ),
      child: const Center(
        child: Text(
          'v1.x 即将支持睡眠时长趋势',
          style: TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs12,
            color: StrideTokens.muted,
          ),
        ),
      ),
    );
  }
}

class _SleepBarChart extends StatelessWidget {
  const _SleepBarChart({required this.sleepHistory});

  final List<double> sleepHistory;

  @override
  Widget build(BuildContext context) {
    // Convert seconds to hours for display.
    final hoursData = sleepHistory.map((s) => s / 3600.0).toList();
    final maxVal = hoursData.reduce((a, b) => a > b ? a : b);
    final displayMax = maxVal > 0 ? (maxVal * 1.2).clamp(4.0, 12.0) : 8.0;

    return SizedBox(
      height: 100,
      child: BarChart(
        BarChartData(
          maxY: displayMax,
          minY: 0,
          gridData: const FlGridData(show: false),
          borderData: FlBorderData(show: false),
          titlesData: FlTitlesData(
            leftTitles:
                const AxisTitles(sideTitles: SideTitles(showTitles: false)),
            topTitles:
                const AxisTitles(sideTitles: SideTitles(showTitles: false)),
            rightTitles:
                const AxisTitles(sideTitles: SideTitles(showTitles: false)),
            bottomTitles: AxisTitles(
              sideTitles: SideTitles(
                showTitles: true,
                getTitlesWidget: (value, meta) {
                  final labels = ['一', '二', '三', '四', '五', '六', '日'];
                  final idx = value.toInt();
                  if (idx < 0 || idx >= labels.length) return const SizedBox();
                  return Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(
                      labels[idx],
                      style: const TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs10,
                        color: StrideTokens.muted,
                      ),
                    ),
                  );
                },
              ),
            ),
          ),
          barGroups: List.generate(hoursData.length, (i) {
            return BarChartGroupData(
              x: i,
              barRods: [
                BarChartRodData(
                  toY: hoursData[i],
                  width: 18,
                  borderRadius: const BorderRadius.vertical(
                    top: Radius.circular(4),
                  ),
                  color: hoursData[i] < 6
                      ? StrideTokens.warn.withAlpha(204)
                      : StrideTokens.accent.withAlpha(204),
                ),
              ],
            );
          }),
        ),
      ),
    );
  }
}

// ── AI interpret card ────────────────────────────────────────────────────────

class _AiInterpretCard extends StatelessWidget {
  const _AiInterpretCard({required this.overview});

  final HealthOverview overview;

  String get _interpretation {
    switch (overview.fatigueBand) {
      case FatigueBand.recovered:
        return '状态良好，当前疲劳水平低，可按计划正常训练。注意保持睡眠质量，维持良好状态。';
      case FatigueBand.normal:
        return '状态正常，疲劳处于合理范围。可继续执行计划，注意训练后的恢复和营养补充。';
      case FatigueBand.fatigued:
        return '疲劳有所积累，建议适当降低本周训练量（10-20%），并增加睡眠时间和蛋白质摄入。';
      case FatigueBand.high:
        return '疲劳较高，建议主动恢复（低强度跑或完全休息），避免高强度训练，优先保证每晚 7-9 小时睡眠。';
    }
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
              Icon(
                Icons.auto_awesome,
                size: 16,
                color: StrideTokens.accent,
              ),
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
              StridePill(
                text: 'v1 静态',
                variant: PillVariant.muted,
                dense: true,
              ),
            ],
          ),
          const SizedBox(height: StrideTokens.spaceMd),
          Text(
            _interpretation,
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

// ── Detail entries (E2-E6) ───────────────────────────────────────────────────

class _DetailEntries extends StatelessWidget {
  const _DetailEntries();

  @override
  Widget build(BuildContext context) {
    final entries = <_EntryItem>[
      const _EntryItem(
        icon: Icons.show_chart,
        title: '训练负荷',
        subtitle: 'ATL / CTL / TSB 曲线',
        route: RoutesV2.dataPmc,
      ),
      const _EntryItem(
        icon: Icons.ssid_chart,
        title: '趋势详情',
        subtitle: '疲劳 / HRV / RHR / 睡眠 / 负荷',
        route: RoutesV2.dataTrends,
      ),
      const _EntryItem(
        icon: Icons.radar,
        title: '能力分析',
        subtitle: '6 维 ability radar',
        route: RoutesV2.abilityRadar,
      ),
      const _EntryItem(
        icon: Icons.flag_outlined,
        title: '成绩预测',
        subtitle: '5K / 10K / HM / FM + 目标差距',
        route: RoutesV2.predictions,
      ),
      const _EntryItem(
        icon: Icons.emoji_events_outlined,
        title: '个人最佳',
        subtitle: '4 距离自动检测',
        route: RoutesV2.pbRecords,
      ),
    ];

    return Container(
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusLg),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Column(
        children: [
          for (var i = 0; i < entries.length; i++) ...[
            if (i > 0)
              const Divider(
                height: 1,
                thickness: 1,
                color: StrideTokens.border2,
                indent: StrideTokens.spaceLg,
                endIndent: StrideTokens.spaceLg,
              ),
            _EntryTile(item: entries[i]),
          ],
        ],
      ),
    );
  }
}

class _EntryItem {
  const _EntryItem({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.route,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final String route;
}

class _EntryTile extends StatelessWidget {
  const _EntryTile({required this.item});

  final _EntryItem item;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      key: Key('detail-entry-${item.route}'),
      onTap: () => context.push(item.route),
      borderRadius: BorderRadius.circular(StrideTokens.radiusLg),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: StrideTokens.spaceLg,
          vertical: StrideTokens.spaceMd,
        ),
        child: Row(
          children: [
            Icon(item.icon, size: 22, color: StrideTokens.accent),
            const SizedBox(width: StrideTokens.spaceMd),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    item.title,
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs14,
                      fontWeight: FontWeight.w500,
                      color: StrideTokens.fg,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    item.subtitle,
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs12,
                      color: StrideTokens.muted,
                    ),
                  ),
                ],
              ),
            ),
            const Icon(Icons.chevron_right, size: 18, color: StrideTokens.muted),
          ],
        ),
      ),
    );
  }
}
