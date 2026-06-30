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
import '../_shared/widgets/refreshable.dart';
import '../_shared/widgets/top_bar.dart';
import 'models/activity_detail.dart';
import 'providers/activity_detail_provider.dart';
import 'utils/pace_format.dart';
import 'widgets/lap_table.dart';
import 'widgets/timeseries_chart.dart';
import 'widgets/zone_distribution.dart';

class ActivityDetailScreen extends ConsumerWidget {
  const ActivityDetailScreen({super.key, required this.activityId});

  final String activityId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final detailAsync = ref.watch(activityDetailProvider(activityId));

    final title =
        detailAsync.whenOrNull(
          data: (detail) => detail.activity.name ?? detail.activity.sportName,
          error: (e, _) => '加载失败',
        ) ??
        '活动详情';

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          tooltip: '返回',
          onPressed: () => Navigator.of(context).pop(),
        ),
        title: title,
      ),
      body: detailAsync.when(
        loading: () => const Center(
          child: CircularProgressIndicator(color: StrideTokens.accent),
        ),
        error: (err, _) => _ErrorBody(message: err.toString()),
        data: (detail) =>
            _DetailBody(detail: detail, activityId: activityId, ref: ref),
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
    final hrZones = ZoneUtils.hrZones(detail.zones);
    final paceZones = ZoneUtils.paceZones(detail.zones);

    return StrideRefreshable<ActivityDetailV2>(
      provider: activityDetailProvider(activityId).future,
      child: ListView(
        padding: const EdgeInsets.symmetric(
          horizontal: StrideTokens.spaceLg,
          vertical: StrideTokens.spaceLg,
        ),
        children: [
          // 1. GPS map placeholder
          // TODO(M1.x): replace with AMap widget with WGS84→GCJ02 conversion
          _GpsMapPlaceholder(),
          const SizedBox(height: StrideTokens.spaceLg),

          // 2. 8-metric summary grid
          _Card(child: _MetricGrid(detail: detail)),
          const SizedBox(height: StrideTokens.spaceLg),

          // 3. 配速 combined card: header + chart + zone distribution
          _ChartCard(
            eyebrow: '配速 PACE',
            stats: [
              _HeaderStat(label: '最快', value: _fastestPace(detail.laps, act)),
              _HeaderStat(label: '平均', value: _avgPace(act)),
            ],
            chart: TimeseriesChart(
              activityId: activityId,
              field: ChartField.pace,
              color: StrideTokens.accent,
            ),
            zones: paceZones.isNotEmpty
                ? ZoneDistribution(zones: paceZones, type: ZoneKind.pace)
                : null,
          ),
          const SizedBox(height: StrideTokens.spaceLg),

          // 4. 心率 combined card: header + chart + zone distribution
          _ChartCard(
            eyebrow: '心率 HEART RATE',
            stats: [
              _HeaderStat(
                label: '最大',
                value: act.maxHr != null ? '${act.maxHr}' : '--',
              ),
              _HeaderStat(
                label: '平均',
                value: act.avgHr != null ? '${act.avgHr}' : '--',
              ),
            ],
            chart: TimeseriesChart(
              activityId: activityId,
              field: ChartField.hr,
              color: StrideTokens.danger,
            ),
            zones: hrZones.isNotEmpty
                ? ZoneDistribution(zones: hrZones, type: ZoneKind.hr)
                : null,
          ),
          const SizedBox(height: StrideTokens.spaceLg),

          // 5. AI commentary card
          _CommentaryCard(activity: act, activityId: activityId, ref: ref),
          const SizedBox(height: StrideTokens.spaceLg),

          // 6. Splits table
          if (detail.laps.isNotEmpty) ...[
            const _SectionHeader(title: '分段配速'),
            const SizedBox(height: StrideTokens.spaceSm),
            _Card(child: LapTable(laps: detail.laps)),
            const SizedBox(height: StrideTokens.spaceLg),
          ],

          // 7. Training note
          _TrainingNoteSection(sportNote: act.sportNote),

          const SizedBox(height: StrideTokens.space3xl),
        ],
      ),
    );
  }

  /// Fastest pace = min over lap paces (by avg_pace if available), else the
  /// activity average. Uses lap `pace_fmt` strings parsed back to seconds.
  static String _fastestPace(List<LapV2> laps, ActivityV2 act) {
    int? best;
    for (final lap in laps) {
      final s = parsePaceFmt(lap.paceFmt);
      if (s != null && s > 0 && (best == null || s < best)) best = s;
    }
    if (best == null) return _avgPace(act);
    return fmtPaceSeconds(best);
  }

  static String _avgPace(ActivityV2 act) {
    if (act.avgPaceSKm != null && act.avgPaceSKm! > 0) {
      return fmtPaceSeconds(act.avgPaceSKm!.round());
    }
    final s = parsePaceFmt(act.paceFmt);
    return s != null ? fmtPaceSeconds(s) : '--';
  }
}

/// 8-metric summary grid: 4 columns × 2 rows.
class _MetricGrid extends StatelessWidget {
  const _MetricGrid({required this.detail});

  final ActivityDetailV2 detail;

