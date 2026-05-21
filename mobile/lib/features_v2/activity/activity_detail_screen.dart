/// D8 — Activity Detail Screen
///
/// Long-scroll layout (no tabs). Initial fetch: `GET /api/{user}/activities/{id}`
/// without timeseries. HR/pace charts lazy-load via [timeseriesProvider] once
/// widgets build.
///
/// GPS map is a placeholder — real map integration is TODO for M1.x.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../../data/api/stride_api.dart';
import '../../core/auth/current_user.dart';
import '../../core/theme/pill_colors.dart';
import '../_shared/widgets/pill.dart';
import '../_shared/widgets/screen_hero.dart';
import '../_shared/widgets/stat_row.dart';
import 'models/activity_detail.dart';
import 'providers/activity_detail_provider.dart';
import 'widgets/lap_table.dart';
import 'widgets/timeseries_chart.dart';

class ActivityDetailScreen extends ConsumerWidget {
  const ActivityDetailScreen({super.key, required this.activityId});

  final String activityId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final detailAsync = ref.watch(activityDetailProvider(activityId));

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      body: SafeArea(
        bottom: false,
        child: detailAsync.when(
          loading: () => Column(
            children: [
              StrideScreenHero.withBack(eyebrow: '活动详情', title: '加载中…'),
              const Expanded(
                child: Center(
                  child: CircularProgressIndicator(color: StrideTokens.accent),
                ),
              ),
            ],
          ),
          error: (err, _) => Column(
            children: [
              StrideScreenHero.withBack(eyebrow: '活动详情', title: '加载失败'),
              Expanded(child: _ErrorBody(message: err.toString())),
            ],
          ),
          data: (detail) => Column(
            children: [
              StrideScreenHero.withBack(
                eyebrow: '活动 · ${detail.activity.sportName}',
                title: detail.activity.name ?? detail.activity.sportName,
                deck: '${detail.activity.date} · ${detail.activity.durationFmt}',
              ),
              Expanded(
                child: _DetailBody(
                  detail: detail,
                  activityId: activityId,
                  ref: ref,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _DetailBody extends StatelessWidget {
  const _DetailBody({
    required this.detail,
    required this.activityId,
    required this.ref,
  });

  final ActivityDetailV2 detail;
  final String activityId;
  final WidgetRef ref;

  @override
  Widget build(BuildContext context) {
    final act = detail.activity;

    return ListView(
      padding: const EdgeInsets.symmetric(
        horizontal: StrideTokens.spaceLg,
        vertical: StrideTokens.spaceLg,
      ),
      children: [
        // 2. GPS map placeholder
        // TODO(M1.x): replace with AMap widget with WGS84→GCJ02 conversion
        _GpsMapPlaceholder(),
        const SizedBox(height: StrideTokens.spaceLg),

        // 3. Primary stat row: distance / duration / pace
        _Card(
          child: StrideStatRow(items: [
            StatItem(
              label: '距离',
              value: act.distanceKm.toStringAsFixed(2),
              unit: 'km',
            ),
            StatItem(
              label: '时长',
              value: act.durationFmt,
            ),
            StatItem(
              label: '配速',
              value: act.paceFmt,
            ),
          ]),
        ),
        const SizedBox(height: StrideTokens.spaceSm),

        // 4. Secondary stat row: HR / calories / elevation
        _Card(
          child: StrideStatRow(items: [
            StatItem(
              label: '心率',
              value: act.avgHr != null ? '${act.avgHr}' : '--',
              unit: 'bpm',
            ),
            StatItem(
              label: '卡路里',
              value: act.caloriesKcal != null
                  ? act.caloriesKcal!.toStringAsFixed(0)
                  : '--',
              unit: 'kcal',
            ),
            StatItem(
              label: '累计爬升',
              value: act.ascentM != null
                  ? act.ascentM!.toStringAsFixed(0)
                  : '--',
              unit: 'm',
            ),
          ]),
        ),
        const SizedBox(height: StrideTokens.spaceLg),

        // 5. AI commentary card
        _CommentaryCard(
          activity: act,
          activityId: activityId,
          ref: ref,
        ),
        const SizedBox(height: StrideTokens.spaceLg),

        // 6. Laps section
        if (detail.laps.isNotEmpty) ...[
          const _SectionHeader(title: '分段数据'),
          const SizedBox(height: StrideTokens.spaceSm),
          _Card(child: LapTable(laps: detail.laps)),
          const SizedBox(height: StrideTokens.spaceLg),
        ],

        // 7. HR chart (lazy-load)
        const _SectionHeader(title: '心率曲线'),
        const SizedBox(height: StrideTokens.spaceSm),
        _Card(
          child: TimeseriesChart(
            activityId: activityId,
            field: ChartField.hr,
            color: StrideTokens.danger,
          ),
        ),
        const SizedBox(height: StrideTokens.spaceLg),

        // 8. Pace chart (lazy-load)
        const _SectionHeader(title: '配速曲线'),
        const SizedBox(height: StrideTokens.spaceSm),
        _Card(
          child: TimeseriesChart(
            activityId: activityId,
            field: ChartField.pace,
            color: StrideTokens.accent,
          ),
        ),
        const SizedBox(height: StrideTokens.spaceLg),

        // 9. Training note
        _TrainingNoteSection(sportNote: act.sportNote),

        const SizedBox(height: StrideTokens.space3xl),
      ],
    );
  }
}

class _GpsMapPlaceholder extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Container(
      height: 180,
      decoration: BoxDecoration(
        color: StrideTokens.grid,
        borderRadius: BorderRadius.circular(StrideTokens.radiusLg),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.map_outlined, size: 36, color: StrideTokens.muted2),
            SizedBox(height: StrideTokens.spaceSm),
            Text(
              'GPS 轨迹',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs13,
                color: StrideTokens.muted,
              ),
            ),
            Text(
              'M1.x 接入高德地图',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs11,
                color: StrideTokens.muted2,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _CommentaryCard extends StatefulWidget {
  const _CommentaryCard({
    required this.activity,
    required this.activityId,
    required this.ref,
  });

  final ActivityV2 activity;
  final String activityId;
  final WidgetRef ref;

  @override
  State<_CommentaryCard> createState() => _CommentaryCardState();
}

class _CommentaryCardState extends State<_CommentaryCard> {
  bool _regenerating = false;

  Future<void> _onRegenerate() async {
    if (_regenerating) return;
    setState(() => _regenerating = true);
    try {
      final userId = widget.ref.read(currentUserIdProvider);
      if (userId != null) {
        final api = widget.ref.read(strideApiProvider);
        await api.regenerateCommentary(userId, widget.activityId);
        // Invalidate detail to reload commentary
        widget.ref.invalidate(activityDetailProvider(widget.activityId));
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('重新生成失败，请稍后再试')),
        );
      }
    } finally {
      if (mounted) setState(() => _regenerating = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final commentary = widget.activity.commentary;
    final hasCommentary = commentary != null && commentary.isNotEmpty;

    return Container(
      padding: const EdgeInsets.all(StrideTokens.spaceMd),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        border: Border.all(color: StrideTokens.border2),
        borderRadius: BorderRadius.circular(StrideTokens.radiusLg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.auto_awesome,
                  size: 14, color: StrideTokens.accent),
              const SizedBox(width: StrideTokens.spaceXs),
              const Text(
                'AI 点评',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs13,
                  fontWeight: FontWeight.w600,
                  color: StrideTokens.fg,
                ),
              ),
              if (widget.activity.commentaryGeneratedBy != null) ...[
                const SizedBox(width: StrideTokens.spaceXs),
                StridePill(
                  text: widget.activity.commentaryGeneratedBy!,
                  variant: PillVariant.muted,
                  dense: true,
                ),
              ],
              const Spacer(),
              GestureDetector(
                onTap: _regenerating ? null : _onRegenerate,
                child: _regenerating
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: StrideTokens.accent,
                        ),
                      )
                    : const Text(
                        '重新生成',
                        style: TextStyle(
                          fontFamily: AppTypography.fontSans,
                          fontSize: StrideTokens.fs12,
                          color: StrideTokens.accent,
                        ),
                      ),
              ),
            ],
          ),
          const SizedBox(height: StrideTokens.spaceSm),
          Text(
            hasCommentary ? commentary : '暂无 AI 点评',
            style: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs13,
              color: hasCommentary ? StrideTokens.fgSoft : StrideTokens.muted,
              height: 1.6,
            ),
          ),
        ],
      ),
    );
  }
}

