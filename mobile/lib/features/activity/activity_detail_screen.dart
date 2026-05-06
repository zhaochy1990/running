import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/app_typography.dart';

class ActivityDetailScreen extends StatelessWidget {
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
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.pop(),
        ),
        title: Text(teamId != null ? '战队活动' : '活动详情'),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(
            'Activity #$activityId',
            style: theme.textTheme.titleSmall,
          ),
          const SizedBox(height: 8),
          const Text('12.0 km', style: AppTypography.monoDisplay),
          const Text('2026-05-06 06:18', style: AppTypography.monoCaption),
          const SizedBox(height: 24),
          Container(
            height: 240,
            decoration: BoxDecoration(
              color: AppColors.surface,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: AppColors.border),
            ),
            child: Center(
              child: Text(
                'HR / 配速 / 海拔 chart 占位 — fl_chart 实装在 S7',
                style: theme.textTheme.bodySmall,
              ),
            ),
          ),
          const SizedBox(height: 24),
          Text('分段', style: theme.textTheme.titleLarge),
          const SizedBox(height: 12),
          for (var i = 0; i < 4; i++)
            _LapRow(
              lapIndex: i + 1,
              distance: '${i + 3}.0',
              pace: '5:${30 + i * 5}',
              hr: '${145 + i * 5}',
            ),
        ],
      ),
    );
  }
}

class _LapRow extends StatelessWidget {
  const _LapRow({
    required this.lapIndex,
    required this.distance,
    required this.pace,
    required this.hr,
  });

  final int lapIndex;
  final String distance;
  final String pace;
  final String hr;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        children: [
          SizedBox(
            width: 40,
            child: Text(
              '#$lapIndex',
              style: AppTypography.monoCaption,
            ),
          ),
          Expanded(child: Text('$distance km', style: AppTypography.monoBody)),
          Expanded(child: Text('$pace/km', style: AppTypography.monoBody)),
          Expanded(child: Text('$hr bpm', style: AppTypography.monoBody)),
        ],
      ),
    );
  }
}