  @override
  Widget build(BuildContext context) {
    final act = detail.activity;
    final cells = <_MetricCellData>[
      _MetricCellData(
        value: act.distanceKm.toStringAsFixed(2),
        label: '距离 / KM',
      ),
      _MetricCellData(value: _compactDurationFmt(act.durationFmt), label: '时长'),
      _MetricCellData(value: act.paceFmt, label: '平均配速 / KM'),
      _MetricCellData(
        value: act.avgHr != null ? '${act.avgHr}' : '--',
        label: '平均心率 / BPM',
      ),
      _MetricCellData(
        value: act.avgCadence != null ? '${act.avgCadence}' : '--',
        label: '平均步频 / SPM',
      ),
      _MetricCellData(
        value: act.avgStepLenCm != null
            ? (act.avgStepLenCm! / 100).toStringAsFixed(2)
            : '--',
        label: '平均步幅 / M',
      ),
      _MetricCellData(
        value: act.caloriesKcal != null
            ? act.caloriesKcal!.toStringAsFixed(0)
            : '--',
        label: '卡路里 / KCAL',
      ),
      _MetricCellData(
        value: detail.trainingDose != null
            ? detail.trainingDose!.toStringAsFixed(0)
            : '--',
        label: '训练负荷 / DOSE',
      ),
    ];

    return Column(
      children: [
        _MetricRow(cells: cells.sublist(0, 4)),
        const Divider(height: 1, color: StrideTokens.border2),
        _MetricRow(cells: cells.sublist(4, 8)),
      ],
    );
  }
}

class _MetricRow extends StatelessWidget {
  const _MetricRow({required this.cells});
  final List<_MetricCellData> cells;

  @override
  Widget build(BuildContext context) {
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var i = 0; i < cells.length; i++) ...[
            if (i > 0)
              const VerticalDivider(width: 1, color: StrideTokens.border2),
            Expanded(child: _MetricCell(data: cells[i])),
          ],
        ],
      ),
    );
  }
}

class _MetricCellData {
  const _MetricCellData({required this.value, required this.label});
  final String value;
  final String label;
}

String _compactDurationFmt(String raw) {
  final parts = raw.split(':');
  if (parts.length == 2) return raw;
  if (parts.length != 3) return raw;

  final h = int.tryParse(parts[0]);
  final m = int.tryParse(parts[1]);
  final s = int.tryParse(parts[2]);
  if (h == null || m == null || s == null) return raw;

  final mm = m.toString();
  final ss = s.toString().padLeft(2, '0');
  if (h <= 0) return '$mm:$ss';
  return '$h:${m.toString().padLeft(2, '0')}:$ss';
}

class _MetricCell extends StatelessWidget {
  const _MetricCell({required this.data});
  final _MetricCellData data;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: StrideTokens.spaceMd),
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: StrideTokens.spaceXs,
            ),
            child: FittedBox(
              fit: BoxFit.scaleDown,
              child: Text(
                data.value,
                maxLines: 1,
                style: const TextStyle(
                  fontFamily: AppTypography.fontMono,
                  fontSize: StrideTokens.fs20,
                  fontWeight: FontWeight.w700,
                  color: StrideTokens.fg,
                ),
              ),
            ),
          ),
          const SizedBox(height: StrideTokens.spaceXs),
          Text(
            data.label,
            textAlign: TextAlign.center,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              fontFamily: AppTypography.fontMono,
              fontSize: 9,
              color: StrideTokens.muted2,
              letterSpacing: 0.4,
            ),
          ),
        ],
      ),
    );
  }
}

/// A combined card: eyebrow + header stats, a chart, and zone distribution.
class _ChartCard extends StatelessWidget {
  const _ChartCard({
    required this.eyebrow,
    required this.stats,
    required this.chart,
    this.zones,
  });

  final String eyebrow;
  final List<_HeaderStat> stats;
  final Widget chart;
  final Widget? zones;

  @override
  Widget build(BuildContext context) {
    return _Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: Text(
                  eyebrow,
                  style: const TextStyle(
                    fontFamily: AppTypography.fontMono,
                    fontSize: StrideTokens.fs11,
                    fontWeight: FontWeight.w500,
                    color: StrideTokens.muted2,
                    letterSpacing: 1.2,
                  ),
                ),
              ),
              for (final s in stats) ...[
                const SizedBox(width: StrideTokens.spaceMd),
                _HeaderStatView(stat: s),
              ],
            ],
          ),
          const SizedBox(height: StrideTokens.spaceMd),
          chart,
          if (zones != null) ...[
            const SizedBox(height: StrideTokens.spaceMd),
            zones!,
          ],
        ],
      ),
    );
  }
}

class _HeaderStat {
  const _HeaderStat({required this.label, required this.value});
  final String label;
  final String value;
}

class _HeaderStatView extends StatelessWidget {
  const _HeaderStatView({required this.stat});
  final _HeaderStat stat;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.end,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          stat.label,
          style: const TextStyle(
            fontFamily: AppTypography.fontMono,
            fontSize: 9,
            color: StrideTokens.muted2,
          ),
        ),
        Text(
          stat.value,
          style: const TextStyle(
            fontFamily: AppTypography.fontMono,
            fontSize: StrideTokens.fs14,
            fontWeight: FontWeight.w600,
            color: StrideTokens.fg,
          ),
        ),
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
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('重新生成失败，请稍后再试')));
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
              const Icon(
                Icons.auto_awesome,
                size: 14,
                color: StrideTokens.accent,
              ),
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
            const Icon(
              Icons.error_outline,
              size: 48,
              color: StrideTokens.danger,
            ),
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
