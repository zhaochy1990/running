/// E6 — 个人最佳 (PB Records).
///
/// Shows 4 distance cards (5K / 10K / HM / FM), each with a PB time,
/// achievement date, and a mini best-so-far line chart.
/// Tapping a card (when labelId present) navigates to activity detail.
///
/// Data from `GET /api/{user}/pbs` via [pbRecordsProvider].
library;

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/router/routes_v2.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/refreshable.dart';
import '../_shared/widgets/sync_icon.dart';
import '../_shared/widgets/top_bar.dart';
import 'models/pb_record.dart';
import 'providers/pb_records_provider.dart';

class PbRecordsScreen extends ConsumerWidget {
  const PbRecordsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(pbRecordsProvider);

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: const StrideTopBar(
        title: '个人最佳',
        actions: [SyncIconButton()],
      ),
      body: async.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => _ErrorView(message: e.toString()),
        data: (response) => _PbBody(response: response),
      ),
    );
  }
}

// ── Body ──────────────────────────────────────────────────────────────────────

class _PbBody extends StatelessWidget {
  const _PbBody({required this.response});

  final PbsResponse response;

  @override
  Widget build(BuildContext context) {
    const distances = ['5K', '10K', 'HM', 'FM'];
    const labels = {
      '5K': '5 公里',
      '10K': '10 公里',
      'HM': '半马',
      'FM': '全马'
    };

    final pbMap = {for (final r in response.pbs) r.distance: r};

    return StrideRefreshable<PbsResponse>(
      provider: pbRecordsProvider.future,
      child: ListView(
        padding: const EdgeInsets.all(StrideTokens.spaceLg),
        children: [
          ...distances.map((key) {
            return Padding(
              padding: const EdgeInsets.only(bottom: StrideTokens.spaceMd),
              child: _PbCard(
                distance: key,
                label: labels[key] ?? key,
                record: pbMap[key],
              ),
            );
          }),
          const SizedBox(height: StrideTokens.spaceXl),
        ],
      ),
    );
  }
}

// ── PB card ───────────────────────────────────────────────────────────────────

class _PbCard extends StatelessWidget {
  const _PbCard({
    required this.distance,
    required this.label,
    required this.record,
  });

  final String distance;
  final String label;
  final PbRecord? record;

  String _formatTime(int totalSec) {
    final h = totalSec ~/ 3600;
    final m = (totalSec % 3600) ~/ 60;
    final s = totalSec % 60;
    if (h > 0) {
      return '$h:${m.toString().padLeft(2, '0')}:${s.toString().padLeft(2, '0')}';
    }
    return '$m:${s.toString().padLeft(2, '0')}';
  }

  String _formatDate(String raw) {
    try {
      final normalized = raw.replaceAllMapped(
        RegExp(r'^(\d{4})(\d{2})(\d{2})$'),
        (m) => '${m[1]}-${m[2]}-${m[3]}',
      );
      final d = DateTime.parse(normalized);
      return '${d.year}.${d.month.toString().padLeft(2, '0')}.${d.day.toString().padLeft(2, '0')}';
    } catch (_) {
      return raw;
    }
  }

  @override
  Widget build(BuildContext context) {
    final pb = record?.pbTimeSec;
    final hasRecord = pb != null;

    return GestureDetector(
      onTap: () {
        final labelId = record?.labelId;
        if (labelId != null) {
          context.push(RoutesV2.activityDetail(labelId));
        }
      },
      child: Container(
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
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
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
                      hasRecord ? _formatTime(pb) : '尚无记录',
                      style: TextStyle(
                        fontFamily: AppTypography.fontMono,
                        fontSize: hasRecord
                            ? StrideTokens.fs22
                            : StrideTokens.fs15,
                        fontWeight: FontWeight.w700,
                        color: hasRecord
                            ? StrideTokens.fg
                            : StrideTokens.muted,
                      ),
                    ),
                    if (hasRecord && record?.achievedAt != null) ...[
                      const SizedBox(height: 2),
                      Text(
                        _formatDate(record!.achievedAt!),
                        style: const TextStyle(
                          fontFamily: AppTypography.fontSans,
                          fontSize: StrideTokens.fs11,
                          color: StrideTokens.muted,
                        ),
                      ),
                    ],
                  ],
                ),
                const Spacer(),
                if (record?.labelId != null)
                  const Icon(
                    Icons.chevron_right,
                    size: 18,
                    color: StrideTokens.muted2,
                  ),
              ],
            ),
            if (hasRecord &&
                record?.history != null &&
                record!.history!.isNotEmpty) ...[
              const SizedBox(height: StrideTokens.spaceMd),
              _MiniChart(history: record!.history!),
            ],
          ],
        ),
      ),
    );
  }
}

// ── Mini history chart ────────────────────────────────────────────────────────

class _MiniChart extends StatelessWidget {
  const _MiniChart({required this.history});

  final List<PbHistoryPoint> history;

  @override
  Widget build(BuildContext context) {
    final spots = history.asMap().entries.map((e) {
      return FlSpot(
          e.key.toDouble(), e.value.bestSoFarSec.toDouble());
    }).toList();

    final minY = history
        .map((p) => p.bestSoFarSec.toDouble())
        .reduce((a, b) => a < b ? a : b);
    final maxY = history
        .map((p) => p.bestSoFarSec.toDouble())
        .reduce((a, b) => a > b ? a : b);
    final padding = ((maxY - minY) * 0.25).clamp(30.0, 300.0);

    return SizedBox(
      height: 56,
      child: LineChart(
        LineChartData(
          minY: minY - padding,
          maxY: maxY + padding,
          gridData: const FlGridData(show: false),
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
              barWidth: 1.5,
              dotData: FlDotData(
                show: true,
                getDotPainter: (spot, percent, bar, index) =>
                    FlDotCirclePainter(
                  radius: 2,
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
