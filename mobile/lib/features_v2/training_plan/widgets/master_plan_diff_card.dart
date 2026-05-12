/// MasterPlanDiffCard — renders a list of MasterPlanDiffOp entries with
/// op-type pill, phase/milestone context, old→new field comparison, and
/// per-op Checkbox for selective acceptance.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/tokens.dart';
import '../providers/master_plan_review_provider.dart';

class MasterPlanDiffCard extends ConsumerWidget {
  const MasterPlanDiffCard({
    super.key,
    required this.diff,
    required this.planId,
  });

  final MasterPlanDiff diff;
  final String planId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(masterPlanReviewProvider(planId));
    final notifier = ref.read(masterPlanReviewProvider(planId).notifier);

    if (diff.ops.isEmpty) return const SizedBox.shrink();

    return Container(
      margin: const EdgeInsets.only(bottom: StrideTokens.spaceMd),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header
          Padding(
            padding: const EdgeInsets.fromLTRB(
              StrideTokens.spaceMd,
              StrideTokens.spaceMd,
              StrideTokens.spaceMd,
              StrideTokens.spaceSm,
            ),
            child: Text(
              '总纲调整建议 ${diff.ops.length} 项',
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs13,
                fontWeight: FontWeight.w600,
                color: StrideTokens.muted,
                letterSpacing: 0.3,
              ),
            ),
          ),
          const Divider(height: 1, color: StrideTokens.border2),
          // Ops
          for (final op in diff.ops) ...[
            _MasterPlanOpRow(
              op: op,
              accepted: state.acceptedOpIds.contains(op.id),
              onToggle: () => notifier.toggleOp(op.id),
            ),
            if (op != diff.ops.last)
              const Divider(
                height: 1,
                indent: StrideTokens.spaceMd,
                endIndent: StrideTokens.spaceMd,
                color: StrideTokens.border2,
              ),
          ],
        ],
      ),
    );
  }
}

class _MasterPlanOpRow extends StatelessWidget {
  const _MasterPlanOpRow({
    required this.op,
    required this.accepted,
    required this.onToggle,
  });

  final MasterPlanDiffOp op;
  final bool accepted;
  final VoidCallback onToggle;

  static String _opLabel(String opType) {
    return switch (opType) {
      'extend_phase' => '延长阶段',
      'shorten_phase' => '缩短阶段',
      'reduce_intensity' => '降低强度',
      'increase_intensity' => '提升强度',
      'add_milestone' => '新增里程碑',
      'remove_milestone' => '删除里程碑',
      'adjust_date' => '调整日期',
      'change_volume' => '调整量',
      'add_race' => '新增测试赛',
      _ => opType,
    };
  }

  static Color _opColor(String opType) {
    return switch (opType) {
      'add_milestone' || 'add_race' || 'extend_phase' => StrideTokens.accent,
      'remove_milestone' => StrideTokens.danger,
      'reduce_intensity' || 'shorten_phase' => StrideTokens.warn,
      _ => StrideTokens.muted,
    };
  }

  @override
  Widget build(BuildContext context) {
    final color = _opColor(op.op);
    final context2 = op.phaseName ?? op.milestoneName;
    final oldSummary = op.oldValue?['summary'] as String? ??
        op.oldValue?['value']?.toString();
    final newSummary = op.newValue?['summary'] as String? ??
        op.newValue?['value']?.toString();

    return InkWell(
      onTap: onToggle,
      borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: StrideTokens.spaceMd,
          vertical: StrideTokens.spaceMd,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Checkbox
            SizedBox(
              width: 24,
              height: 24,
              child: Checkbox(
                value: accepted,
                onChanged: (_) => onToggle(),
                activeColor: StrideTokens.accent,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(4),
                ),
                materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
            ),
            const SizedBox(width: StrideTokens.spaceSm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Op pill + context name
                  Row(
                    children: [
                      _OpPill(label: _opLabel(op.op), color: color),
                      if (context2 != null) ...[
                        const SizedBox(width: StrideTokens.spaceSm),
                        Flexible(
                          child: Text(
                            context2,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontFamily: AppTypography.fontSans,
                              fontSize: StrideTokens.fs12,
                              color: StrideTokens.muted,
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                  // old → new
                  if (oldSummary != null || newSummary != null) ...[
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        if (oldSummary != null)
                          Flexible(
                            child: Text(
                              oldSummary,
                              style: const TextStyle(
                                fontFamily: AppTypography.fontSans,
                                fontSize: StrideTokens.fs13,
                                color: StrideTokens.muted,
                                decoration: TextDecoration.lineThrough,
                              ),
                            ),
                          ),
                        if (oldSummary != null && newSummary != null)
                          const Padding(
                            padding: EdgeInsets.symmetric(horizontal: 4),
                            child: Icon(
                              Icons.arrow_forward,
                              size: 14,
                              color: StrideTokens.muted,
                            ),
                          ),
                        if (newSummary != null)
                          Flexible(
                            child: Text(
                              newSummary,
                              style: const TextStyle(
                                fontFamily: AppTypography.fontSans,
                                fontSize: StrideTokens.fs13,
                                color: StrideTokens.fg,
                                fontWeight: FontWeight.w500,
                              ),
                            ),
                          ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _OpPill extends StatelessWidget {
  const _OpPill({required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withOpacity(0.12),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: StrideTokens.fs11,
          fontWeight: FontWeight.w600,
          color: color,
        ),
      ),
    );
  }
}
