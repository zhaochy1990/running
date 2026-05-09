import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/current_user.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/app_typography.dart';
import '../../data/api/stride_api.dart';
import '../../data/models/plan.dart';

final _trainingPlanProvider =
    FutureProvider.family<TrainingPlanResponse, String>((ref, user) async {
  return ref.watch(strideApiProvider).getTrainingPlan(user);
});

final _weeksProvider =
    FutureProvider.family<List<WeekIndexEntry>, String>((ref, user) async {
  return ref.watch(strideApiProvider).listWeeks(user);
});

class PlanOverviewScreen extends ConsumerWidget {
  const PlanOverviewScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(currentUserProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('训练计划')),
      body: user.when(
        loading: () =>
            const Center(child: CircularProgressIndicator(strokeWidth: 2)),
        error: (e, _) => _ErrorState(message: '$e'),
        data: (profile) {
          if (profile == null) {
            return const Center(child: CircularProgressIndicator(strokeWidth: 2));
          }
          return _OverviewBody(userId: profile.id);
        },
      ),
    );
  }
}

class _OverviewBody extends ConsumerWidget {
  const _OverviewBody({required this.userId});
  final String userId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final plan = ref.watch(_trainingPlanProvider(userId));
    final weeks = ref.watch(_weeksProvider(userId));

    return RefreshIndicator(
      onRefresh: () async {
        ref
          ..invalidate(_trainingPlanProvider(userId))
          ..invalidate(_weeksProvider(userId));
      },
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _OverallPlanCard(state: plan),
          const SizedBox(height: 24),
          _WeeksHeader(state: weeks),
          const SizedBox(height: 12),
          ..._weeksList(context, weeks),
          const SizedBox(height: 24),
        ],
      ),
    );
  }

  List<Widget> _weeksList(BuildContext context, AsyncValue<List<WeekIndexEntry>> state) {
    final theme = Theme.of(context);
    return state.when(
      loading: () => const [
        Padding(
          padding: EdgeInsets.symmetric(vertical: 24),
          child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
        ),
      ],
      error: (e, _) => [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 24),
          child: Center(
            child: Text('加载训练周失败：$e', style: theme.textTheme.bodySmall),
          ),
        ),
      ],
      data: (list) {
        if (list.isEmpty) {
          return [
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 24),
              child: Center(
                child: Text('还没有训练周', style: theme.textTheme.bodySmall),
              ),
            ),
          ];
        }
        // Newest first; the API returns chronological so reverse here.
        final ordered = List<WeekIndexEntry>.from(list).reversed.toList();
        return [
          for (final w in ordered) _WeekRow(week: w),
        ];
      },
    );
  }
}

class _OverallPlanCard extends StatefulWidget {
  const _OverallPlanCard({required this.state});
  final AsyncValue<TrainingPlanResponse> state;

  @override
  State<_OverallPlanCard> createState() => _OverallPlanCardState();
}

class _OverallPlanCardState extends State<_OverallPlanCard> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final state = widget.state;

    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
        child: state.when(
          loading: () => const Padding(
            padding: EdgeInsets.symmetric(vertical: 16),
            child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
          ),
          error: (e, _) => Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Text('加载总体计划失败：$e', style: theme.textTheme.bodySmall),
          ),
          data: (resp) {
            final hasContent = (resp.content ?? '').trim().isNotEmpty;
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text('总体训练计划',
                          style: theme.textTheme.titleMedium),
                    ),
                    if (resp.currentPhase != null)
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 8, vertical: 2),
                        decoration: BoxDecoration(
                          color: AppColors.accent.withValues(alpha: 0.15),
                          borderRadius: BorderRadius.circular(4),
                        ),
                        child: Text(
                          resp.currentPhase!,
                          style: theme.textTheme.labelSmall?.copyWith(
                            color: AppColors.accentDark,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                  ],
                ),
                if (resp.phases.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  _PhaseTimeline(
                    phases: resp.phases,
                    current: resp.currentPhase,
                  ),
                ],
                if (hasContent) ...[
                  const SizedBox(height: 12),
                  InkWell(
                    onTap: () => setState(() => _expanded = !_expanded),
                    child: Row(
                      children: [
                        Text(
                          _expanded ? '收起详细计划' : '查看详细计划',
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: AppColors.accentDark,
                          ),
                        ),
                        Icon(
                          _expanded ? Icons.expand_less : Icons.expand_more,
                          size: 16,
                          color: AppColors.accentDark,
                        ),
                      ],
                    ),
                  ),
                  if (_expanded) ...[
                    const SizedBox(height: 8),
                    MarkdownBody(
                      data: resp.content!,
                      shrinkWrap: true,
                      styleSheet: _markdownStyle(theme),
                    ),
                  ],
                ] else ...[
                  const SizedBox(height: 8),
                  Text('暂无 TRAINING_PLAN.md', style: theme.textTheme.bodySmall),
                ],
              ],
            );
          },
        ),
      ),
    );
  }
}

