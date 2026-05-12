/// C6 — Master plan view screen (fullscreen, no shell).
///
/// Displays the full active training plan:
///   1. Total progress Hero card
///   2. Horizontal phase timeline
///   3. Phase detail cards (one per phase)
///   4. Milestones list
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/router/routes_v2.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/top_bar.dart';
import 'models/master_plan.dart';
import 'providers/master_plan_view_provider.dart';
import 'widgets/milestone_row.dart';
import 'widgets/phase_chip.dart';
import 'widgets/phase_detail_card.dart';

class MasterPlanViewScreen extends ConsumerWidget {
  const MasterPlanViewScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(masterPlanViewProvider);

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        title: '训练总纲',
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => Navigator.of(context).pop(),
        ),
        actions: async.valueOrNull != null
            ? [
                IconButton(
                  icon: const Icon(Icons.tune),
                  tooltip: '调整',
                  onPressed: () => context.push(
                    RoutesV2.trainingPlanAdjust(
                        async.valueOrNull!.planId),
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.history),
                  tooltip: '历史',
                  onPressed: () => context.push(
                    RoutesV2.trainingPlanHistory(
                        async.valueOrNull!.planId),
                  ),
                ),
              ]
            : const [],
      ),
      body: async.when(
        loading: () => const Center(
          child: CircularProgressIndicator(
            color: StrideTokens.accent,
          ),
        ),
        error: (err, _) => Center(
          child: Padding(
            padding: const EdgeInsets.all(StrideTokens.spaceLg),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.error_outline,
                    size: 40, color: StrideTokens.muted),
                const SizedBox(height: StrideTokens.spaceMd),
                Text(
                  '加载失败：$err',
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs13,
                    color: StrideTokens.muted,
                  ),
                ),
                const SizedBox(height: StrideTokens.spaceMd),
                TextButton(
                  onPressed: () => ref.refresh(masterPlanViewProvider),
                  child: const Text('重试'),
                ),
              ],
            ),
          ),
        ),
        data: (plan) {
          if (plan == null) {
            return const _NoPlanPlaceholder();
          }
          return _PlanBody(plan: plan);
        },
      ),
    );
  }
}

// ── No-plan placeholder ───────────────────────────────────────────────────────

class _NoPlanPlaceholder extends StatelessWidget {
  const _NoPlanPlaceholder();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(StrideTokens.space2xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.event_note_outlined,
                size: 48, color: StrideTokens.muted),
            const SizedBox(height: StrideTokens.spaceMd),
            const Text(
              '暂无激活的训练总纲',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs14,
                color: StrideTokens.muted,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ── Main plan body ────────────────────────────────────────────────────────────

class _PlanBody extends StatelessWidget {
  const _PlanBody({required this.plan});

  final MasterPlan plan;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.only(bottom: StrideTokens.space3xl),
      children: [
        _HeroCard(plan: plan),
        _PhaseTimeline(plan: plan),
        _PhaseDetailSection(plan: plan),
        _MilestonesSection(plan: plan),
      ],
    );
  }
}

// ── Hero progress card ────────────────────────────────────────────────────────

class _HeroCard extends StatelessWidget {
  const _HeroCard({required this.plan});

  final MasterPlan plan;

  static String _fmtDate(String iso) => iso.replaceAll('-', '.');

  String get _currentPhaseName {
    if (plan.currentPhaseId == null) return '未知阶段';
    final phase = plan.phases
        .where((p) => p.id == plan.currentPhaseId)
        .firstOrNull;
    return phase?.name ?? '未知阶段';
  }

