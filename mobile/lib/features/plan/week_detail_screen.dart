import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/api_exception.dart';
import '../../core/auth/current_user.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/app_typography.dart';
import '../../data/api/stride_api.dart';
import '../../data/models/plan.dart';
import '../../data/repos/plan_repository.dart';
import '../../shared/utils/format.dart';

final _weekDetailProvider = FutureProvider.family<
    WeekDetail,
    ({String user, String folder})>((ref, args) async {
  return ref.watch(strideApiProvider).getWeek(args.user, args.folder);
});

class WeekDetailScreen extends ConsumerWidget {
  const WeekDetailScreen({required this.folder, super.key});

  final String folder;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(currentUserProvider);
    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.pop(),
        ),
        title: Text(_displayTitle(folder)),
        bottom: const TabBar(
          tabs: [
            Tab(text: '计划'),
            Tab(text: '日历'),
            Tab(text: '反馈'),
          ],
        ),
      ),
      body: user.when(
        loading: () =>
            const Center(child: CircularProgressIndicator(strokeWidth: 2)),
        error: (e, _) => Center(child: Text('$e')),
        data: (profile) {
          if (profile == null) {
            return const Center(child: CircularProgressIndicator(strokeWidth: 2));
          }
          return _WeekDetailBody(userId: profile.id, folder: folder);
        },
      ),
    );
  }

  /// '2026-05-04_05-10(W2)' → '2026-05-04 → 05-10 W2'
  static String _displayTitle(String folder) {
    final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})(?:\((.*)\))?$')
        .firstMatch(folder);
    if (m == null) return folder;
    final y = m.group(1)!;
    final from = '$y-${m.group(2)}-${m.group(3)}';
    final to = '${m.group(4)}-${m.group(5)}';
    final tag = m.group(6);
    return tag != null ? '$from → $to · $tag' : '$from → $to';
  }
}

class _WeekDetailBody extends ConsumerWidget {
  const _WeekDetailBody({required this.userId, required this.folder});
  final String userId;
  final String folder;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final week = ref.watch(_weekDetailProvider((user: userId, folder: folder)));
    return DefaultTabController(
      length: 3,
      child: TabBarView(
        children: [
          _PlanTab(state: week, userId: userId, folder: folder),
          _CalendarTab(folder: folder, userId: userId),
          _FeedbackTab(state: week),
        ],
      ),
    );
  }
}

// ── Tab 1 — Markdown plan ──────────────────────────────────────────────────

class _PlanTab extends ConsumerWidget {
  const _PlanTab({
    required this.state,
    required this.userId,
    required this.folder,
  });
  final AsyncValue<WeekDetail> state;
  final String userId;
  final String folder;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return RefreshIndicator(
      onRefresh: () async => ref.invalidate(
          _weekDetailProvider((user: userId, folder: folder))),
      child: state.when(
        loading: () => ListView(
          children: const [
            Padding(
              padding: EdgeInsets.symmetric(vertical: 64),
              child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
            ),
          ],
        ),
        error: (e, _) => ListView(
          padding: const EdgeInsets.all(24),
          children: [Center(child: Text('加载失败：$e'))],
        ),
        data: (data) {
          final content = (data.plan ?? '').trim();
          if (content.isEmpty) {
            return ListView(
              padding: const EdgeInsets.all(32),
              children: const [Center(child: Text('本周还没有计划文档'))],
            );
          }
          return ListView(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
            children: [
              MarkdownBody(
                data: content,
                shrinkWrap: true,
                styleSheet: _markdownStyle(Theme.of(context)),
              ),
            ],
          );
        },
      ),
    );
  }
}

// ── Tab 2 — Calendar (with push-to-watch) ─────────────────────────────────

class _CalendarTab extends ConsumerStatefulWidget {
  const _CalendarTab({required this.folder, required this.userId});
  final String folder;
  final String userId;

  @override
  ConsumerState<_CalendarTab> createState() => _CalendarTabState();
}

