/// D3 — 课时详情屏幕 (SessionDetailScreen).
///
/// 路由：/v2/plan/weeks/:folder/sessions/:date/:sessionIndex（fullscreen）
/// 参数：folder, date (YYYY-MM-DD), sessionIndex (int)
///
/// 内容：
///   1. StrideScreenHero：返回 + 「{周X} · {kind}」eyebrow + 课名 h1
///   2. 顶部摘要卡：课名 + 强度 pill + StrideStatRow（距离/时长/配速区间）
///   3. 第二 StatRow：心率区间 / 卡路里估算 / 区间标签
///   4. 执行要点 section（notes_md 或占位）
///   5. 训前营养 section（day.nutrition.notes 或占位）
///   6. 力量动作清单 section（仅 kind == "strength"）
///   7. 底部双按钮："训练前准备" + "推送本节课"
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/current_user.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/pill_colors.dart';
import '../../core/theme/tokens.dart';
import '../../data/api/stride_api.dart';
import '../../shared/utils/format.dart';
import '../_shared/widgets/pill.dart';
import '../_shared/widgets/refreshable.dart';
import '../_shared/widgets/screen_hero.dart';
import '../_shared/widgets/stat_row.dart';
import '../../data/models/plan.dart';
import 'models/day_plan.dart';
import 'providers/plan_day_provider.dart';
// ignore: unused_import — StrengthExerciseRow will be used once backend
// exposes exercise specs; keep the import to signal intent and avoid a
// future "import missing" diff at that point.
// import 'widgets/strength_exercise_row.dart';

