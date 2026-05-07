import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/current_user.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/app_typography.dart';
import '../../data/models/activity.dart';
import '../../data/repos/activity_repository.dart';
import '../../shared/utils/format.dart';
import 'charts/timeseries_chart.dart';
import 'charts/zones_bar.dart';

class ActivityDetailScreen extends ConsumerWidget {
  const ActivityDetailScreen({
    required this.activityId,
    this.teamId,
    this.ownerUserId,
    super.key,
  });

  final String activityId;
  final String? teamId;
  final String? ownerUserId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Team feed activity → use the activity owner's id; else self.
    final user = ref.watch(currentUserProvider);

    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.pop(),
        ),
        title: Text(teamId != null ? '跑团活动' : '活动详情'),
      ),
      body: user.when(
        loading: () => const Center(child: CircularProgressIndicator(strokeWidth: 2)),
        error: (e, _) => _ErrorState(message: '$e'),
        data: (profile) {
          final ownerId = ownerUserId ?? profile?.id;
          if (ownerId == null) return const _ErrorState(message: '未登录');
          return _ActivityBody(
            userId: ownerId,
            labelId: activityId,
            teamId: teamId,
          );
        },
      ),
    );
  }
}

class _ActivityBody extends ConsumerWidget {
  const _ActivityBody({
    required this.userId,
    required this.labelId,
    this.teamId,
  });

  final String userId;
  final String labelId;
  final String? teamId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final repo = ref.watch(activityRepositoryProvider);
    return RefreshIndicator(
      onRefresh: () async {
        ref.invalidate(activityRepositoryProvider);
      },
      child: StreamBuilder<ActivityDetailResponse>(
        stream: repo.watchActivity(userId, labelId, teamId: teamId),
        builder: (context, snapshot) {
          if (snapshot.hasError) {
            return _ErrorState(message: '${snapshot.error}');
          }
          if (!snapshot.hasData) {
            return const Center(child: CircularProgressIndicator(strokeWidth: 2));
          }
          return _ActivityContent(detail: snapshot.data!);
        },
      ),
    );
  }
}

class _ActivityContent extends StatelessWidget {
  const _ActivityContent({required this.detail});

  final ActivityDetailResponse detail;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final activity = detail.activity;

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _HeroCard(activity: activity),
        const SizedBox(height: 16),
        _SecondaryStats(activity: activity),
        const SizedBox(height: 24),
        if (detail.timeseries.isNotEmpty) ...[
          _ChartSection(
            title: '心率',
            unit: 'bpm',
            color: AppColors.danger,
            extractor: (p) => p.heartRate?.toDouble(),
            timeseries: detail.timeseries,
          ),
          const SizedBox(height: 16),
          _ChartSection(
            title: '配速',
            unit: 's/km',
            color: AppColors.sportRun,
            extractor: (p) => p.speed != null && p.speed! > 0
                ? (1000 / p.speed!.toDouble())
                : null,
            invertY: true,
            timeseries: detail.timeseries,
          ),
          const SizedBox(height: 16),
          _ChartSection(
            title: '海拔',
            unit: 'm',
            color: AppColors.sportTrail,
            extractor: (p) => p.altitude?.toDouble(),
            timeseries: detail.timeseries,
          ),
          const SizedBox(height: 16),
          _ChartSection(
            title: '步频',
            unit: 'spm',
            color: AppColors.sportTrack,
            extractor: (p) => p.cadence != null
                ? p.cadence!.toDouble() * 2 // single-leg → both legs
                : null,
            timeseries: detail.timeseries,
          ),
          const SizedBox(height: 24),
        ],
        if (detail.zones.any((z) => z.zoneType == 'hr')) ...[
          Text('心率区间', style: theme.textTheme.titleLarge),
          const SizedBox(height: 12),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: ZonesBar(
                zones: detail.zones.where((z) => z.zoneType == 'hr').toList(),
              ),
            ),
          ),
          const SizedBox(height: 24),
        ],
        if (detail.laps.isNotEmpty) ...[
          Text('分段', style: theme.textTheme.titleLarge),
          const SizedBox(height: 12),
          _LapsTable(laps: detail.laps),
          const SizedBox(height: 24),
        ],
        if (detail.segments.isNotEmpty) ...[
          Text('训练段', style: theme.textTheme.titleLarge),
          const SizedBox(height: 12),
          _SegmentsList(segments: detail.segments),
          const SizedBox(height: 24),
        ],
        if (activity.sportNote != null && activity.sportNote!.trim().isNotEmpty) ...[
          _NoteCard(
            title: '训练反馈',
            body: activity.sportNote!,
            footer: activity.feelType != null
                ? '感受: ${_feelTypeLabel(activity.feelType!)}'
                : null,
          ),
          const SizedBox(height: 16),
        ],
        if (activity.commentary != null && activity.commentary!.trim().isNotEmpty)
          _NoteCard(
            title: '教练点评',
            body: activity.commentary!,
            footer: activity.commentaryGeneratedBy != null
                ? '生成: ${activity.commentaryGeneratedBy}'
                : null,
          ),
        const SizedBox(height: 32),
      ],
    );
  }

  static String _feelTypeLabel(int feelType) {
    switch (feelType) {
      case 1:
        return '很好';
      case 2:
        return '好';
      case 3:
        return '一般';
      case 4:
        return '差';
      case 5:
        return '很差';
      default:
        return '$feelType';
    }
  }
}