class _CalendarTabState extends ConsumerState<_CalendarTab> {
  final Set<String> _pushing = {};
  final Set<String> _justPushed = {};

  String _key(String date, int idx) => '$date#$idx';

  ({String from, String to}) _rangeFromFolder() {
    final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})')
        .firstMatch(widget.folder);
    if (m == null) {
      final now = DateTime.now();
      final monday = now.subtract(Duration(days: now.weekday - 1));
      return (from: _ymd(monday), to: _ymd(monday.add(const Duration(days: 6))));
    }
    final y = m.group(1)!;
    return (
      from: '$y-${m.group(2)}-${m.group(3)}',
      to: '$y-${m.group(4)}-${m.group(5)}',
    );
  }

  static String _ymd(DateTime d) =>
      '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

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
    final range = _rangeFromFolder();

    return RefreshIndicator(
      onRefresh: () async {
        setState(_justPushed.clear);
        ref.invalidate(planRepositoryProvider);
      },
      child: StreamBuilder<PlanDaysResponse>(
        stream: repo.watchDays(widget.userId, range.from, range.to),
        builder: (context, snap) {
          if (snap.hasError) {
            return ListView(
              padding: const EdgeInsets.all(24),
              children: [Center(child: Text('${snap.error}'))],
            );
          }
          if (!snap.hasData) {
            return ListView(
              children: const [
                Padding(
                  padding: EdgeInsets.symmetric(vertical: 64),
                  child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
                ),
              ],
            );
          }
          final days = snap.data!.days;
          if (days.isEmpty) {
            return ListView(
              padding: const EdgeInsets.all(32),
              children: const [Center(child: Text('本周暂无结构化计划'))],
            );
          }
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Text(
                '${range.from} → ${range.to}',
                style: theme.textTheme.titleSmall,
              ),
              const SizedBox(height: 12),
              for (final day in days)
                _DayCard(
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
                  Text(weekdayCN(day.date), style: theme.textTheme.titleMedium),
                  const SizedBox(width: 8),
                  Text(formatDateShort(day.date),
                      style: AppTypography.monoCaption),
                ],
              ),
              const SizedBox(height: 8),
              if (day.sessions.isEmpty)
                Text('休息日', style: theme.textTheme.bodyMedium)
              else
                for (final session in day.sessions) ...[
                  _SessionRow(
                    session: session,
                    isPushing: pushing
                        .contains(keyBuilder(day.date, session.sessionIndex)),
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
                Text(detail, style: AppTypography.monoCaption),
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
            child: Icon(Icons.check_circle,
                size: 18, color: AppColors.success),
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
    return Text(parts.join(' · '), style: AppTypography.monoCaption);
  }
}

// ── Tab 3 — Feedback ────────────────────────────────────────────────────────

class _FeedbackTab extends StatelessWidget {
  const _FeedbackTab({required this.state});
  final AsyncValue<WeekDetail> state;

  @override
  Widget build(BuildContext context) {
    return state.when(
      loading: () => const Center(
        child: CircularProgressIndicator(strokeWidth: 2),
      ),
      error: (e, _) => Padding(
        padding: const EdgeInsets.all(24),
        child: Center(child: Text('加载失败：$e')),
      ),
      data: (data) {
        final fb = (data.feedback ?? '').trim();
        if (fb.isEmpty) {
          return const Padding(
            padding: EdgeInsets.all(32),
            child: Center(child: Text('本周还没有训练反馈')),
          );
        }
        return ListView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
          children: [
            MarkdownBody(
              data: fb,
              shrinkWrap: true,
              styleSheet: _markdownStyle(Theme.of(context)),
            ),
          ],
        );
      },
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
    tableHead: AppTypography.monoCaption.copyWith(fontWeight: FontWeight.w600),
    tableBorder: TableBorder.all(color: AppColors.border, width: 0.5),
    blockquote: theme.textTheme.bodySmall?.copyWith(
      color: AppColors.foregroundMuted,
    ),
  );
}
