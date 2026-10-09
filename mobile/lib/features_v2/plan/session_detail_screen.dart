/// D3 — 课时详情屏幕 (SessionDetailScreen).
///
/// 路由：/training/plan/weeks/:folder/sessions/:date/:sessionIndex（fullscreen）
/// 数据源：weekDetailProvider 的结构化课表（plan/weeks/{weekName}）。
///
/// 内容：
///   1. 摘要卡：课名 + kind pill + 距离/时长
///   2. 课表结构（run spec 的 blocks/steps 或 strength spec 的动作清单）
///   3. 教练备注（notes_md / coach_notes）
///   4. 当日营养（结构化课表内嵌 nutrition）
///   5. 底部：推送本节课
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/auth/current_user.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/pill_colors.dart';
import '../../core/theme/tokens.dart';
import '../../data/api/stride_api.dart';
import '../../data/models/weekly_plan.dart';
import '../../shared/utils/format.dart';
import '../_shared/widgets/pill.dart';
import '../_shared/widgets/stat_row.dart';
import '../_shared/widgets/top_bar.dart';
import 'day_view.dart' show firstLine;
import 'providers/week_detail_provider.dart';
import 'widgets/strength_exercise_row.dart';

class SessionDetailScreen extends ConsumerWidget {
  const SessionDetailScreen({
    super.key,
    required this.folder,
    required this.date,
    required this.sessionIndex,
  });

  final String folder;
  final String date;
  final int sessionIndex;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(
      sessionDetailProvider((folder: folder, date: date, sessionIndex: sessionIndex)),
    );
    final weekday = weekdayCN(date);
    final fallbackEyebrow = weekday.isEmpty ? '课时' : weekday;

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          tooltip: '返回',
          onPressed: () => Navigator.of(context).pop(),
        ),
        title: async.whenOrNull(
              data: (s) => '$fallbackEyebrow · ${kindLabel(s.session.kind)}',
            ) ??
            fallbackEyebrow,
      ),
      body: async.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                '加载失败',
                style: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs15,
                  color: StrideTokens.danger,
                ),
              ),
              const SizedBox(height: StrideTokens.spaceMd),
              TextButton(
                onPressed: () => ref.invalidate(
                  sessionDetailProvider(
                    (folder: folder, date: date, sessionIndex: sessionIndex),
                  ),
                ),
                child: const Text('重试'),
              ),
            ],
          ),
        ),
        data: (s) => _SessionDetailBody(data: s),
      ),
    );
  }
}

typedef SessionDetailParams = ({String folder, String date, int sessionIndex});

/// 从 weekDetailProvider 的结构化课表中提取指定课节 + 当日营养。
final sessionDetailProvider =
    FutureProvider.autoDispose.family<SessionDetailData, SessionDetailParams>(
  (ref, params) async {
    final week = await ref.watch(weekDetailProvider(params.folder).future);
    final content = week.planContent;
    final sessions = content?.sessionsOn(params.date) ?? const [];
    final PlannedSession session;
    try {
      session = sessions.firstWhere((s) => s.sessionIndex == params.sessionIndex);
    } catch (_) {
      throw StateError('该日期无此课时：${params.date} #${params.sessionIndex}');
    }
    return SessionDetailData(
      session: session,
      nutrition: content?.nutritionOn(params.date),
      coachNotes: content?.coachNotes,
    );
  },
);

class SessionDetailData {
  const SessionDetailData({
    required this.session,
    this.nutrition,
    this.coachNotes,
  });

  final PlannedSession session;
  final PlannedNutrition? nutrition;
  final String? coachNotes;
}

// ── Body ──────────────────────────────────────────────────────────────────────

class _SessionDetailBody extends ConsumerStatefulWidget {
  const _SessionDetailBody({required this.data});

  final SessionDetailData data;

  @override
  ConsumerState<_SessionDetailBody> createState() => _SessionDetailBodyState();
}

class _SessionDetailBodyState extends ConsumerState<_SessionDetailBody> {
  bool _isPushing = false;

