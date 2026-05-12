/// E4 — 能力分析 (Ability Radar).
///
/// Displays a 6-axis radar chart with dimension cards showing scores,
/// strength bands, and improvement suggestions.
///
/// Data from `GET /api/{user}/ability/current` via [abilitySnapshotProvider].
library;

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/app_typography.dart';
import '../../core/theme/pill_colors.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/pill.dart';
import '../_shared/widgets/top_bar.dart';
import 'models/ability_snapshot.dart';
import 'providers/ability_snapshot_provider.dart';

class AbilityRadarScreen extends ConsumerWidget {
  const AbilityRadarScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(abilitySnapshotProvider);

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: const StrideTopBar(title: '能力分析'),
      body: async.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => _ErrorView(message: e.toString()),
        data: (snapshot) => _RadarBody(snapshot: snapshot),
      ),
    );
  }
}

// ── Body ──────────────────────────────────────────────────────────────────────

class _RadarBody extends StatelessWidget {
  const _RadarBody({required this.snapshot});

  final AbilitySnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      children: [
        if (snapshot.l4Composite != null)
          _ScoreBadge(score: snapshot.l4Composite!),
        const SizedBox(height: StrideTokens.spaceLg),
        _RadarCard(snapshot: snapshot),
        const SizedBox(height: StrideTokens.spaceLg),
        ...DimensionMeta.all.map((meta) {
          final score = snapshot.l3Dimensions[meta.key];
          return Padding(
            padding: const EdgeInsets.only(bottom: StrideTokens.spaceMd),
            child: _DimensionCard(meta: meta, score: score),
          );
        }),
        const SizedBox(height: StrideTokens.spaceXl),
      ],
    );
  }
}

// ── Overall score badge ───────────────────────────────────────────────────────

class _ScoreBadge extends StatelessWidget {
  const _ScoreBadge({required this.score});

  final double score;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: StrideTokens.spaceLg,
        vertical: StrideTokens.spaceMd,
      ),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Row(
        children: [
          const Text(
            '综合能力',
            style: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs14,
              color: StrideTokens.fgSoft,
            ),
          ),
          const Spacer(),
          Text(
            score.toStringAsFixed(0),
            style: const TextStyle(
              fontFamily: AppTypography.fontMono,
              fontSize: StrideTokens.fs22,
              fontWeight: FontWeight.w700,
              color: StrideTokens.fg,
            ),
          ),
          const SizedBox(width: StrideTokens.spaceXs),
          const Text(
            '/ 100',
            style: TextStyle(
              fontFamily: AppTypography.fontMono,
              fontSize: StrideTokens.fs13,
              color: StrideTokens.muted,
            ),
          ),
        ],
      ),
    );
  }
}

// ── Radar chart card ──────────────────────────────────────────────────────────

class _RadarCard extends StatelessWidget {
  const _RadarCard({required this.snapshot});

  final AbilitySnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    final dims = DimensionMeta.all;
    final values = dims.map((d) {
      return (snapshot.l3Dimensions[d.key] ?? 0.0).clamp(0.0, 100.0);
    }).toList();

    return Container(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Column(
        children: [
          const Text(
            '能力雷达',
            style: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs14,
              fontWeight: FontWeight.w500,
              color: StrideTokens.fg,
            ),
          ),
          const SizedBox(height: StrideTokens.spaceLg),
          SizedBox(
            height: 240,
            child: RadarChart(
              RadarChartData(
                radarBackgroundColor: Colors.transparent,
                borderData: FlBorderData(show: false),
                radarBorderData: const BorderSide(
                  color: StrideTokens.border,
                  width: 1,
                ),
                gridBorderData: const BorderSide(
                  color: StrideTokens.grid,
                  width: 1,
                ),
                tickCount: 4,
                ticksTextStyle: const TextStyle(
                  fontFamily: AppTypography.fontMono,
                  fontSize: StrideTokens.fs10,
                  color: StrideTokens.muted2,
                ),
                tickBorderData: const BorderSide(
                  color: StrideTokens.grid,
                  width: 1,
                ),
                getTitle: (index, angle) {
                  if (index < 0 || index >= dims.length) {
                    return RadarChartTitle(text: '');
                  }
                  return RadarChartTitle(
                    text: dims[index].label,
                    angle: 0,
                  );
                },
                titleTextStyle: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs11,
                  color: StrideTokens.fgSoft,
                ),
                titlePositionPercentageOffset: 0.15,
                dataSets: [
                  RadarDataSet(
                    fillColor: StrideTokens.accent.withAlpha(40),
                    borderColor: StrideTokens.accent,
                    borderWidth: 2,
                    entryRadius: 3,
                    dataEntries: values
                        .map((v) => RadarEntry(value: v))
                        .toList(),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ── Dimension card ────────────────────────────────────────────────────────────

class _DimensionCard extends StatelessWidget {
  const _DimensionCard({required this.meta, required this.score});

  final DimensionMeta meta;
  final double? score;

  @override
  Widget build(BuildContext context) {
    final band = AbilityBand.from(score);
    final displayScore = score != null ? score!.toStringAsFixed(0) : '—';

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
                meta.label,
                style: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs14,
                  fontWeight: FontWeight.w500,
                  color: StrideTokens.fg,
                ),
              ),
              const SizedBox(width: StrideTokens.spaceSm),
              StridePill(
                text: band.label,
                variant: _bandPillVariant(band),
                dense: true,
              ),
              const Spacer(),
              Text(
                displayScore,
                style: const TextStyle(
                  fontFamily: AppTypography.fontMono,
                  fontSize: StrideTokens.fs20,
                  fontWeight: FontWeight.w700,
                  color: StrideTokens.fg,
                ),
              ),
            ],
          ),
          const SizedBox(height: StrideTokens.spaceXs),
          Text(
            meta.suggestion,
            style: const TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs12,
              color: StrideTokens.muted,
              height: 1.5,
            ),
          ),
        ],
      ),
    );
  }

  static PillVariant _bandPillVariant(AbilityBand band) {
    switch (band) {
      case AbilityBand.strong:
        return PillVariant.green;
      case AbilityBand.medium:
        return PillVariant.muted;
      case AbilityBand.weak:
        return PillVariant.warn;
    }
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
