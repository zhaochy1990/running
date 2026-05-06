import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/current_user.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/app_typography.dart';
import '../../data/models/activity.dart';
import '../../data/models/plan.dart';
import '../../data/repos/plan_repository.dart';
import '../../shared/utils/format.dart';

class TodayScreen extends ConsumerWidget {
  const TodayScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final userId = ref.watch(currentUserIdProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('今日')),
      body: userId == null
          ? const _LoadingState()
          : _TodayBody(userId: userId, theme: theme),
    );
  }
}

class _TodayBody extends ConsumerWidget {
  const _TodayBody({required this.userId, required this.theme});

  final String userId;
  final ThemeData theme;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final repo = ref.watch(planRepositoryProvider);
    return RefreshIndicator(
      onRefresh: () async {
        // Invalidate the provider so a new stream subscription kicks off.
        ref.invalidate(planRepositoryProvider);
      },
      child: StreamBuilder<PlanTodayResponse>(
        stream: repo.watchToday(userId),
        builder: (context, snapshot) {
          if (snapshot.hasError) {
            return _ErrorState(message: '${snapshot.error}');
          }
          if (!snapshot.hasData) return const _LoadingState();
          return _TodayContent(data: snapshot.data!);
        },
      ),
    );
  }
}

class _TodayContent extends StatelessWidget {
  const _TodayContent({required this.data});

  final PlanTodayResponse data;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final today = data.sessions.isNotEmpty ? data.sessions.first : null;
    final actuals = data.plannedVsActual
        .map((p) => p.actual)
        .whereType<Activity>()
        .toList();

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        // Today's planned session card
        if (today != null)
          _PlannedTodayCard(session: today)
        else
          Card(
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('今日休息', style: theme.textTheme.titleSmall),
                  const SizedBox(height: 8),
                  const Text('—', style: AppTypography.monoDisplay),
                  const SizedBox(height: 4),
                  Text('好好恢复', style: theme.textTheme.bodyMedium),
                ],
              ),
            ),
          ),

        if (data.nutrition != null) ...[
          const SizedBox(height: 12),
          _NutritionCard(nutrition: data.nutrition!),
        ],

        const SizedBox(height: 24),
        Text('最近活动', style: theme.textTheme.titleLarge),
        const SizedBox(height: 12),

        if (actuals.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 32),
            child: Center(
              child: Text(
                '本周还没有活动',
                style: theme.textTheme.bodySmall,
              ),
            ),
          )
        else
          for (final a in actuals.take(7)) ...[
            _ActivityRow(activity: a),
            if (a != actuals.last) const SizedBox(height: 8),
          ],
        const SizedBox(height: 24),
      ],
    );
  }
}

class _PlannedTodayCard extends StatelessWidget {
  const _PlannedTodayCard({required this.session});

  final PlannedSession session;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final distanceKm = session.totalDistanceM != null
        ? (session.totalDistanceM! / 1000).toStringAsFixed(1)
        : null;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text('今日训练', style: theme.textTheme.titleSmall),
                const Spacer(),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: AppColors.accent.withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    session.kind.toUpperCase(),
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: AppColors.accentDark,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            if (distanceKm != null)
              Text('$distanceKm km', style: AppTypography.monoDisplay)
            else
              Text(
                session.title ?? session.kind,
                style: AppTypography.monoHeadline,
              ),
            const SizedBox(height: 4),
            Text(
              [
                if (session.targetPace != null) '配速 ${session.targetPace}',
                if (session.targetHrZone != null) '心率 ${session.targetHrZone}',
                if (session.totalDurationS != null)
                  durationFmt(session.totalDurationS!.toInt()),
              ].join(' · '),
              style: AppTypography.monoBody.copyWith(
                color: AppColors.foregroundMuted,
              ),
            ),
            if (session.notes != null) ...[
              const SizedBox(height: 12),
              Text(
                session.notes!,
                style: theme.textTheme.bodyMedium,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _NutritionCard extends StatelessWidget {
  const _NutritionCard({required this.nutrition});

  final PlannedNutrition nutrition;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('今日营养', style: theme.textTheme.titleSmall),
            const SizedBox(height: 12),
            Row(
              children: [
                if (nutrition.kcalTarget != null)
                  _NutritionStat('热量', '${nutrition.kcalTarget!.round()}', 'kcal'),
                if (nutrition.proteinG != null)
                  _NutritionStat('蛋白', '${nutrition.proteinG!.round()}', 'g'),
                if (nutrition.carbsG != null)
                  _NutritionStat('碳水', '${nutrition.carbsG!.round()}', 'g'),
                if (nutrition.fatG != null)
                  _NutritionStat('脂肪', '${nutrition.fatG!.round()}', 'g'),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _NutritionStat extends StatelessWidget {
  const _NutritionStat(this.label, this.value, this.unit);
  final String label;
  final String value;
  final String unit;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: theme.textTheme.labelSmall),
          const SizedBox(height: 2),
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Text(value, style: AppTypography.monoTitle),
              const SizedBox(width: 2),
              Text(unit, style: theme.textTheme.bodySmall),
            ],
          ),
        ],
      ),
    );
  }
}

class _ActivityRow extends StatelessWidget {
  const _ActivityRow({required this.activity});
  final Activity activity;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: InkWell(
        onTap: () => GoRouter.of(context).go('/activity/${activity.labelId}'),
        borderRadius: BorderRadius.circular(8),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              Container(
                width: 4,
                height: 48,
                decoration: BoxDecoration(
                  color: AppColors.sportRun,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(formatDateShort(activity.date), style: theme.textTheme.bodySmall),
                    const SizedBox(height: 4),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.baseline,
                      textBaseline: TextBaseline.alphabetic,
                      children: [
                        Text(
                          activity.distanceKm.toStringAsFixed(1),
                          style: AppTypography.monoHeadline,
                        ),
                        const SizedBox(width: 2),
                        Text('km', style: theme.textTheme.bodySmall),
                        const Spacer(),
                        Text(activity.durationFmt, style: AppTypography.monoBody),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      [
                        activity.paceFmt,
                        if (activity.avgHr != null) '${activity.avgHr} bpm',
                      ].join(' · '),
                      style: AppTypography.monoCaption,
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _LoadingState extends StatelessWidget {
  const _LoadingState();

  @override
  Widget build(BuildContext context) {
    return const Center(child: CircularProgressIndicator(strokeWidth: 2));
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
            Text(
              '无法加载今日数据',
              style: theme.textTheme.titleMedium,
            ),
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