class _PhaseTimeline extends StatelessWidget {
  const _PhaseTimeline({required this.phases, required this.current});
  final List<TrainingPhase> phases;
  final String? current;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 8,
      runSpacing: 6,
      children: [
        for (final p in phases)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              border: Border.all(
                color: p.name == current
                    ? AppColors.accentDark
                    : AppColors.border,
              ),
              borderRadius: BorderRadius.circular(4),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  p.name,
                  style: AppTypography.monoCaption.copyWith(
                    color: p.name == current
                        ? AppColors.accentDark
                        : AppColors.foregroundMuted,
                    fontWeight: p.name == current
                        ? FontWeight.w600
                        : FontWeight.w400,
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

class _WeeksHeader extends StatelessWidget {
  const _WeeksHeader({required this.state});
  final AsyncValue<List<WeekIndexEntry>> state;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final count = state.valueOrNull?.length ?? 0;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.baseline,
      textBaseline: TextBaseline.alphabetic,
      children: [
        Text('训练周', style: theme.textTheme.titleLarge),
        const SizedBox(width: 8),
        if (count > 0)
          Text('$count 周', style: AppTypography.monoCaption),
      ],
    );
  }
}

class _WeekRow extends StatelessWidget {
  const _WeekRow({required this.week});
  final WeekIndexEntry week;

  bool get _containsToday {
    final now = DateTime.now();
    final today =
        '${now.year.toString().padLeft(4, '0')}-${now.month.toString().padLeft(2, '0')}-${now.day.toString().padLeft(2, '0')}';
    return week.dateFrom.compareTo(today) <= 0 &&
        week.dateTo.compareTo(today) >= 0;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Card(
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: () =>
              context.push('/plan/weeks/${Uri.encodeComponent(week.folder)}'),
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Text(
                            '${week.dateFrom} → ${week.dateTo}',
                            style: AppTypography.monoBody,
                          ),
                          if (_containsToday) ...[
                            const SizedBox(width: 8),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 6, vertical: 1),
                              decoration: BoxDecoration(
                                color: AppColors.accent.withValues(alpha: 0.18),
                                borderRadius: BorderRadius.circular(3),
                              ),
                              child: Text(
                                '本周',
                                style: theme.textTheme.labelSmall?.copyWith(
                                  color: AppColors.accentDark,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                          ],
                        ],
                      ),
                      if (week.planTitle != null && week.planTitle!.isNotEmpty) ...[
                        const SizedBox(height: 4),
                        Text(
                          week.planTitle!,
                          style: theme.textTheme.bodyMedium,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ] else if (!week.hasPlan) ...[
                        const SizedBox(height: 4),
                        Text('（无计划）',
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: AppColors.foregroundSubtle,
                            )),
                      ],
                    ],
                  ),
                ),
                const Icon(
                  Icons.arrow_forward_ios,
                  size: 14,
                  color: AppColors.foregroundMuted,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

MarkdownStyleSheet _markdownStyle(ThemeData theme) {
  return MarkdownStyleSheet(
    p: theme.textTheme.bodyMedium,
    h1: theme.textTheme.titleLarge,
    h2: theme.textTheme.titleMedium,
    h3: theme.textTheme.titleSmall,
    code: AppTypography.monoCaption.copyWith(
      backgroundColor: AppColors.surfaceMuted,
    ),
    tableBody: AppTypography.monoCaption,
    tableHead: AppTypography.monoCaption.copyWith(
      fontWeight: FontWeight.w600,
    ),
    tableBorder: TableBorder.all(color: AppColors.border, width: 0.5),
    blockquote: theme.textTheme.bodySmall?.copyWith(
      color: AppColors.foregroundMuted,
    ),
  );
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
            const Icon(Icons.cloud_off,
                size: 32, color: AppColors.foregroundMuted),
            const SizedBox(height: 12),
            Text('无法加载训练计划', style: theme.textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(message,
                style: theme.textTheme.bodySmall, textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }
}