  Future<void> _pushSession() async {
    if (_isPushing) return;
    setState(() => _isPushing = true);

    try {
      final api = ref.read(strideApiProvider);
      final userId = ref.read(currentUserIdProvider);
      if (userId == null) throw Exception('用户未登录');

      await api.pushPlannedSession(
        userId,
        widget.data.session.date,
        widget.data.session.sessionIndex,
      );

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('已推送到手表'),
            backgroundColor: StrideTokens.accent,
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('推送失败：$e'),
            backgroundColor: StrideTokens.danger,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _isPushing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = widget.data.session;
    final runSpec = session.spec is RunWorkoutSpec
        ? session.spec as RunWorkoutSpec
        : null;
    final strengthSpec = session.spec is StrengthWorkoutSpec
        ? session.spec as StrengthWorkoutSpec
        : null;
    final notes = firstLine(session.notesMd) ??
        firstLine(widget.data.coachNotes);
    final nutrition = widget.data.nutrition;

    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.all(StrideTokens.spaceLg),
            children: [
              _SummaryCard(session: session),
              const SizedBox(height: StrideTokens.spaceLg),

              // ── 课表结构 ──
              if (runSpec != null) ...[
                const _SectionTitle(title: '课表结构'),
                const SizedBox(height: StrideTokens.spaceSm),
                _RunSpecCard(spec: runSpec),
                const SizedBox(height: StrideTokens.spaceLg),
              ],
              if (strengthSpec != null) ...[
                const _SectionTitle(title: '力量动作清单'),
                const SizedBox(height: StrideTokens.spaceSm),
                _StrengthExerciseList(exercises: strengthSpec.exercises),
                const SizedBox(height: StrideTokens.spaceLg),
              ],

              // ── 教练备注 ──
              if (notes != null) ...[
                const _SectionTitle(title: '教练备注'),
                const SizedBox(height: StrideTokens.spaceSm),
                _TextCard(text: notes),
                const SizedBox(height: StrideTokens.spaceLg),
              ],

              // ── 当日营养 ──
              if (nutrition != null) ...[
                const _SectionTitle(title: '当日营养'),
                const SizedBox(height: StrideTokens.spaceSm),
                _NutritionCard(nutrition: nutrition),
                const SizedBox(height: StrideTokens.spaceLg),
              ],

              const SizedBox(height: 80),
            ],
          ),
        ),

        // ── 底部：推送本节课 ──
        _BottomActions(
          isPushing: _isPushing,
          pushable: session.pushable,
          onPush: _pushSession,
        ),
      ],
    );
  }
}

// ── Summary card ──────────────────────────────────────────────────────────────

class _SummaryCard extends StatelessWidget {
  const _SummaryCard({required this.session});

  final PlannedSession session;

  @override
  Widget build(BuildContext context) {
    final distanceStr = session.totalDistanceM != null
        ? (session.totalDistanceM! / 1000).toStringAsFixed(1)
        : '—';
    final durationStr = session.totalDurationS != null
        ? _fmtMinutes(session.totalDurationS!.toInt())
        : '—';

    return Container(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Expanded(
                child: Text(
                  session.displayName ?? kindLabel(session.kind),
                  style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs20,
                    fontWeight: FontWeight.w700,
                    color: StrideTokens.fg,
                    height: 1.2,
                  ),
                ),
              ),
              const SizedBox(width: StrideTokens.spaceSm),
              StridePill(
                text: kindLabel(session.kind),
                variant: _kindToPillVariant(session.kind),
              ),
            ],
          ),
          const SizedBox(height: StrideTokens.spaceMd),
          StrideStatRow(
            items: [
              StatItem(label: '距离', value: distanceStr, unit: 'km'),
              StatItem(label: '时长', value: durationStr, unit: 'min'),
            ],
          ),
        ],
      ),
    );
  }

  static String _fmtMinutes(int totalSec) {
    final m = totalSec ~/ 60;
    return '$m';
  }

  static PillVariant _kindToPillVariant(String kind) {
    return switch (kind) {
      'run' => PillVariant.green,
      'strength' => PillVariant.solid,
      'rest' => PillVariant.muted,
      _ => PillVariant.warn, // cross / note
    };
  }
}

// ── Run spec card ─────────────────────────────────────────────────────────────

class _RunSpecCard extends StatelessWidget {
  const _RunSpecCard({required this.spec});

  final RunWorkoutSpec spec;

  @override
  Widget build(BuildContext context) {
    final rows = <WorkoutStep>[];
    for (final block in spec.blocks) {
      for (var r = 0; r < block.repeat; r++) {
        rows.addAll(block.steps);
      }
    }

    return Container(
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Column(
        children: [
          for (int i = 0; i < rows.length; i++) ...[
            if (i > 0)
              const Divider(
                height: 1,
                indent: StrideTokens.spaceLg,
                endIndent: StrideTokens.spaceLg,
                color: StrideTokens.border2,
              ),
            _StepRow(step: rows[i]),
          ],
        ],
      ),
    );
  }
}

class _StepRow extends StatelessWidget {
  const _StepRow({required this.step});

  final WorkoutStep step;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: StrideTokens.spaceLg,
        vertical: StrideTokens.spaceSm,
      ),
      child: Row(
        children: [
          SizedBox(
            width: 64,
            child: StridePill(
              text: _stepKindLabel(step.stepKind),
              variant: _stepKindVariant(step.stepKind),
              dense: true,
            ),
          ),
          const SizedBox(width: StrideTokens.spaceMd),
          Expanded(
            child: Text(
              _targetText(step.target),
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs14,
                color: StrideTokens.fgSoft,
              ),
            ),
          ),
        ],
      ),
    );
  }

  static String _stepKindLabel(String kind) {
    return switch (kind) {
      'warmup' => '热身',
      'work' => '主课',
      'recovery' => '恢复',
      'cooldown' => '放松',
      'rest' => '休息',
      _ => kind,
    };
  }

  static PillVariant _stepKindVariant(String kind) {
    return switch (kind) {
      'work' => PillVariant.green,
      'rest' => PillVariant.muted,
      _ => PillVariant.warn,
    };
  }

  static String _targetText(WorkoutTarget target) {
    switch (target.kind) {
      case 'pace_s_km':
        final low = target.low;
        final high = target.high;
        String fmt(num? v) {
          if (v == null) return '?';
          final m = v ~/ 60;
          final s = (v % 60).round();
          return '$m:${s.toString().padLeft(2, '0')}';
        }
        return '配速 ${fmt(low)}–${fmt(high)} /km';
      case 'hr_bpm':
        return '心率 ${target.low ?? '?'}–${target.high ?? '?'} bpm';
      case 'power_w':
        return '功率 ${target.low ?? '?'}–${target.high ?? '?'} W';
      default:
        return '开放式';
    }
  }
}

