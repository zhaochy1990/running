import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_exception.dart';
import '../../core/auth/current_user.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/app_typography.dart';
import '../../data/api/stride_api.dart';
import '../../data/models/plan.dart';
import '../../data/repos/plan_repository.dart';
import '../../shared/utils/format.dart';

/// Resolves the current week's folder by listing all weeks and picking the
/// one whose [date_from..date_to] (inclusive) contains today.
final _currentWeekProvider =
    FutureProvider.family<WeekDetail?, String>((ref, user) async {
  try {
    final weeks = await ref.read(strideApiProvider).listWeeks(user);
    final today = DateTime.now();
    final todayIso =
        '${today.year.toString().padLeft(4, '0')}-${today.month.toString().padLeft(2, '0')}-${today.day.toString().padLeft(2, '0')}';
    WeekIndexEntry? match;
    for (final w in weeks) {
      if (w.dateFrom.compareTo(todayIso) <= 0 &&
          w.dateTo.compareTo(todayIso) >= 0) {
        match = w;
        break;
      }
    }
    // Fallback: most recent week (weeks are typically newest-first from the API)
    match ??= weeks.isNotEmpty ? weeks.first : null;
    if (match == null) return null;
    return ref.read(strideApiProvider).getWeek(user, match.folder);
  } catch (_) {
    return null;
  }
});

class PlanScreen extends ConsumerWidget {
  const PlanScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(currentUserProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('本周计划')),
      body: user.when(
        loading: () => const Center(child: CircularProgressIndicator(strokeWidth: 2)),
        error: (e, _) => _ErrorState(message: '$e'),
        data: (profile) {
          if (profile == null) {
            return const Center(child: CircularProgressIndicator(strokeWidth: 2));
          }
          return _PlanBody(userId: profile.id);
        },
      ),
    );
  }
}

class _PlanBody extends ConsumerStatefulWidget {
  const _PlanBody({required this.userId});
  final String userId;

  @override
  ConsumerState<_PlanBody> createState() => _PlanBodyState();
}

class _PlanBodyState extends ConsumerState<_PlanBody> {
  /// Local "I just pushed this session" state, keyed by `date#sessionIndex`.
  /// Disables the push button until the next refresh confirms.
  final Set<String> _pushing = {};
  final Set<String> _justPushed = {};

  ({String from, String to}) _weekRange() {
    final now = DateTime.now();
    final weekday = now.weekday; // 1=Mon, 7=Sun
    final monday = now.subtract(Duration(days: weekday - 1));
    final sunday = monday.add(const Duration(days: 6));
    return (from: _ymd(monday), to: _ymd(sunday));
  }

  static String _ymd(DateTime d) =>
      '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  String _key(String date, int idx) => '$date#$idx';

  Future<void> _push(String date, int sessionIndex) async {
    final key = _key(date, sessionIndex);
    setState(() => _pushing.add(key));

    try {
      await ref
          .read(strideApiProvider)
          .pushPlannedSession(widget.userId, date, sessionIndex);
      if (!mounted) return;
      setState(() {
        _pushing.remove(key);
        _justPushed.add(key);
      });
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('已推送到手表')),
      );
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _pushing.remove(key));
      _showError(e);
    } catch (e) {
      if (!mounted) return;
      setState(() => _pushing.remove(key));
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('推送失败：$e')),
      );
    }
  }

  void _showError(ApiException e) {
    if (e.isConflict) {
      // selection_conflict — the date already has a different pushed session.
      showDialog<void>(
        context: context,
        builder: (_) => AlertDialog(
          title: const Text('该日期已有推送'),
          content: const Text(
            '这一天已经推送过其它训练课。\n\n'
            '在 COROS 表上手动删除旧的 [STRIDE] 训练后再试，'
            '或者在网页端使用"强制覆盖"。',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('知道了'),
            ),
          ],
        ),
      );
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('推送失败：${e.message}')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final repo = ref.watch(planRepositoryProvider);
    final range = _weekRange();

    final week = ref.watch(_currentWeekProvider(widget.userId));
    return RefreshIndicator(
      onRefresh: () async {
        setState(_justPushed.clear);
        ref
          ..invalidate(planRepositoryProvider)
          ..invalidate(_currentWeekProvider(widget.userId));
      },
      child: StreamBuilder<PlanDaysResponse>(
        stream: repo.watchDays(widget.userId, range.from, range.to),
        builder: (context, snap) {
          if (snap.hasError) return _ErrorState(message: '${snap.error}');
          if (!snap.hasData) {
            return const Center(child: CircularProgressIndicator(strokeWidth: 2));
          }
          final days = snap.data!.days;
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              if (week.valueOrNull?.plan != null)
                _WeekPlanMarkdown(week: week.value!),
              if (week.valueOrNull?.plan != null) const SizedBox(height: 16),
              Text(
                '${range.from} → ${range.to}',
                style: theme.textTheme.titleSmall,
              ),
              const SizedBox(height: 12),
              if (days.isEmpty)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 32),
                  child: Center(child: Text('本周暂无结构化计划')),
                )
              else
                for (final day in days) _DayCard(
                  day: day,
                  pushing: _pushing,
                  justPushed: _justPushed,
                  onPush: _push,
                  keyBuilder: _key,
                ),
            ],
          );
        },
      ),
    );
  }
}