class _HeroCard extends StatelessWidget {
  const _HeroCard({required this.activity});

  final Activity activity;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text(
                  activity.name ?? activity.sportName,
                  style: theme.textTheme.titleSmall,
                ),
                const Spacer(),
                Text(formatDate(activity.date), style: AppTypography.monoCaption),
              ],
            ),
            const SizedBox(height: 12),
            Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Text(
                  activity.distanceKm.toStringAsFixed(2),
                  style: AppTypography.monoDisplay,
                ),
                const SizedBox(width: 4),
                Text('km', style: theme.textTheme.titleMedium),
              ],
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 16,
              runSpacing: 4,
              children: [
                Text(activity.durationFmt, style: AppTypography.monoTitle),
                Text(activity.paceFmt, style: AppTypography.monoTitle),
                if (activity.avgHr != null)
                  Text('${activity.avgHr} bpm',
                      style: AppTypography.monoTitle.copyWith(
                        color: AppColors.danger,
                      )),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _SecondaryStats extends StatelessWidget {
  const _SecondaryStats({required this.activity});

  final Activity activity;

  @override
  Widget build(BuildContext context) {
    final stats = <_Stat>[
      if (activity.maxHr != null)
        _Stat(label: '最大心率', value: '${activity.maxHr}', unit: 'bpm'),
      if (activity.avgCadence != null)
        _Stat(label: '平均步频', value: '${activity.avgCadence! * 2}', unit: 'spm'),
      if (activity.caloriesKcal != null)
        _Stat(
            label: '热量',
            value: activity.caloriesKcal!.round().toString(),
            unit: 'kcal'),
      if (activity.trainingLoad != null)
        _Stat(
            label: '负荷',
            value: activity.trainingLoad!.round().toString(),
            unit: ''),
      if (activity.ascentM != null)
        _Stat(label: '爬升', value: activity.ascentM!.round().toString(), unit: 'm'),
      if (activity.aerobicEffect != null)
        _Stat(
            label: '有氧',
            value: activity.aerobicEffect!.toStringAsFixed(1),
            unit: ''),
      if (activity.anaerobicEffect != null)
        _Stat(
            label: '无氧',
            value: activity.anaerobicEffect!.toStringAsFixed(1),
            unit: ''),
      if (activity.vo2max != null)
        _Stat(label: 'VO₂max', value: activity.vo2max!.toStringAsFixed(0), unit: ''),
    ];
    if (stats.isEmpty) return const SizedBox.shrink();
    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Wrap(
          spacing: 24,
          runSpacing: 12,
          children: stats,
        ),
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.label, required this.value, required this.unit});

  final String label;
  final String value;
  final String unit;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(label, style: theme.textTheme.labelSmall),
        const SizedBox(height: 2),
        Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            Text(value, style: AppTypography.monoTitle),
            if (unit.isNotEmpty) ...[
              const SizedBox(width: 2),
              Text(unit, style: theme.textTheme.bodySmall),
            ],
          ],
        ),
      ],
    );
  }
}

typedef _PointExtractor = double? Function(TimeseriesPoint);

class _ChartSection extends StatelessWidget {
  const _ChartSection({
    required this.title,
    required this.unit,
    required this.color,
    required this.extractor,
    required this.timeseries,
    this.invertY = false,
  });

  final String title;
  final String unit;
  final Color color;
  final _PointExtractor extractor;
  final List<TimeseriesPoint> timeseries;
  final bool invertY;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final points = <({double x, double y})>[];
    for (var i = 0; i < timeseries.length; i++) {
      final value = extractor(timeseries[i]);
      if (value == null) continue;
      final x = timeseries[i].timestamp?.toDouble() ?? i.toDouble();
      points.add((x: x, y: value));
    }
    if (points.isEmpty) return const SizedBox.shrink();

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: theme.textTheme.titleSmall),
            const SizedBox(height: 12),
            TimeseriesChart(
              points: points,
              color: color,
              unit: unit,
              invertY: invertY,
            ),
          ],
        ),
      ),
    );
  }
}