// ── Section title / text cards ────────────────────────────────────────────────

class _SectionTitle extends StatelessWidget {
  const _SectionTitle({required this.title});

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

class _TextCard extends StatelessWidget {
  const _TextCard({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Text(
        text,
        style: const TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: StrideTokens.fs14,
          color: StrideTokens.fgSoft,
          height: 1.6,
        ),
      ),
    );
  }
}

// ── Nutrition card ────────────────────────────────────────────────────────────

class _NutritionCard extends StatelessWidget {
  const _NutritionCard({required this.nutrition});

  final PlannedNutrition nutrition;

  @override
  Widget build(BuildContext context) {
    final targets = <StatItem>[
      if (nutrition.kcalTarget != null)
        StatItem(
          label: '热量',
          value: nutrition.kcalTarget!.round().toString(),
          unit: 'kcal',
        ),
      if (nutrition.carbsG != null)
        StatItem(label: '碳水', value: nutrition.carbsG!.round().toString(), unit: 'g'),
      if (nutrition.proteinG != null)
        StatItem(
          label: '蛋白质',
          value: nutrition.proteinG!.round().toString(),
          unit: 'g',
        ),
      if (nutrition.waterMl != null)
        StatItem(
          label: '饮水',
          value: nutrition.waterMl!.round().toString(),
          unit: 'ml',
        ),
    ];
    final note = firstLine(nutrition.notesMd);

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (targets.isNotEmpty) ...[
            StrideStatRow(items: targets),
            const SizedBox(height: StrideTokens.spaceMd),
          ],
          for (final meal in nutrition.meals) ...[
            Row(
              children: [
                Text(
                  meal.name,
                  style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs14,
                    fontWeight: FontWeight.w600,
                    color: StrideTokens.fg,
                  ),
                ),
                const Spacer(),
                if (meal.kcal != null)
                  Text(
                    '${meal.kcal!.round()} kcal',
                    style: const TextStyle(
                      fontFamily: AppTypography.fontMono,
                      fontSize: StrideTokens.fs13,
                      color: StrideTokens.muted,
                    ),
                  ),
              ],
            ),
            const SizedBox(height: StrideTokens.spaceXs),
          ],
          if (note != null)
            Text(
              note,
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs14,
                color: StrideTokens.fgSoft,
                height: 1.6,
              ),
            ),
        ],
      ),
    );
  }
}

// ── Strength exercise list ────────────────────────────────────────────────────

class _StrengthExerciseList extends StatelessWidget {
  const _StrengthExerciseList({required this.exercises});

  final List<StrengthExercise> exercises;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Column(
        children: [
          for (int i = 0; i < exercises.length; i++) ...[
            StrengthExerciseRow(
              name: exercises[i].displayName,
              setsReps: exercises[i].targetKind == 'time_s'
                  ? '${exercises[i].sets}×${exercises[i].targetValue.round()}s'
                  : '${exercises[i].sets}×${exercises[i].targetValue.round()}次',
              restSeconds: exercises[i].restSeconds,
              showDivider: i > 0,
            ),
          ],
        ],
      ),
    );
  }
}

// ── Bottom actions ────────────────────────────────────────────────────────────

class _BottomActions extends StatelessWidget {
  const _BottomActions({
    required this.isPushing,
    required this.pushable,
    required this.onPush,
  });

  final bool isPushing;
  final bool pushable;
  final VoidCallback onPush;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(
        StrideTokens.spaceLg,
        StrideTokens.spaceMd,
        StrideTokens.spaceLg,
        StrideTokens.space2xl,
      ),
      decoration: const BoxDecoration(
        color: StrideTokens.surface,
        border: Border(top: BorderSide(color: StrideTokens.border2)),
      ),
      child: FilledButton(
        onPressed: isPushing || !pushable ? null : onPush,
        style: FilledButton.styleFrom(
          backgroundColor: StrideTokens.accent,
          foregroundColor: StrideTokens.surface,
          disabledBackgroundColor: StrideTokens.accent.withValues(alpha: 0.5),
          minimumSize: const Size.fromHeight(48),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
          ),
          textStyle: const TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs14,
            fontWeight: FontWeight.w600,
          ),
        ),
        child: isPushing
            ? const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: StrideTokens.surface,
                ),
              )
            : Text(pushable ? '推送本节课' : '该课节不支持推送'),
      ),
    );
  }
}