  @override
  Widget build(BuildContext context) {
    final next = plan.nextMilestone;
    final ratio = plan.completionRatio;

    return Container(
      margin: const EdgeInsets.fromLTRB(
        StrideTokens.spaceLg,
        StrideTokens.spaceLg,
        StrideTokens.spaceLg,
        StrideTokens.spaceSm,
      ),
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Date range
          Text(
            '${_fmtDate(plan.startDate)} – ${_fmtDate(plan.endDate)}',
            style: const TextStyle(
              fontFamily: AppTypography.fontMono,
              fontSize: StrideTokens.fs12,
              color: StrideTokens.muted,
            ),
          ),
          const SizedBox(height: StrideTokens.spaceSm),
          // Current phase + week
          Row(
            children: [
              Expanded(
                child: Text(
                  _currentPhaseName,
                  style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs18,
                    fontWeight: FontWeight.w700,
                    color: StrideTokens.fg,
                  ),
                ),
              ),
              if (plan.currentWeekNumber != null && plan.totalWeeks != null)
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  decoration: BoxDecoration(
                    color: StrideTokens.accentFg,
                    borderRadius:
                        BorderRadius.circular(StrideTokens.radiusPill),
                  ),
                  child: Text(
                    'W${plan.currentWeekNumber} / ${plan.totalWeeks}周',
                    style: const TextStyle(
                      fontFamily: AppTypography.fontMono,
                      fontSize: StrideTokens.fs12,
                      fontWeight: FontWeight.w600,
                      color: StrideTokens.accent,
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(height: StrideTokens.spaceMd),
          // Progress bar
          ClipRRect(
            borderRadius: BorderRadius.circular(StrideTokens.radiusPill),
            child: LinearProgressIndicator(
              value: ratio,
              minHeight: 6,
              backgroundColor: StrideTokens.border2,
              color: StrideTokens.accent,
            ),
          ),
          const SizedBox(height: StrideTokens.spaceSm),
          // Progress label
          Text(
            '整体进度 ${(ratio * 100).round()}%',
            style: const TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs12,
              color: StrideTokens.muted,
            ),
          ),
          // Next milestone countdown
          if (next != null) ...[
            const SizedBox(height: StrideTokens.spaceMd),
            const Divider(height: 1, color: StrideTokens.border2),
            const SizedBox(height: StrideTokens.spaceMd),
            Row(
              children: [
                const Icon(Icons.flag_outlined,
                    size: 14, color: StrideTokens.accent),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    next.target,
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs13,
                      color: StrideTokens.fg,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                const SizedBox(width: StrideTokens.spaceSm),
                Text(
                  next.daysUntil >= 0 ? '${next.daysUntil}天后' : '已过',
                  style: const TextStyle(
                    fontFamily: AppTypography.fontMono,
                    fontSize: StrideTokens.fs12,
                    fontWeight: FontWeight.w600,
                    color: StrideTokens.accent,
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

// ── Phase timeline (horizontal scrollable) ────────────────────────────────────

class _PhaseTimeline extends StatelessWidget {
  const _PhaseTimeline({required this.plan});

  final MasterPlan plan;

  bool _isPast(PlanPhase phase) {
    try {
      return DateTime.parse(phase.endDate).isBefore(DateTime.now());
    } catch (_) {
      return false;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        StrideTokens.spaceLg,
        StrideTokens.spaceSm,
        0,
        StrideTokens.spaceSm,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.only(right: StrideTokens.spaceLg, bottom: StrideTokens.spaceSm),
            child: Text(
              '阶段时间轴',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs12,
                fontWeight: FontWeight.w600,
                color: StrideTokens.muted,
                letterSpacing: 0.5,
              ),
            ),
          ),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.only(right: StrideTokens.spaceLg),
            child: Row(
              children: [
                for (int i = 0; i < plan.phases.length; i++) ...[
                  if (i > 0)
                    const Padding(
                      padding: EdgeInsets.symmetric(horizontal: 4),
                      child: Icon(Icons.chevron_right,
                          size: 16, color: StrideTokens.muted),
                    ),
                  PhaseChip(
                    phase: plan.phases[i],
                    isCurrent: plan.phases[i].id == plan.currentPhaseId,
                    isPast: _isPast(plan.phases[i]),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ── Phase detail cards ────────────────────────────────────────────────────────

class _PhaseDetailSection extends StatelessWidget {
  const _PhaseDetailSection({required this.plan});

  final MasterPlan plan;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: StrideTokens.spaceLg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.symmetric(vertical: StrideTokens.spaceSm),
            child: Text(
              '阶段详情',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs12,
                fontWeight: FontWeight.w600,
                color: StrideTokens.muted,
                letterSpacing: 0.5,
              ),
            ),
          ),
          for (final phase in plan.phases)
            PhaseDetailCard(
              phase: phase,
              milestones: plan.milestones,
              isCurrent: phase.id == plan.currentPhaseId,
            ),
        ],
      ),
    );
  }
}

// ── Milestones section ────────────────────────────────────────────────────────

class _MilestonesSection extends StatelessWidget {
  const _MilestonesSection({required this.plan});

  final MasterPlan plan;

  int? _daysUntil(PlanMilestone ms) {
    try {
      final d = DateTime.parse(ms.date);
      return d.difference(DateTime.now()).inDays;
    } catch (_) {
      return null;
    }
  }

  @override
  Widget build(BuildContext context) {
    if (plan.milestones.isEmpty) return const SizedBox.shrink();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Padding(
          padding: EdgeInsets.fromLTRB(
            StrideTokens.spaceLg,
            StrideTokens.spaceSm,
            StrideTokens.spaceLg,
            StrideTokens.spaceSm,
          ),
          child: Text(
            '里程碑',
            style: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs12,
              fontWeight: FontWeight.w600,
              color: StrideTokens.muted,
              letterSpacing: 0.5,
            ),
          ),
        ),
        Container(
          margin: const EdgeInsets.symmetric(horizontal: StrideTokens.spaceLg),
          decoration: BoxDecoration(
            color: StrideTokens.surface,
            borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
            border: Border.all(color: StrideTokens.border2),
          ),
          child: Column(
            children: [
              for (final ms in plan.milestones)
                MilestoneRow(
                  milestone: ms,
                  daysUntil: _daysUntil(ms),
                ),
            ],
          ),
        ),
      ],
    );
  }
}