// ── Screen ────────────────────────────────────────────────────────────────────

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
      planDayProvider((date: date, sessionIndex: sessionIndex)),
    );

    // Also fetch the raw PlanDay to access nutrition + session.notes
    final rawAsync = ref.watch(_planDayRawProvider((date: date, sessionIndex: sessionIndex)));

    final weekday = weekdayCN(date);
    final fallbackEyebrow = weekday.isEmpty ? '课时' : weekday;

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      body: SafeArea(
        bottom: false,
        child: async.when(
          loading: () => Column(
            children: [
              StrideScreenHero.withBack(
                eyebrow: fallbackEyebrow,
                title: '加载中…',
              ),
              const Expanded(
                child: Center(child: CircularProgressIndicator()),
              ),
            ],
          ),
          error: (e, _) => Column(
            children: [
              StrideScreenHero.withBack(
                eyebrow: fallbackEyebrow,
                title: '加载失败',
              ),
              Expanded(
                child: Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Text(
                        '加载失败',
                        style: TextStyle(
                          fontFamily: AppTypography.fontSans,
                          fontSize: StrideTokens.fs15,
                          color: StrideTokens.danger,
                        ),
                      ),
                      const SizedBox(height: StrideTokens.spaceMd),
                      TextButton(
                        onPressed: () => ref.invalidate(
                          planDayProvider(
                            (date: date, sessionIndex: sessionIndex),
                          ),
                        ),
                        child: const Text('重试'),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
          data: (plan) => Column(
            children: [
              StrideScreenHero.withBack(
                eyebrow: '$fallbackEyebrow · ${DayPlan.kindLabel(plan.kind)}',
                title: plan.name,
              ),
              Expanded(
                child: rawAsync.when(
                  loading: () => _SessionDetailBody(
                    plan: plan,
                    folder: folder,
                    date: date,
                    sessionIndex: sessionIndex,
                    rawSession: null,
                    nutrition: null,
                  ),
                  error: (_, _) => _SessionDetailBody(
                    plan: plan,
                    folder: folder,
                    date: date,
                    sessionIndex: sessionIndex,
                    rawSession: null,
                    nutrition: null,
                  ),
                  data: (raw) => _SessionDetailBody(
                    plan: plan,
                    folder: folder,
                    date: date,
                    sessionIndex: sessionIndex,
                    rawSession: raw.session,
                    nutrition: raw.nutrition,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ── Raw provider (for notes + nutrition) ──────────────────────────────────────

typedef _RawParams = ({String date, int sessionIndex});

class _RawPlanData {
  const _RawPlanData({required this.session, required this.nutrition});
  final PlannedSession session;
  final PlannedNutrition? nutrition;
}

final _planDayRawProvider =
    FutureProvider.autoDispose.family<_RawPlanData, _RawParams>(
  (ref, params) async {
    final api = ref.watch(strideApiProvider);
    final userId = ref.watch(currentUserIdProvider);
    if (userId == null) throw Exception('用户未登录');

    final response = await api.getPlanDays(userId, params.date, params.date);
    if (response.days.isEmpty) {
      throw StateError('该日期无训练计划：${params.date}');
    }
    final day = response.days.first;
    if (params.sessionIndex >= day.sessions.length) {
      throw RangeError('课时索引越界');
    }
    return _RawPlanData(
      session: day.sessions[params.sessionIndex],
      nutrition: day.nutrition,
    );
  },
);

// ── Body ──────────────────────────────────────────────────────────────────────

class _SessionDetailBody extends ConsumerStatefulWidget {
  const _SessionDetailBody({
    required this.plan,
    required this.folder,
    required this.date,
    required this.sessionIndex,
    required this.rawSession,
    required this.nutrition,
  });

  final DayPlan plan;
  final String folder;
  final String date;
  final int sessionIndex;
  final PlannedSession? rawSession;
  final PlannedNutrition? nutrition;

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

      await api.pushPlannedSession(userId, widget.date, widget.sessionIndex);

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
    final plan = widget.plan;
    final isStrength = plan.kind.toLowerCase() == 'strength';

    return Column(
      children: [
        Expanded(
          child: StrideRefreshable<DayPlan>(
            provider: planDayProvider((date: widget.date, sessionIndex: widget.sessionIndex)).future,
            child: ListView(
              padding: const EdgeInsets.all(StrideTokens.spaceLg),
              children: [
              // ── 1. 摘要卡 ──
              _SummaryCard(plan: plan),
              const SizedBox(height: StrideTokens.spaceLg),

              // ── 2. 第二 StatRow：心率区间 / 卡路里 / 区间标签 ──
              _SecondaryStatCard(plan: plan),
              const SizedBox(height: StrideTokens.spaceLg),

              // ── 3. 执行要点 ──
              const _SectionTitle(title: '执行要点'),
              const SizedBox(height: StrideTokens.spaceSm),
              _NotesCard(
                notes: widget.rawSession?.notes,
                placeholder: '按照目标配速区间保持稳定节奏，注意心率反馈。',
              ),
              const SizedBox(height: StrideTokens.spaceLg),

              // ── 4. 训前营养 ──
              const _SectionTitle(title: '训前营养'),
              const SizedBox(height: StrideTokens.spaceSm),
              _NutritionCard(
                notes: widget.nutrition?.notes,
                placeholder: '训前 1-2 小时补充适量碳水（如 1 根香蕉 + 半杯黑咖啡），训前 30 分钟避免高蛋白高脂。',
              ),
              const SizedBox(height: StrideTokens.spaceLg),

              // ── 5. 力量动作清单 (仅 strength) ──
              if (isStrength) ...[
                const _SectionTitle(title: '力量动作清单'),
                const SizedBox(height: StrideTokens.spaceSm),
                _StrengthExerciseList(rawSession: widget.rawSession),
                const SizedBox(height: StrideTokens.spaceLg),
              ],

              const SizedBox(height: 80),
            ],
          ),
          ),
        ),

        // ── 底部双按钮 ──
        _BottomActions(
          date: widget.date,
          sessionIndex: widget.sessionIndex,
          isPushing: _isPushing,
          onPush: _pushSession,
        ),
      ],
    );
  }
}

// ── Summary card ──────────────────────────────────────────────────────────────

class _SummaryCard extends StatelessWidget {
  const _SummaryCard({required this.plan});

  final DayPlan plan;

  @override
  Widget build(BuildContext context) {
    final distanceStr = plan.distanceM != null
        ? (plan.distanceM! / 1000).toStringAsFixed(1)
        : '—';
    final durationStr = plan.durationSec != null
        ? _fmtMinutes(plan.durationSec!.toInt())
        : '—';
    final paceStr = _fmtPaceRange(
      plan.targetPaceLowSecPerKm,
      plan.targetPaceHighSecPerKm,
    );

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
                  plan.name,
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
                text: plan.kind.toUpperCase(),
                variant: _kindToPillVariant(plan.kind),
              ),
            ],
          ),
          const SizedBox(height: StrideTokens.spaceMd),
          StrideStatRow(
            items: [
              StatItem(label: '距离', value: distanceStr, unit: 'km'),
              StatItem(label: '时长', value: durationStr, unit: 'min'),
              StatItem(label: '配速区间', value: paceStr, unit: 'min/km'),
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

  static String _fmtPaceRange(int? low, int? high) {
    if (low == null && high == null) return '—';
    final lo = low != null ? _secToMmss(low) : '?';
    final hi = high != null ? _secToMmss(high) : '?';
    return '$lo–$hi';
  }

  static String _secToMmss(int sec) {
    final m = sec ~/ 60;
    final s = sec % 60;
    return '$m:${s.toString().padLeft(2, '0')}';
  }

  static PillVariant _kindToPillVariant(String kind) {
    return switch (kind.toUpperCase()) {
      'E' => PillVariant.green,
      'REST' => PillVariant.muted,
      'R' => PillVariant.danger,
      'STRENGTH' => PillVariant.solid,
      _ => PillVariant.warn, // M / T / I
    };
  }
}

// ── Secondary stat card ───────────────────────────────────────────────────────

class _SecondaryStatCard extends StatelessWidget {
  const _SecondaryStatCard({required this.plan});

  final DayPlan plan;

  @override
  Widget build(BuildContext context) {
    final hrStr = switch ((plan.targetHrLow, plan.targetHrHigh)) {
      (final int l, final int h) => '$l–$h',
      (final int l, null) => '>$l',
      (null, final int h) => '<$h',
      _ => '—',
    };

    // Rough calorie estimate: ~60 kcal/km for running, fixed for strength
    final kcalStr = _estimateKcal(plan);
    final zoneLabel = _kindToZone(plan.kind);

    return Container(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: StrideStatRow(
        items: [
          StatItem(label: '心率区间', value: hrStr, unit: 'bpm'),
          StatItem(label: '卡路里估算', value: kcalStr, unit: 'kcal'),
          StatItem(label: '强度区间', value: zoneLabel),
        ],
      ),
    );
  }

  static String _estimateKcal(DayPlan plan) {
    if (plan.kind.toLowerCase() == 'strength') {
      final mins = plan.durationSec != null ? plan.durationSec! / 60 : 0;
      if (mins > 0) return (mins * 6).toStringAsFixed(0);
      return '—';
    }
    if (plan.distanceM != null && plan.distanceM! > 0) {
      return (plan.distanceM! / 1000 * 60).toStringAsFixed(0);
    }
    return '—';
  }

  static String _kindToZone(String kind) {
    return switch (kind.toUpperCase()) {
      'E' => 'Z1–Z2',
      'M' => 'Z3',
      'T' => 'Z4',
      'I' => 'Z4–Z5',
      'R' => 'Z5',
      'STRENGTH' => '力量',
      'REST' => '休息',
      _ => '—',
    };
  }
}

// ── Section title ─────────────────────────────────────────────────────────────

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

// ── Notes card ────────────────────────────────────────────────────────────────

class _NotesCard extends StatelessWidget {
  const _NotesCard({required this.notes, required this.placeholder});

  final String? notes;
  final String placeholder;

  @override
  Widget build(BuildContext context) {
    final text = (notes != null && notes!.isNotEmpty) ? notes! : placeholder;
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
  const _NutritionCard({required this.notes, required this.placeholder});

  final String? notes;
  final String placeholder;

  @override
  Widget build(BuildContext context) {
    final text = (notes != null && notes!.isNotEmpty) ? notes! : placeholder;
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

// ── Strength exercise list ────────────────────────────────────────────────────

class _StrengthExerciseList extends StatelessWidget {
  const _StrengthExerciseList({required this.rawSession});

  final PlannedSession? rawSession;

  @override
  Widget build(BuildContext context) {
    // The PlannedSession model doesn't carry exercises in the current API shape.
    // Show a placeholder until the backend exposes them.
    // When exercises are available in rawSession, they would be rendered via
    // StrengthExerciseRow widgets.
    return Container(
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: const Padding(
        padding: EdgeInsets.all(StrideTokens.spaceLg),
        child: Text(
          '动作清单稍后同步',
          style: TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs14,
            color: StrideTokens.muted,
          ),
        ),
      ),
    );
  }
}

// ── Bottom actions ────────────────────────────────────────────────────────────

class _BottomActions extends StatelessWidget {
  const _BottomActions({
    required this.date,
    required this.sessionIndex,
    required this.isPushing,
    required this.onPush,
  });

  final String date;
  final int sessionIndex;
  final bool isPushing;
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
      child: Row(
        children: [
          // 训练前准备 — outline
          Expanded(
            child: OutlinedButton(
              onPressed: () => context.push(
                '/v2/plan/$date/$sessionIndex/pre',
              ),
              style: OutlinedButton.styleFrom(
                minimumSize: const Size.fromHeight(48),
                foregroundColor: StrideTokens.fg,
                side: const BorderSide(color: StrideTokens.border),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
                ),
                textStyle: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs14,
                  fontWeight: FontWeight.w500,
                ),
              ),
              child: const Text('训练前准备'),
            ),
          ),
          const SizedBox(width: StrideTokens.spaceMd),
          // 推送本节课 — primary
          Expanded(
            child: FilledButton(
              onPressed: isPushing ? null : onPush,
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
                  : const Text('推送本节课'),
            ),
          ),
        ],
      ),
    );
  }
}
