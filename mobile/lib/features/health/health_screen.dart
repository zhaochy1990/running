import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/auth/current_user.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/app_typography.dart';
import '../../data/api/stride_api.dart';
import '../../data/models/health.dart';
import '../../data/repos/health_repository.dart';

final _abilityProvider = FutureProvider.family<AbilityCurrent?, String>(
  (ref, user) async {
    try {
      return await ref.watch(strideApiProvider).getAbilityCurrent(user);
    } catch (_) {
      return null;
    }
  },
);

class HealthScreen extends ConsumerWidget {
  const HealthScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(currentUserProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('体能')),
      body: user.when(
        loading: () => const Center(child: CircularProgressIndicator(strokeWidth: 2)),
        error: (e, _) => _ErrorState(message: '$e'),
        data: (profile) {
          if (profile == null) {
            return const Center(child: CircularProgressIndicator(strokeWidth: 2));
          }
          return _HealthBody(userId: profile.id);
        },
      ),
    );
  }
}

class _HealthBody extends ConsumerWidget {
  const _HealthBody({required this.userId});

  final String userId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final repo = ref.watch(healthRepositoryProvider);
    final ability = ref.watch(_abilityProvider(userId));

    return RefreshIndicator(
      onRefresh: () async {
        ref
          ..invalidate(healthRepositoryProvider)
          ..invalidate(_abilityProvider(userId));
      },
      child: StreamBuilder<HealthResponse>(
        stream: repo.watchHealth(userId, days: 30),
        builder: (context, healthSnap) {
          return StreamBuilder<PMCResponse>(
            stream: repo.watchPmc(userId, days: 90),
            builder: (context, pmcSnap) {
              if (healthSnap.hasError) {
                return _ErrorState(message: '${healthSnap.error}');
              }
              if (!healthSnap.hasData) {
                return const Center(child: CircularProgressIndicator(strokeWidth: 2));
              }
              return _HealthContent(
                health: healthSnap.data!,
                pmc: pmcSnap.data,
                ability: ability.valueOrNull,
              );
            },
          );
        },
      ),
    );
  }
}

class _HealthContent extends StatelessWidget {
  const _HealthContent({
    required this.health,
    required this.pmc,
    required this.ability,
  });

  final HealthResponse health;
  final PMCResponse? pmc;
  final AbilityCurrent? ability;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final summary = pmc?.summary;
    final latestHealth = health.health.isNotEmpty ? health.health.last : null;

    final fatigueValue = summary?.currentFatigue ?? latestHealth?.fatigue;
    final tsbValue = summary?.currentTsb;
    final rhrValue = summary?.currentRhr ?? latestHealth?.rhr;
    final hrv = health.hrv;

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Row(
          children: [
            Expanded(
              child: _MetricCard(
                label: '疲劳度',
                value: fatigueValue?.toStringAsFixed(0) ?? '—',
                hint: _fatigueHint(fatigueValue),
                hintColor: _fatigueColor(fatigueValue),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: _MetricCard(
                label: 'TSB',
                value: tsbValue == null
                    ? '—'
                    : (tsbValue >= 0 ? '+' : '') + tsbValue.toStringAsFixed(0),
                hint: summary?.currentTsbZoneLabel ?? '—',
                hintColor: _tsbColor(summary?.currentTsbZone),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: _MetricCard(
                label: 'RHR',
                value: rhrValue?.toString() ?? '—',
                hint: health.rhrBaseline != null
                    ? 'baseline ${health.rhrBaseline!.round()}'
                    : '—',
                hintColor: AppColors.foregroundMuted,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: _MetricCard(
                label: 'HRV',
                value: hrv.avgSleepHrv?.toStringAsFixed(0) ?? '—',
                hint: hrv.hrvNormalLow != null && hrv.hrvNormalHigh != null
                    ? '${hrv.hrvNormalLow!.round()}–${hrv.hrvNormalHigh!.round()}'
                    : '—',
                hintColor: AppColors.foregroundMuted,
              ),
            ),
          ],
        ),
        if (ability != null) ...[
          const SizedBox(height: 12),
          _AbilityCard(ability: ability!),
        ],
        const SizedBox(height: 24),
        if (pmc != null && pmc!.pmc.isNotEmpty) ...[
          Text('训练负荷 (CTL / ATL / TSB)', style: theme.textTheme.titleLarge),
          const SizedBox(height: 12),
          _PmcChartCard(records: pmc!.pmc),
          const SizedBox(height: 16),
        ],
        Text('疲劳度趋势', style: theme.textTheme.titleLarge),
        const SizedBox(height: 12),
        _SingleLineChartCard(
          values: [
            for (final r in health.health)
              (date: r.date, value: r.fatigue?.toDouble())
          ],
          color: AppColors.warning,
        ),
        const SizedBox(height: 16),
        Text('静息心率', style: theme.textTheme.titleLarge),
        const SizedBox(height: 12),
        _SingleLineChartCard(
          values: [
            for (final r in health.health)
              (date: r.date, value: r.rhr?.toDouble())
          ],
          color: AppColors.danger,
        ),
        const SizedBox(height: 32),
      ],
    );
  }

