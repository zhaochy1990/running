/// D9 — 周复盘屏幕
///
/// Route: /v2/review/:folder  (fullscreen, no shell)
/// Data: [weekReviewProvider(folder)]
library;

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme/app_typography.dart';
import '../../core/theme/pill_colors.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/pill.dart';
import '../_shared/widgets/stat_row.dart';
import '../_shared/widgets/top_bar.dart';
import 'models/week_review.dart';
import 'providers/week_review_provider.dart';

class WeekReviewScreen extends ConsumerWidget {
  const WeekReviewScreen({super.key, required this.folder});

  final String folder;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final reviewAsync = ref.watch(weekReviewProvider(folder));

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        leading: GestureDetector(
          onTap: () => context.pop(),
          child: const Icon(Icons.arrow_back, size: 20, color: StrideTokens.fgSoft),
        ),
        title: '本周复盘',
      ),
      body: reviewAsync.when(
        loading: () =>
            const Center(child: CircularProgressIndicator(color: StrideTokens.accent)),
        error: (err, _) => _ErrorBody(
          message: err.toString(),
          onRetry: () => ref.invalidate(weekReviewProvider(folder)),
        ),
        data: (review) => _ReviewBody(review: review),
      ),
    );
  }
}

// ── Body ──────────────────────────────────────────────────────────────────────

class _ReviewBody extends StatelessWidget {
  const _ReviewBody({required this.review});

  final WeekReview review;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.symmetric(
        horizontal: StrideTokens.spaceLg,
        vertical: StrideTokens.spaceLg,
      ),
      children: [
        // 1. 本周统计 stat-row
        _SectionHeader(title: '本周统计'),
        const SizedBox(height: StrideTokens.spaceSm),
        _buildStatRow(review.summary),
        const SizedBox(height: StrideTokens.spaceLg),

        // 2. TSB 走势
        _SectionHeader(title: 'TSB 走势'),
        const SizedBox(height: StrideTokens.spaceSm),
        _TsbChart(series: review.tsbSeries),
        const SizedBox(height: StrideTokens.spaceLg),

        // 3. 每节课完成情况
        _SectionHeader(title: '课时完成情况'),
        const SizedBox(height: StrideTokens.spaceSm),
        ...review.sessions.map((s) => Padding(
              padding: const EdgeInsets.only(bottom: StrideTokens.spaceSm),
              child: _SessionCard(session: s),
            )),
        if (review.sessions.isEmpty)
          _EmptyHint(text: '本周暂无计划课时'),
        const SizedBox(height: StrideTokens.spaceLg),

        // 4. 关键洞察
        _SectionHeader(title: '关键洞察'),
        const SizedBox(height: StrideTokens.spaceSm),
        ...review.insights.map((i) => Padding(
              padding: const EdgeInsets.only(bottom: StrideTokens.spaceSm),
              child: _InsightCard(insight: i),
            )),
        if (review.insights.isEmpty)
          _EmptyHint(text: '暂无洞察数据'),
        const SizedBox(height: StrideTokens.spaceLg),

        // 5. AI 点评精选 (up to 2)
        if (review.activityHighlights.isNotEmpty) ...[
          _SectionHeader(title: 'AI 点评精选'),
          const SizedBox(height: StrideTokens.spaceSm),
          ...review.activityHighlights
              .take(2)
              .map((h) => Padding(
                    padding: const EdgeInsets.only(bottom: StrideTokens.spaceSm),
                    child: _ActivityHighlightCard(highlight: h),
                  )),
          const SizedBox(height: StrideTokens.spaceLg),
        ],

        // 6. 下周计划预览
        _SectionHeader(title: '下周计划'),
        const SizedBox(height: StrideTokens.spaceSm),
        _NextWeekCard(preview: review.nextWeekPreview),

        const SizedBox(height: StrideTokens.space3xl),
      ],
    );
  }

  Widget _buildStatRow(WeekSummary s) {
    final completionPct = s.completionRate != null
        ? '${(s.completionRate! * 100).round()}%'
        : '—';
    final distKm = s.totalDistanceKm.toStringAsFixed(1);
    final dur = _fmtDuration(s.totalDurationSec);
    return StrideStatRow(items: [
      StatItem(label: '完成率', value: completionPct),
      StatItem(label: '总里程', value: distKm, unit: 'km'),
      StatItem(label: '总时长', value: dur),
    ]);
  }

  String _fmtDuration(int seconds) {
    final h = seconds ~/ 3600;
    final m = (seconds % 3600) ~/ 60;
    if (h > 0) return '${h}h${m.toString().padLeft(2, '0')}m';
    return '${m}分钟';
  }
}