class _TrainingNoteSection extends StatelessWidget {
  const _TrainingNoteSection({this.sportNote});
  final String? sportNote;

  @override
  Widget build(BuildContext context) {
    final hasNote = sportNote != null && sportNote!.isNotEmpty;
    return _Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Row(
            children: [
              Icon(Icons.edit_note, size: 16, color: StrideTokens.muted),
              SizedBox(width: StrideTokens.spaceXs),
              Text(
                '训练反馈',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs13,
                  fontWeight: FontWeight.w600,
                  color: StrideTokens.fg,
                ),
              ),
            ],
          ),
          const SizedBox(height: StrideTokens.spaceSm),
          Text(
            hasNote ? sportNote! : 'v1.x 即将支持填反馈',
            style: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs13,
              color: hasNote ? StrideTokens.fgSoft : StrideTokens.muted,
              height: 1.6,
              fontStyle: hasNote ? FontStyle.normal : FontStyle.italic,
            ),
          ),
        ],
      ),
    );
  }
}

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

class _Card extends StatelessWidget {
  const _Card({required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(StrideTokens.spaceMd),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        border: Border.all(color: StrideTokens.border2),
        borderRadius: BorderRadius.circular(StrideTokens.radiusLg),
      ),
      child: child,
    );
  }
}

class _ErrorBody extends StatelessWidget {
  const _ErrorBody({required this.message});
  final String message;

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
            const Text(
              '加载失败',
              style: TextStyle(
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
          ],
        ),
      ),
    );
  }
}