  static String _fatigueHint(num? f) {
    if (f == null) return '—';
    if (f < 40) return '已恢复';
    if (f < 50) return '正常';
    if (f < 60) return '疲劳';
    return '高度疲劳';
  }

  static Color _fatigueColor(num? f) {
    if (f == null) return AppColors.foregroundMuted;
    if (f < 40) return AppColors.success;
    if (f < 50) return AppColors.foregroundMuted;
    if (f < 60) return AppColors.warning;
    return AppColors.danger;
  }

  static Color _tsbColor(String? zone) {
    switch (zone) {
      case 'race_ready':
        return AppColors.accent;
      case 'transition':
        return AppColors.success;
      case 'productive':
        return AppColors.foregroundMuted;
      case 'overload':
        return AppColors.danger;
      case 'detrained':
        return AppColors.warning;
      default:
        return AppColors.foregroundMuted;
    }
  }
}

class _PmcChartCard extends StatelessWidget {
  const _PmcChartCard({required this.records});

  final List<PMCRecord> records;

  @override
  Widget build(BuildContext context) {
    if (records.isEmpty) return const SizedBox.shrink();

    final ctlSpots = <FlSpot>[];
    final atlSpots = <FlSpot>[];
    final tsbSpots = <FlSpot>[];
    final dates = <String>[];
    var minY = 0.0;
    var maxY = 0.0;
    for (var i = 0; i < records.length; i++) {
      final r = records[i];
      final ctl = r.cti?.toDouble() ?? 0;
      final atl = r.ati?.toDouble() ?? 0;
      final tsb = r.tsb.toDouble();
      ctlSpots.add(FlSpot(i.toDouble(), ctl));
      atlSpots.add(FlSpot(i.toDouble(), atl));
      tsbSpots.add(FlSpot(i.toDouble(), tsb));
      dates.add(r.date);
      minY = [minY, ctl, atl, tsb].reduce((a, b) => a < b ? a : b);
      maxY = [maxY, ctl, atl, tsb].reduce((a, b) => a > b ? a : b);
    }

    final pad = (maxY - minY).abs() * 0.1;

    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Row(
              children: [
                _LegendDot(color: AppColors.info, label: 'CTL'),
                SizedBox(width: 12),
                _LegendDot(color: AppColors.warning, label: 'ATL'),
                SizedBox(width: 12),
                _LegendDot(color: AppColors.accentDark, label: 'TSB'),
              ],
            ),
            const SizedBox(height: 12),
            SizedBox(
              height: 200,
              child: LineChart(
                LineChartData(
                  minY: minY - pad,
                  maxY: maxY + pad,
                  gridData: FlGridData(
                    show: true,
                    drawVerticalLine: false,
                    getDrawingHorizontalLine: (_) =>
                        const FlLine(color: AppColors.gray200, strokeWidth: 0.5),
                  ),
                  borderData: FlBorderData(show: false),
                  titlesData: FlTitlesData(
                    topTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
                    rightTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
                    bottomTitles: AxisTitles(
                      sideTitles: SideTitles(
                        showTitles: true,
                        reservedSize: 22,
                        interval: _bottomInterval(dates.length),
                        getTitlesWidget: (v, _) => _dateLabel(v, dates),
                      ),
                    ),
                    leftTitles: AxisTitles(
                      sideTitles: SideTitles(
                        showTitles: true,
                        reservedSize: 36,
                        getTitlesWidget: (v, _) => Text(
                          v.toStringAsFixed(0),
                          style: AppTypography.monoCaption.copyWith(fontSize: 10),
                        ),
                      ),
                    ),
                  ),
                  lineBarsData: [
                    _line(ctlSpots, AppColors.info),
                    _line(atlSpots, AppColors.warning),
                    _line(tsbSpots, AppColors.accentDark),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  static LineChartBarData _line(List<FlSpot> spots, Color color) {
    return LineChartBarData(
      spots: spots,
      color: color,
      barWidth: 1.6,
      dotData: const FlDotData(show: false),
      isCurved: true,
      curveSmoothness: 0.18,
      preventCurveOverShooting: true,
    );
  }
}

class _SingleLineChartCard extends StatelessWidget {
  const _SingleLineChartCard({required this.values, required this.color});

  final List<({String date, double? value})> values;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final spots = <FlSpot>[];
    final dates = <String>[];
    for (var i = 0; i < values.length; i++) {
      final v = values[i].value;
      if (v == null) continue;
      spots.add(FlSpot(i.toDouble(), v));
      dates.add(values[i].date);
    }

    if (spots.isEmpty) {
      return const Card(
        child: SizedBox(
          height: 120,
          child: Center(child: Text('—', style: AppTypography.monoCaption)),
        ),
      );
    }

    final ys = spots.map((s) => s.y);
    final minY = ys.reduce((a, b) => a < b ? a : b);
    final maxY = ys.reduce((a, b) => a > b ? a : b);
    final pad = (maxY - minY).abs() * 0.1;
    // Build a parallel index→date list keyed off the spot's x value (which
    // matches the original `i` from the values list).
    final dateByIndex = <int, String>{};
    var written = 0;
    for (var i = 0; i < values.length; i++) {
      if (values[i].value == null) continue;
      dateByIndex[i] = values[i].date;
      written++;
    }
    if (written == 0) {
      // unreachable given the spots.isEmpty check above; safety only
      return const SizedBox.shrink();
    }

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: SizedBox(
          height: 160,
          child: LineChart(
            LineChartData(
              minY: minY - pad,
              maxY: maxY + pad,
              gridData: FlGridData(
                show: true,
                drawVerticalLine: false,
                getDrawingHorizontalLine: (_) =>
                    const FlLine(color: AppColors.gray200, strokeWidth: 0.5),
              ),
              borderData: FlBorderData(show: false),
              titlesData: FlTitlesData(
                topTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
                rightTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
                bottomTitles: AxisTitles(
                  sideTitles: SideTitles(
                    showTitles: true,
                    reservedSize: 22,
                    interval: _bottomInterval(values.length),
                    getTitlesWidget: (v, _) {
                      final label = dateByIndex[v.round()];
                      if (label == null) return const SizedBox.shrink();
                      return _dateLabelFor(label);
                    },
                  ),
                ),
                leftTitles: AxisTitles(
                  sideTitles: SideTitles(
                    showTitles: true,
                    reservedSize: 36,
                    getTitlesWidget: (v, _) => Text(
                      v.toStringAsFixed(0),
                      style: AppTypography.monoCaption.copyWith(fontSize: 10),
                    ),
                  ),
                ),
              ),
              lineBarsData: [
                LineChartBarData(
                  spots: spots,
                  color: color,
                  barWidth: 1.6,
                  dotData: const FlDotData(show: false),
                  isCurved: true,
                  curveSmoothness: 0.18,
                  preventCurveOverShooting: true,
                  belowBarData: BarAreaData(
                    show: true,
                    color: color.withValues(alpha: 0.08),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Tries to print ~5 evenly-spaced labels regardless of series length.
double _bottomInterval(int n) {
  if (n <= 1) return 1;
  final step = (n / 5).ceil().toDouble();
  return step < 1 ? 1 : step;
}

/// Render a 'YYYY-MM-DD' (or ISO with time) date as 'MM/DD'.
Widget _dateLabelFor(String iso) {
  if (iso.length < 10) return const SizedBox.shrink();
  final mm = iso.substring(5, 7);
  final dd = iso.substring(8, 10);
  return Padding(
    padding: const EdgeInsets.only(top: 4),
    child: Text(
      '$mm/$dd',
      style: AppTypography.monoCaption.copyWith(fontSize: 9),
    ),
  );
}

/// Index-based version: look up the date at integer index v in the
/// `dates` list. Falls back to a blank widget on out-of-range to keep
/// fl_chart from over-rendering at axis edges.
Widget _dateLabel(double v, List<String> dates) {
  final i = v.round();
  if (i < 0 || i >= dates.length) return const SizedBox.shrink();
  return _dateLabelFor(dates[i]);
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
          decoration: BoxDecoration(
            color: color,
            borderRadius: BorderRadius.circular(2),
          ),
        ),
        const SizedBox(width: 4),
        Text(label, style: AppTypography.monoCaption),
      ],
    );
  }
}

class _AbilityCard extends StatelessWidget {
  const _AbilityCard({required this.ability});

  final AbilityCurrent ability;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final composite = ability.l4Composite;
    final marathonEst = ability.l4MarathonEstimateS;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('能力综合 (L4)', style: theme.textTheme.titleSmall),
                  const SizedBox(height: 8),
                  Text(
                    composite != null ? composite.toStringAsFixed(0) : '—',
                    style: AppTypography.monoHeadline,
                  ),
                ],
              ),
            ),
            if (marathonEst != null)
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text('马拉松预估', style: theme.textTheme.labelSmall),
                  const SizedBox(height: 4),
                  Text(
                    _formatHMS(marathonEst.toInt()),
                    style: AppTypography.monoTitle,
                  ),
                  if (ability.marathonTargetLabel != null) ...[
                    const SizedBox(height: 2),
                    Text(
                      ability.marathonTargetLabel!,
                      style: AppTypography.monoCaption.copyWith(
                        color: AppColors.foregroundSubtle,
                      ),
                    ),
                  ],
                ],
              ),
          ],
        ),
      ),
    );
  }

  static String _formatHMS(int seconds) {
    final h = seconds ~/ 3600;
    final m = (seconds % 3600) ~/ 60;
    final s = seconds % 60;
    return '$h:${m.toString().padLeft(2, '0')}:${s.toString().padLeft(2, '0')}';
  }
}

class _MetricCard extends StatelessWidget {
  const _MetricCard({
    required this.label,
    required this.value,
    required this.hint,
    required this.hintColor,
  });

  final String label;
  final String value;
  final String hint;
  final Color hintColor;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: theme.textTheme.titleSmall),
            const SizedBox(height: 8),
            Text(value, style: AppTypography.monoHeadline),
            const SizedBox(height: 4),
            Text(
              hint,
              style: theme.textTheme.bodySmall?.copyWith(color: hintColor),
            ),
          ],
        ),
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.message});
  final String message;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.cloud_off, size: 32, color: AppColors.foregroundMuted),
            const SizedBox(height: 12),
            Text('无法加载体能数据', style: theme.textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(
              message,
              style: theme.textTheme.bodySmall,
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}
