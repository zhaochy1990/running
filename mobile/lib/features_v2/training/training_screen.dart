/// 训练 tab（/training）—— 镜像小程序 pages/index「今日」页。
///
/// 结构：周日期条（切换任意日）→ 当日活动卡（缩略图容错）→ 今日课表卡
/// （强度柱状图/指标/教练备注/推送手表 ±7 天弹层/和教练聊一聊）→ 今日营养卡。
/// 数据源：结构化周课表（plan/weeks/{weekName}）+ 当日活动（activities）。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/current_user.dart';
import '../../core/router/routes.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../../data/api/stride_api.dart';
import '../../data/models/activity.dart';
import '../../shared/utils/format.dart';
import '../../shared/utils/shanghai_date.dart';
import '../../core/theme/pill_colors.dart';
import '../_shared/widgets/pill.dart';
import '../_shared/widgets/top_bar.dart';
import '../coach/providers/coach_chat_provider.dart';
import 'day_view.dart';
import 'providers/training_providers.dart';

class TrainingScreen extends ConsumerStatefulWidget {
  const TrainingScreen({super.key});

  @override
  ConsumerState<TrainingScreen> createState() => _TrainingScreenState();
}

class _TrainingScreenState extends ConsumerState<TrainingScreen> {
  late String _selectedDate = shanghaiToday();
  bool _pushing = false;

  @override
  Widget build(BuildContext context) {
    final planAsync = ref.watch(weeklyPlanProvider);
    final dayView = buildDayView(planAsync.valueOrNull, _selectedDate);

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        title: '本周训练',
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: StrideTokens.spaceLg),
            child: Center(
              child: Text(
                dayView.subtitle,
                style: const TextStyle(
                  fontFamily: AppTypography.fontMono,
                  fontSize: StrideTokens.fs11,
                  color: StrideTokens.muted,
                  letterSpacing: 0.4,
                ),
              ),
            ),
          ),
        ],
      ),
      body: RefreshIndicator(
        color: StrideTokens.accent,
        onRefresh: () async {
          ref.invalidate(weeklyPlanProvider);
          ref.invalidate(dayActivitiesProvider(_selectedDate));
          await ref.read(weeklyPlanProvider.future);
        },
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.only(bottom: StrideTokens.space2xl),
          children: [
            _WeekDayBar(
              days: dayView.weekDays,
              selectedDate: _selectedDate,
              today: shanghaiToday(),
              onTap: (date) => setState(() => _selectedDate = date),
            ),
            _DaySection(
              dayView: dayView,
              selectedDate: _selectedDate,
              pushing: _pushing,
              onPush: _showPushSheet,
              onCoach: _goCoach,
              onActivity: (id) => context.push(Routes.activityDetail(id)),
            ),
          ],
        ),
      ),
    );
  }

  /// 推送手表：±7 天日期弹层（对齐小程序 buildPushDateOptions，今天起 8 个选项）。
  Future<void> _showPushSheet(TodayWorkoutView workout) async {
    if (!workout.hasSpec) {
      _toast('该训练暂不支持推送');
      return;
    }
    final options = buildPushDateOptions(workout.date);
    final selected = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: StrideTokens.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(StrideTokens.radiusLg),
        ),
      ),
      builder: (sheetCtx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Padding(
              padding: EdgeInsets.all(StrideTokens.spaceLg),
              child: Text(
                '推送到手表 · 选择日期',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs15,
                  fontWeight: FontWeight.w700,
                  color: StrideTokens.fg,
                ),
              ),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final option in options)
                    ListTile(
                      dense: true,
                      title: Text(
                        option.label,
                        style: TextStyle(
                          fontFamily: AppTypography.fontSans,
                          fontSize: StrideTokens.fs14,
                          color: option.selected
                              ? StrideTokens.accent
                              : StrideTokens.fg,
                          fontWeight: option.selected
                              ? FontWeight.w600
                              : FontWeight.w400,
                        ),
                      ),
                      trailing: option.selected
                          ? const Icon(Icons.check,
                              size: 18, color: StrideTokens.accent)
                          : null,
                      onTap: () => Navigator.of(sheetCtx).pop(option.value),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
    if (selected == null || !mounted) return;

    setState(() => _pushing = true);
    try {
      final api = ref.read(strideApiProvider);
      final userId = ref.read(currentUserIdProvider);
      if (userId == null) throw Exception('用户未登录');
      await api.pushPlannedSession(
        userId,
        workout.date,
        workout.sessionIndex,
        targetDate: selected,
      );
      ref.invalidate(weeklyPlanProvider);
      if (mounted) _toast('推送成功');
    } catch (e) {
      if (mounted) _toast('推送失败');
    } finally {
      if (mounted) setState(() => _pushing = false);
    }
  }

  /// 「和教练聊一聊」——把当前课节作为预填消息交给教练 tab（带上下文跳转）。
  void _goCoach(TodayWorkoutView? workout) {
    if (workout == null) {
      _toast('今日暂无训练安排');
      return;
    }
    final label =
        '${workout.title} · ${int.parse(workout.date.substring(5, 7))}月${int.parse(workout.date.substring(8))}日';
    ref.read(pendingCoachMessageProvider.notifier).state =
        '关于 $label 的训练，帮我看看有什么要注意的？';
    context.go(Routes.coach);
  }

  void _toast(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), duration: const Duration(seconds: 2)),
    );
  }
}