// ── TSB Chart ─────────────────────────────────────────────────────────────────

class _TsbChart extends StatelessWidget {
  const _TsbChart({required this.series});

  final List<TsbPoint> series;

  @override
  Widget build(BuildContext context) {
    if (series.isEmpty) {
      return Container(
        height: 120,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: StrideTokens.surface,
          border: Border.all(color: StrideTokens.border2),
          borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        ),
        child: const Text(
          '暂无 TSB 数据',
          style: TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs13,
            color: StrideTokens.muted,
          ),
        ),
      );
    }

    final spots = series.asMap().entries.map((e) {
      return FlSpot(e.key.toDouble(), e.value.tsb);
    }).toList();

    final tsbValues = series.map((p) => p.tsb).toList();
    final minY = (tsbValues.reduce((a, b) => a < b ? a : b) - 5).floorToDouble();
    final maxY = (tsbValues.reduce((a, b) => a > b ? a : b) + 5).ceilToDouble();

    return Container(
      height: 140,
      padding: const EdgeInsets.only(
        top: StrideTokens.spaceMd,
        right: StrideTokens.spaceMd,
        bottom: StrideTokens.spaceSm,
        left: StrideTokens.spaceSm,
      ),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        border: Border.all(color: StrideTokens.border2),
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
      ),
      child: LineChart(
        LineChartData(
          minY: minY,
          maxY: maxY,
          gridData: FlGridData(
            show: true,
            drawVerticalLine: false,
            horizontalInterval: 20,
            getDrawingHorizontalLine: (value) => FlLine(
              color: StrideTokens.border2,
              strokeWidth: 1,
              dashArray: value == 0 ? null : [4, 4],
            ),
          ),
          borderData: FlBorderData(show: false),
          titlesData: FlTitlesData(
            leftTitles: AxisTitles(
              sideTitles: SideTitles(
                showTitles: true,
                reservedSize: 32,
                interval: 20,
                getTitlesWidget: (value, meta) => Text(
                  value.toInt().toString(),
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
                getTitlesWidget: (value, meta) {
                  final idx = value.toInt();
                  if (idx < 0 || idx >= series.length) return const SizedBox();
                  final d = series[idx].date;
                  // show "M/D" from ISO date
                  final parts = d.split('-');
                  if (parts.length < 3) return const SizedBox();
                  return Text(
                    '${int.tryParse(parts[1]) ?? 0}/${int.tryParse(parts[2]) ?? 0}',
                    style: const TextStyle(
                      fontFamily: AppTypography.fontMono,
                      fontSize: StrideTokens.fs10,
                      color: StrideTokens.muted,
                    ),
                  );
                },
              ),
            ),
            topTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
            rightTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
          ),
          lineBarsData: [
            LineChartBarData(
              spots: spots,
              isCurved: true,
              color: StrideTokens.accent,
              barWidth: 2,
              dotData: FlDotData(
                show: true,
                getDotPainter: (spot, pct, bar, idx) => FlDotCirclePainter(
                  radius: 3,
                  color: StrideTokens.accent,
                  strokeWidth: 1.5,
                  strokeColor: StrideTokens.surface,
                ),
              ),
              belowBarData: BarAreaData(
                show: true,
                color: StrideTokens.accent.withValues(alpha: 0.08),
              ),
            ),
          ],
          extraLinesData: ExtraLinesData(
            horizontalLines: [
              HorizontalLine(
                y: 0,
                color: StrideTokens.muted2,
                strokeWidth: 1,
              ),
              HorizontalLine(
                y: 20,
                color: StrideTokens.accentFg,
                strokeWidth: 1,
                dashArray: [4, 4],
              ),
              HorizontalLine(
                y: -20,
                color: const Color(0xFFFFE4CC),
                strokeWidth: 1,
                dashArray: [4, 4],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ── Session Card ──────────────────────────────────────────────────────────────

class _SessionCard extends StatelessWidget {
  const _SessionCard({required this.session});

  final SessionReview session;

  @override
  Widget build(BuildContext context) {
    final dateLabel = _shortDate(session.date);
    final statusPill = session.completed
        ? const StridePill(text: '已完成', variant: PillVariant.green)
        : const StridePill(text: '未完成', variant: PillVariant.muted);

    return Container(
      padding: const EdgeInsets.all(StrideTokens.spaceMd),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        border: Border.all(color: StrideTokens.border2),
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // date chip
          Container(
            width: 36,
            padding: const EdgeInsets.symmetric(vertical: 4),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: StrideTokens.grid,
              borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
            ),
            child: Text(
              dateLabel,
              style: const TextStyle(
                fontFamily: AppTypography.fontMono,
                fontSize: StrideTokens.fs10,
                color: StrideTokens.muted,
              ),
            ),
          ),
          const SizedBox(width: StrideTokens.spaceSm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        session.plannedSummary.isNotEmpty
                            ? session.plannedSummary
                            : '—',
                        style: TextStyle(
                          fontFamily: AppTypography.fontSans,
                          fontSize: StrideTokens.fs13,
                          fontWeight: FontWeight.w600,
                          color: session.completed
                              ? StrideTokens.fg
                              : StrideTokens.muted,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    const SizedBox(width: StrideTokens.spaceSm),
                    statusPill,
                  ],
                ),
                if (session.completed) ...[
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      if (session.actualDistanceM != null)
                        _miniStat(
                          '${(session.actualDistanceM! / 1000).toStringAsFixed(1)} km',
                          Icons.straighten,
                        ),
                      if (session.actualAvgHr != null) ...[
                        const SizedBox(width: StrideTokens.spaceSm),
                        _miniStat(
                          '${session.actualAvgHr} bpm',
                          Icons.favorite_outline,
                        ),
                      ],
                      if (session.rpe != null) ...[
                        const SizedBox(width: StrideTokens.spaceSm),
                        _RpeBadge(rpe: session.rpe!),
                      ],
                    ],
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _miniStat(String text, IconData icon) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 11, color: StrideTokens.muted2),
        const SizedBox(width: 2),
        Text(
          text,
          style: const TextStyle(
            fontFamily: AppTypography.fontMono,
            fontSize: StrideTokens.fs11,
            color: StrideTokens.muted,
          ),
        ),
      ],
    );
  }

  String _shortDate(String iso) {
    // "2026-05-04" → "5/4"
    final parts = iso.split('-');
    if (parts.length < 3) return iso;
    return '${int.tryParse(parts[1]) ?? 0}/${int.tryParse(parts[2]) ?? 0}';
  }
}

class _RpeBadge extends StatelessWidget {
  const _RpeBadge({required this.rpe});

  final int rpe;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
      decoration: BoxDecoration(
        color: StrideTokens.grid,
        borderRadius: BorderRadius.circular(StrideTokens.radiusPill),
      ),
      child: Text(
        'RPE $rpe',
        style: const TextStyle(
          fontFamily: AppTypography.fontMono,
          fontSize: StrideTokens.fs10,
          color: StrideTokens.fgSoft,
        ),
      ),
    );
  }
}

// ── Insight Card ──────────────────────────────────────────────────────────────

class _InsightCard extends StatelessWidget {
  const _InsightCard({required this.insight});

  final Insight insight;

  @override
  Widget build(BuildContext context) {
    final pillVariant = switch (insight.level) {
      InsightLevel.positive => PillVariant.green,
      InsightLevel.warning => PillVariant.warn,
      InsightLevel.neutral => PillVariant.muted,
    };
    final typeLabel = switch (insight.type) {
      'completion' => '完成率',
      'load' => '负荷',
      'rpe' => '强度',
      'streak' => '连续',
      _ => insight.type,
    };

    return Container(
      padding: const EdgeInsets.all(StrideTokens.spaceMd),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        border: Border.all(color: StrideTokens.border2),
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          StridePill(text: typeLabel, variant: pillVariant),
          const SizedBox(width: StrideTokens.spaceSm),
          Expanded(
            child: Text(
              insight.text,
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs13,
                color: StrideTokens.fgSoft,
                height: 1.4,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ── Activity Highlight Card ───────────────────────────────────────────────────

class _ActivityHighlightCard extends StatelessWidget {
  const _ActivityHighlightCard({required this.highlight});

  final ActivityHighlight highlight;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(StrideTokens.spaceMd),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        border: Border.all(color: StrideTokens.border2),
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.auto_awesome, size: 14, color: StrideTokens.accent),
          const SizedBox(width: StrideTokens.spaceSm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  highlight.name.isNotEmpty ? highlight.name : highlight.date,
                  style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs13,
                    fontWeight: FontWeight.w600,
                    color: StrideTokens.fg,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                if (highlight.commentaryExcerpt.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(
                    highlight.commentaryExcerpt,
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs12,
                      color: StrideTokens.fgSoft,
                      height: 1.4,
                    ),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ── Next Week Card ────────────────────────────────────────────────────────────

class _NextWeekCard extends StatelessWidget {
  const _NextWeekCard({required this.preview});

  final NextWeekPreview? preview;

  @override
  Widget build(BuildContext context) {
    if (preview == null) {
      return Container(
        padding: const EdgeInsets.all(StrideTokens.spaceMd),
        decoration: BoxDecoration(
          color: StrideTokens.surface,
          border: Border.all(color: StrideTokens.border2),
          borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        ),
        child: const Text(
          '下周计划尚未生成',
          style: TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs13,
            color: StrideTokens.muted,
          ),
        ),
      );
    }

    final p = preview!;
    return GestureDetector(
      onTap: () {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('v1.x 周计划页即将开放')),
        );
      },
      child: Container(
        padding: const EdgeInsets.all(StrideTokens.spaceMd),
        decoration: BoxDecoration(
          color: StrideTokens.surface,
          border: Border.all(color: StrideTokens.border2),
          borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    p.planTitle ?? p.folder,
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs14,
                      fontWeight: FontWeight.w600,
                      color: StrideTokens.fg,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      Text(
                        '${p.totalPlannedDistanceKm.toStringAsFixed(0)} km',
                        style: const TextStyle(
                          fontFamily: AppTypography.fontMono,
                          fontSize: StrideTokens.fs12,
                          color: StrideTokens.muted,
                        ),
                      ),
                      const SizedBox(width: StrideTokens.spaceSm),
                      Text(
                        '${p.sessionsCount} 节课',
                        style: const TextStyle(
                          fontFamily: AppTypography.fontMono,
                          fontSize: StrideTokens.fs12,
                          color: StrideTokens.muted,
                        ),
                      ),
                    ],
                  ),
                  if (p.keySessionSummary != null) ...[
                    const SizedBox(height: 4),
                    Text(
                      p.keySessionSummary!,
                      style: const TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs12,
                        color: StrideTokens.fgSoft,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ],
              ),
            ),
            const Icon(Icons.chevron_right, size: 20, color: StrideTokens.muted2),
          ],
        ),
      ),
    );
  }
}

// ── Shared widgets ────────────────────────────────────────────────────────────

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({required this.title});

  final String title;

  @override
  Widget build(BuildContext context) {
    return Text(
      title,
      style: const TextStyle(
        fontFamily: AppTypography.fontSans,
        fontSize: StrideTokens.fs13,
        fontWeight: FontWeight.w600,
        color: StrideTokens.muted,
        letterSpacing: 0.5,
      ),
    );
  }
}

class _EmptyHint extends StatelessWidget {
  const _EmptyHint({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: StrideTokens.spaceXl),
      child: Center(
        child: Text(
          text,
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

class _ErrorBody extends StatelessWidget {
  const _ErrorBody({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(StrideTokens.space2xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 48, color: StrideTokens.danger),
            const SizedBox(height: StrideTokens.spaceLg),
            Text(
              '加载失败',
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs15,
                fontWeight: FontWeight.w600,
                color: StrideTokens.fg,
              ),
            ),
            const SizedBox(height: StrideTokens.spaceSm),
            Text(
              message,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs12,
                color: StrideTokens.muted,
              ),
            ),
            const SizedBox(height: StrideTokens.spaceLg),
            TextButton(onPressed: onRetry, child: const Text('重试')),
          ],
        ),
      ),
    );
  }
}