class _LapsTable extends StatelessWidget {
  const _LapsTable({required this.laps});

  final List<Lap> laps;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Column(
          children: [
            const _LapHeader(),
            const Divider(height: 1, color: AppColors.border),
            for (final lap in laps) ...[
              _LapRow(lap: lap),
              if (lap != laps.last)
                const Divider(height: 1, color: AppColors.border),
            ],
          ],
        ),
      ),
    );
  }
}

class _LapHeader extends StatelessWidget {
  const _LapHeader();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        children: [
          SizedBox(
            width: 32,
            child: Text('#',
                style: AppTypography.monoCaption.copyWith(
                  color: AppColors.foregroundSubtle,
                )),
          ),
          Expanded(
            child: Text('距离',
                style: AppTypography.monoCaption.copyWith(
                  color: AppColors.foregroundSubtle,
                )),
          ),
          Expanded(
            child: Text('用时',
                style: AppTypography.monoCaption.copyWith(
                  color: AppColors.foregroundSubtle,
                )),
          ),
          Expanded(
            child: Text('配速',
                style: AppTypography.monoCaption.copyWith(
                  color: AppColors.foregroundSubtle,
                )),
          ),
          Expanded(
            child: Text('心率',
                textAlign: TextAlign.end,
                style: AppTypography.monoCaption.copyWith(
                  color: AppColors.foregroundSubtle,
                )),
          ),
        ],
      ),
    );
  }
}

class _LapRow extends StatelessWidget {
  const _LapRow({required this.lap});

  final Lap lap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(
        children: [
          SizedBox(
            width: 32,
            child: Text('${lap.lapIndex}', style: AppTypography.monoBody),
          ),
          Expanded(
            child: Text(
              '${lap.distanceKm.toStringAsFixed(2)} km',
              style: AppTypography.monoBody,
            ),
          ),
          Expanded(child: Text(lap.durationFmt, style: AppTypography.monoBody)),
          Expanded(child: Text(lap.paceFmt, style: AppTypography.monoBody)),
          Expanded(
            child: Text(
              lap.avgHr != null ? '${lap.avgHr}' : '—',
              textAlign: TextAlign.end,
              style: AppTypography.monoBody.copyWith(
                color: lap.avgHr != null ? AppColors.danger : AppColors.foregroundSubtle,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _SegmentsList extends StatelessWidget {
  const _SegmentsList({required this.segments});

  final List<Segment> segments;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Column(
        children: [
          for (final seg in segments)
            ExpansionTile(
              shape: const Border(),
              tilePadding: const EdgeInsets.symmetric(horizontal: 16),
              title: Text(seg.segName, style: AppTypography.monoBody),
              subtitle: Text(
                '${seg.distanceKm.toStringAsFixed(2)} km · ${seg.durationFmt}',
                style: AppTypography.monoCaption,
              ),
              trailing: Text(seg.paceFmt, style: AppTypography.monoBody),
              childrenPadding:
                  const EdgeInsets.fromLTRB(16, 0, 16, 12),
              children: [
                Row(
                  children: [
                    if (seg.avgHr != null)
                      Expanded(
                        child: Text('心率 ${seg.avgHr}',
                            style: AppTypography.monoCaption),
                      ),
                    if (seg.avgCadence != null)
                      Expanded(
                        child: Text('步频 ${seg.avgCadence! * 2}',
                            style: AppTypography.monoCaption),
                      ),
                    if (seg.ascentM != null)
                      Expanded(
                        child: Text('爬升 ${seg.ascentM!.round()}m',
                            style: AppTypography.monoCaption),
                      ),
                  ],
                ),
              ],
            ),
        ],
      ),
    );
  }
}

class _NoteCard extends StatelessWidget {
  const _NoteCard({required this.title, required this.body, this.footer});

  final String title;
  final String body;
  final String? footer;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: theme.textTheme.titleSmall),
            const SizedBox(height: 8),
            Text(body, style: theme.textTheme.bodyMedium),
            if (footer != null) ...[
              const SizedBox(height: 8),
              Text(footer!, style: AppTypography.monoCaption),
            ],
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
            Text('无法加载活动详情', style: theme.textTheme.titleMedium),
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