// ── 周日期条 ──────────────────────────────────────────────────────────────────

class _WeekDayBar extends StatelessWidget {
  const _WeekDayBar({
    required this.days,
    required this.selectedDate,
    required this.today,
    required this.onTap,
  });

  final List<WeekDay> days;
  final String selectedDate;
  final String today;
  final ValueChanged<String> onTap;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(
        StrideTokens.spaceLg,
        StrideTokens.spaceMd,
        StrideTokens.spaceLg,
        StrideTokens.spaceLg,
      ),
      padding: const EdgeInsets.symmetric(
        horizontal: StrideTokens.spaceXs,
        vertical: StrideTokens.spaceSm,
      ),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Row(
        children: [
          for (final day in days)
            Expanded(
              child: _WeekDayCell(
                day: day,
                selected: day.date == selectedDate,
                isToday: day.date == today,
                onTap: () => onTap(day.date),
              ),
            ),
        ],
      ),
    );
  }
}

class _WeekDayCell extends StatelessWidget {
  const _WeekDayCell({
    required this.day,
    required this.selected,
    required this.isToday,
    required this.onTap,
  });

  final WeekDay day;
  final bool selected;
  final bool isToday;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final labelColor = selected
        ? StrideTokens.accent
        : (isToday ? StrideTokens.fg : StrideTokens.muted);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: StrideTokens.spaceXs),
        child: Column(
          children: [
            Text(
              day.label,
              style: TextStyle(
                fontFamily: AppTypography.fontMono,
                fontSize: StrideTokens.fs11,
                color: labelColor,
                fontWeight: isToday ? FontWeight.w700 : FontWeight.w400,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              '${day.dayNumber}',
              style: TextStyle(
                fontFamily: AppTypography.fontMono,
                fontSize: StrideTokens.fs15,
                fontWeight: FontWeight.w600,
                color: selected ? StrideTokens.accent : StrideTokens.fg,
              ),
            ),
            const SizedBox(height: 3),
            Container(
              width: 4,
              height: 4,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: isToday ? StrideTokens.accent : Colors.transparent,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ── 当日内容 ──────────────────────────────────────────────────────────────────

class _DaySection extends ConsumerWidget {
  const _DaySection({
    required this.dayView,
    required this.selectedDate,
    required this.pushing,
    required this.onPush,
    required this.onCoach,
    required this.onActivity,
  });

  final DayView dayView;
  final String selectedDate;
  final bool pushing;
  final ValueChanged<TodayWorkoutView> onPush;
  final ValueChanged<TodayWorkoutView?> onCoach;
  final ValueChanged<String> onActivity;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final activitiesAsync = ref.watch(dayActivitiesProvider(selectedDate));

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // ── 当日活动（仅当天有实际运动记录时展示）──
        activitiesAsync.when(
          loading: () => const SizedBox.shrink(),
          error: (_, _) => const SizedBox.shrink(),
          data: (activities) => activities.isEmpty
              ? const SizedBox.shrink()
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _SectionTitle('今日活动 · ${dayView.dayLabel}'),
                    _ActivitiesCard(activities: activities, onTap: onActivity),
                  ],
                ),
        ),

        // ── 今日课表 ──
        _SectionTitle('今日安排 · ${dayView.dayLabel}'),
        if (dayView.workout != null)
          _WorkoutCard(
            workout: dayView.workout!,
            pushing: pushing,
            onPush: onPush,
            onCoach: onCoach,
          )
        else
          const _EmptyWorkoutCard(),

        // ── 今日营养（无饮食安排时整块隐藏）──
        if (dayView.nutrition != null) ...[
          _SectionTitle('今日饮食营养'),
          _NutritionCard(nutrition: dayView.nutrition!),
        ],
      ],
    );
  }
}