class _WeekPlanMarkdown extends StatefulWidget {
  const _WeekPlanMarkdown({required this.week});
  final WeekDetail week;

  @override
  State<_WeekPlanMarkdown> createState() => _WeekPlanMarkdownState();
}

class _WeekPlanMarkdownState extends State<_WeekPlanMarkdown> {
  bool _expanded = true;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            InkWell(
              onTap: () => setState(() => _expanded = !_expanded),
              child: Row(
                children: [
                  Expanded(
                    child: Text('本周训练计划',
                        style: theme.textTheme.titleMedium),
                  ),
                  Icon(
                    _expanded ? Icons.expand_less : Icons.expand_more,
                    size: 18,
                    color: AppColors.foregroundMuted,
                  ),
                ],
              ),
            ),
            if (_expanded) ...[
              const SizedBox(height: 4),
              Text(
                '${widget.week.dateFrom} → ${widget.week.dateTo}',
                style: AppTypography.monoCaption,
              ),
              const SizedBox(height: 8),
              MarkdownBody(
                data: widget.week.plan!,
                shrinkWrap: true,
                styleSheet: MarkdownStyleSheet(
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
                  tableBorder: TableBorder.all(
                    color: AppColors.border, width: 0.5,
                  ),
                  blockquote: theme.textTheme.bodySmall?.copyWith(
                    color: AppColors.foregroundMuted,
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _DayCard extends StatelessWidget {
  const _DayCard({
    required this.day,
    required this.pushing,
    required this.justPushed,
    required this.onPush,
    required this.keyBuilder,
  });

  final PlanDay day;
  final Set<String> pushing;
  final Set<String> justPushed;
  final void Function(String date, int sessionIndex) onPush;
  final String Function(String date, int sessionIndex) keyBuilder;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text(
                    weekdayCN(day.date),
                    style: theme.textTheme.titleMedium,
                  ),
                  const SizedBox(width: 8),
                  Text(
                    formatDateShort(day.date),
                    style: AppTypography.monoCaption,
                  ),
                ],
              ),
              const SizedBox(height: 8),
              if (day.sessions.isEmpty)
                Text('休息日', style: theme.textTheme.bodyMedium)
              else
                for (final session in day.sessions) ...[
                  _SessionRow(
                    session: session,
                    isPushing:
                        pushing.contains(keyBuilder(day.date, session.sessionIndex)),
                    isJustPushed: justPushed
                        .contains(keyBuilder(day.date, session.sessionIndex)),
                    onPush: () => onPush(day.date, session.sessionIndex),
                  ),
                  if (session != day.sessions.last)
                    const Divider(height: 16, color: AppColors.border),
                ],
              if (day.nutrition != null) ...[
                const SizedBox(height: 8),
                _NutritionLine(nutrition: day.nutrition!),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _SessionRow extends StatelessWidget {
  const _SessionRow({
    required this.session,
    required this.isPushing,
    required this.isJustPushed,
    required this.onPush,
  });

  final PlannedSession session;
  final bool isPushing;
  final bool isJustPushed;
  final VoidCallback onPush;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final distanceKm = session.totalDistanceM != null
        ? (session.totalDistanceM! / 1000).toStringAsFixed(1)
        : null;
    final distanceText =
        distanceKm != null ? '$distanceKm km' : (session.title ?? session.kind);
    final detail = [
      if (session.targetPace != null) '配速 ${session.targetPace}',
      if (session.targetHrZone != null) session.targetHrZone!,
      if (session.totalDurationS != null)
        durationFmt(session.totalDurationS!.toInt()),
    ].join(' · ');

    return Row(
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
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
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(distanceText, style: AppTypography.monoTitle),
              if (detail.isNotEmpty) ...[
                const SizedBox(height: 2),
                Text(
                  detail,
                  style: AppTypography.monoCaption,
                ),
              ],
            ],
          ),
        ),
        if (session.pushable && !isJustPushed)
          IconButton(
            icon: isPushing
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.send_outlined, size: 18),
            color: AppColors.foregroundMuted,
            tooltip: '推送到手表',
            onPressed: isPushing ? null : onPush,
          )
        else if (isJustPushed)
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 8),
            child: Icon(
              Icons.check_circle,
              size: 18,
              color: AppColors.success,
            ),
          ),
      ],
    );
  }
}

class _NutritionLine extends StatelessWidget {
  const _NutritionLine({required this.nutrition});
  final PlannedNutrition nutrition;

  @override
  Widget build(BuildContext context) {
    final parts = <String>[
      if (nutrition.kcalTarget != null) '${nutrition.kcalTarget!.round()} kcal',
      if (nutrition.proteinG != null) '蛋白 ${nutrition.proteinG!.round()}g',
      if (nutrition.carbsG != null) '碳水 ${nutrition.carbsG!.round()}g',
      if (nutrition.fatG != null) '脂肪 ${nutrition.fatG!.round()}g',
    ];
    if (parts.isEmpty) return const SizedBox.shrink();
    return Text(
      parts.join(' · '),
      style: AppTypography.monoCaption,
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
            const Icon(Icons.cloud_off,
                size: 32, color: AppColors.foregroundMuted),
            const SizedBox(height: 12),
            Text('无法加载本周计划', style: theme.textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(message,
                style: theme.textTheme.bodySmall, textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }
}