// ── 当日活动卡 ────────────────────────────────────────────────────────────────

class _ActivitiesCard extends StatelessWidget {
  const _ActivitiesCard({required this.activities, required this.onTap});

  final List<Activity> activities;
  final ValueChanged<String> onTap;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(
        StrideTokens.spaceLg,
        0,
        StrideTokens.spaceLg,
        StrideTokens.spaceLg,
      ),
      decoration: _cardDecoration(),
      child: Column(
        children: [
          for (var i = 0; i < activities.length; i++) ...[
            if (i > 0)
              const Divider(
                height: 1,
                indent: StrideTokens.spaceLg,
                endIndent: StrideTokens.spaceLg,
                color: StrideTokens.border2,
              ),
            _ActivityRow(
              activity: activities[i],
              onTap: () => onTap(activities[i].labelId),
            ),
          ],
        ],
      ),
    );
  }
}

class _ActivityRow extends StatefulWidget {
  const _ActivityRow({required this.activity, required this.onTap});

  final Activity activity;
  final VoidCallback onTap;

  @override
  State<_ActivityRow> createState() => _ActivityRowState();
}

class _ActivityRowState extends State<_ActivityRow> {
  bool _thumbFailed = false;

  @override
  Widget build(BuildContext context) {
    final a = widget.activity;
    final thumb = a.thumbUrl;
    final showThumb = thumb != null && thumb.isNotEmpty && !_thumbFailed;

    return InkWell(
      onTap: widget.onTap,
      child: Padding(
        padding: const EdgeInsets.all(StrideTokens.spaceLg),
        child: Row(
          children: [
            // 缩略图（有路线图就展示，加载失败/缺失回退运动图标）
            ClipRRect(
              borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
              child: SizedBox(
                width: 48,
                height: 48,
                child: showThumb
                    ? Image.network(
                        thumb,
                        fit: BoxFit.cover,
                        errorBuilder: (_, _, _) => _sportIcon(a.sportName),
                      )
                    : _sportIcon(a.sportName),
              ),
            ),
            const SizedBox(width: StrideTokens.spaceMd),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    (a.name?.isNotEmpty ?? false) ? a.name! : a.sportName,
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs14,
                      fontWeight: FontWeight.w600,
                      color: StrideTokens.fg,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 2),
                  Text(
                    _metaText(a),
                    style: const TextStyle(
                      fontFamily: AppTypography.fontMono,
                      fontSize: StrideTokens.fs12,
                      color: StrideTokens.muted,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
            const SizedBox(width: StrideTokens.spaceMd),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(
                  a.trainingLoad != null && a.trainingLoad! > 0
                      ? a.trainingLoad!.toStringAsFixed(1)
                      : '—',
                  style: const TextStyle(
                    fontFamily: AppTypography.fontMono,
                    fontSize: StrideTokens.fs14,
                    fontWeight: FontWeight.w600,
                    color: StrideTokens.fg,
                  ),
                ),
                const Text(
                  '负荷',
                  style: TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs10,
                    color: StrideTokens.muted,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _sportIcon(String sportName) {
    final n = sportName.toLowerCase();
    final icon = n.contains('strength')
        ? Icons.fitness_center
        : (n.contains('run') || n.contains('treadmill') || n.contains('trail'))
            ? Icons.directions_run
            : Icons.schedule;
    return Container(
      color: StrideTokens.accentFg,
      alignment: Alignment.center,
      child: Icon(icon, size: 22, color: StrideTokens.accent),
    );
  }

  String _metaText(Activity a) {
    final parts = <String>[
      if (a.distanceM > 0) '${(a.distanceM / 1000).toStringAsFixed(2)} km',
      if (a.durationS > 0) fmtDurationShort(a.durationS),
      if (a.avgPaceSKm != null && a.avgPaceSKm! > 0) paceFmt(a.avgPaceSKm!),
      if (a.avgHr != null && a.avgHr! > 0) '${a.avgHr} bpm',
    ];
    return parts.isEmpty ? '—' : parts.join(' · ');
  }
}

// ── 今日课表卡 ────────────────────────────────────────────────────────────────

class _WorkoutCard extends StatelessWidget {
  const _WorkoutCard({
    required this.workout,
    required this.pushing,
    required this.onPush,
    required this.onCoach,
  });

  final TodayWorkoutView workout;
  final bool pushing;
  final ValueChanged<TodayWorkoutView> onPush;
  final ValueChanged<TodayWorkoutView?> onCoach;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(
        StrideTokens.spaceLg,
        0,
        StrideTokens.spaceLg,
        StrideTokens.spaceLg,
      ),
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: _cardDecoration(),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 头部：标题 + 推送操作
          Row(
            children: [
              Expanded(
                child: Text(
                  workout.title,
                  style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs15,
                    fontWeight: FontWeight.w700,
                    color: StrideTokens.fg,
                  ),
                ),
              ),
              if (workout.scheduledWorkoutId != null)
                const Padding(
                  padding: EdgeInsets.only(right: StrideTokens.spaceSm),
                  child: const StridePill(text: '已推送', variant: PillVariant.green, dense: true),
                ),
              IconButton(
                onPressed: pushing ? null : () => onPush(workout),
                icon: const Icon(Icons.watch_outlined, size: 20),
                color: StrideTokens.accent,
                tooltip: '推送到手表',
                visualDensity: VisualDensity.compact,
              ),
            ],
          ),

          // 强度柱状图（仅跑课）
          if (workout.isRunning && workout.intensityBars.isNotEmpty) ...[
            const SizedBox(height: StrideTokens.spaceSm),
            const Text(
              '课表内容',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs11,
                color: StrideTokens.muted,
                letterSpacing: 0.5,
              ),
            ),
            const SizedBox(height: StrideTokens.spaceSm),
            SizedBox(
              height: 56,
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  for (final bar in workout.intensityBars)
                    Expanded(
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 1.5),
                        child: FractionallySizedBox(
                          heightFactor: bar.pct / 100,
                          alignment: Alignment.bottomCenter,
                          child: Container(
                            decoration: BoxDecoration(
                              color: StrideTokens.accent
                                  .withValues(alpha: bar.dim ? 0.6 : 1),
                              borderRadius: BorderRadius.circular(2),
                            ),
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ],
          const SizedBox(height: StrideTokens.spaceMd),

          // 指标
          Row(
            children: [
              for (final stat in workout.stats)
                Expanded(child: _Stat(value: stat.value, label: stat.label)),
            ],
          ),

          // 教练备注
          if (workout.coachNote.isNotEmpty) ...[
            const SizedBox(height: StrideTokens.spaceMd),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(StrideTokens.spaceMd),
              decoration: BoxDecoration(
                color: StrideTokens.accentFg,
                borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    '教练备注',
                    style: TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs11,
                      fontWeight: FontWeight.w600,
                      color: StrideTokens.accent,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    workout.coachNote,
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs13,
                      color: StrideTokens.fgSoft,
                      height: 1.5,
                    ),
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(height: StrideTokens.spaceMd),

          // 和教练聊一聊
          SizedBox(
            width: double.infinity,
            height: 44,
            child: OutlinedButton.icon(
              onPressed: () => onCoach(workout),
              icon: const Icon(Icons.forum_outlined, size: 18),
              label: const Text(
                '和教练聊一聊',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs14,
                  fontWeight: FontWeight.w600,
                ),
              ),
              style: OutlinedButton.styleFrom(
                foregroundColor: StrideTokens.accent,
                side: const BorderSide(color: StrideTokens.accent),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _EmptyWorkoutCard extends StatelessWidget {
  const _EmptyWorkoutCard();

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: () => context.push(Routes.planWeeks),
      child: Container(
        margin: const EdgeInsets.fromLTRB(
          StrideTokens.spaceLg,
          0,
          StrideTokens.spaceLg,
          StrideTokens.spaceLg,
        ),
        padding: const EdgeInsets.all(StrideTokens.space2xl),
        decoration: _cardDecoration(),
        child: const Column(
          children: [
            Text(
              '今日无训练安排',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs15,
                fontWeight: FontWeight.w600,
                color: StrideTokens.fg,
              ),
            ),
            SizedBox(height: 4),
            Text(
              '好好休息，或查看本周计划',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs13,
                color: StrideTokens.accent,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ── 营养卡 ────────────────────────────────────────────────────────────────────

class _NutritionCard extends StatelessWidget {
  const _NutritionCard({required this.nutrition});

  final TodayNutritionView nutrition;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(
        StrideTokens.spaceLg,
        0,
        StrideTokens.spaceLg,
        StrideTokens.spaceLg,
      ),
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: _cardDecoration(),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (nutrition.hasTargets) ...[
            Row(
              children: [
                for (final stat in nutrition.targetsTop) ...[
                  Expanded(child: _Stat(value: stat.value, label: stat.label)),
                ],
              ],
            ),
            const SizedBox(height: StrideTokens.spaceMd),
            Row(
              children: [
                for (final stat in nutrition.targetsBottom)
                  Expanded(child: _Stat(value: stat.value, label: stat.label)),
              ],
            ),
            const SizedBox(height: StrideTokens.spaceMd),
          ],
          for (final meal in nutrition.meals) ...[
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        meal.timeHint.isEmpty
                            ? meal.name
                            : '${meal.name} · ${meal.timeHint}',
                        style: const TextStyle(
                          fontFamily: AppTypography.fontSans,
                          fontSize: StrideTokens.fs14,
                          fontWeight: FontWeight.w600,
                          color: StrideTokens.fg,
                        ),
                      ),
                      if (meal.detail.isNotEmpty)
                        Text(
                          meal.detail,
                          style: const TextStyle(
                            fontFamily: AppTypography.fontSans,
                            fontSize: StrideTokens.fs12,
                            color: StrideTokens.muted,
                          ),
                        ),
                    ],
                  ),
                ),
                Text(
                  meal.kcal,
                  style: const TextStyle(
                    fontFamily: AppTypography.fontMono,
                    fontSize: StrideTokens.fs13,
                    color: StrideTokens.fgSoft,
                  ),
                ),
              ],
            ),
            const SizedBox(height: StrideTokens.spaceSm),
          ],
          if (nutrition.note.isNotEmpty)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(StrideTokens.spaceMd),
              decoration: BoxDecoration(
                color: StrideTokens.accentFg,
                borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    '营养建议',
                    style: TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs11,
                      fontWeight: FontWeight.w600,
                      color: StrideTokens.accent,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    nutrition.note,
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs13,
                      color: StrideTokens.fgSoft,
                      height: 1.5,
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.value, required this.label});

  final String value;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Text(
          value,
          style: const TextStyle(
            fontFamily: AppTypography.fontMono,
            fontSize: StrideTokens.fs15,
            fontWeight: FontWeight.w600,
            color: StrideTokens.fg,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          label,
          style: const TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs10,
            color: StrideTokens.muted,
          ),
        ),
      ],
    );
  }
}

// ── 共用 ──────────────────────────────────────────────────────────────────────

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        StrideTokens.spaceLg,
        0,
        StrideTokens.spaceLg,
        StrideTokens.spaceSm,
      ),
      child: Text(
        text,
        style: const TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: StrideTokens.fs13,
          fontWeight: FontWeight.w600,
          color: StrideTokens.muted,
          letterSpacing: 0.5,
        ),
      ),
    );
  }
}

BoxDecoration _cardDecoration() {
  return BoxDecoration(
    color: StrideTokens.surface,
    borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
    border: Border.all(color: StrideTokens.border2),
  );
}
