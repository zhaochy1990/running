/// MilestoneRow — single milestone entry in the full milestone list (C6).
library;

import 'package:flutter/material.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/tokens.dart';
import '../models/master_plan.dart';

class MilestoneRow extends StatelessWidget {
  const MilestoneRow({
    super.key,
    required this.milestone,
    this.daysUntil,
  });

  final PlanMilestone milestone;

  /// Days until this milestone (null when past or completed).
  final int? daysUntil;

  static Color _typeColor(MilestoneType type) => switch (type) {
        MilestoneType.race => StrideTokens.danger,
        MilestoneType.testRun => StrideTokens.warn,
        MilestoneType.longRun => StrideTokens.accent,
        MilestoneType.strengthTest => StrideTokens.muted,
      };

  @override
  Widget build(BuildContext context) {
    final isCompleted = milestone.completedActual != null;
    final color = _typeColor(milestone.type);

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: StrideTokens.spaceMd,
        vertical: StrideTokens.spaceMd,
      ),
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: StrideTokens.border2)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Type pill
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
            decoration: BoxDecoration(
              color: color.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(4),
            ),
            child: Text(
              milestone.type.label,
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs11,
                fontWeight: FontWeight.w600,
                color: color,
              ),
            ),
          ),
          const SizedBox(width: StrideTokens.spaceSm),
          // Target + date
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  milestone.target,
                  style: TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs13,
                    fontWeight: FontWeight.w500,
                    color: isCompleted ? StrideTokens.muted : StrideTokens.fg,
                    decoration:
                        isCompleted ? TextDecoration.lineThrough : null,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  milestone.date.replaceAll('-', '.'),
                  style: const TextStyle(
                    fontFamily: AppTypography.fontMono,
                    fontSize: StrideTokens.fs11,
                    color: StrideTokens.muted,
                  ),
                ),
                if (isCompleted && milestone.completedActual != null) ...[
                  const SizedBox(height: 2),
                  Text(
                    milestone.completedActual!,
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs12,
                      color: StrideTokens.accent,
                    ),
                  ),
                ],
              ],
            ),
          ),
          // Status indicator
          if (isCompleted)
            const Icon(Icons.check_circle, size: 18, color: StrideTokens.accent)
          else if (daysUntil != null)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              decoration: BoxDecoration(
                color: StrideTokens.grid,
                borderRadius: BorderRadius.circular(StrideTokens.radiusPill),
              ),
              child: Text(
                daysUntil! >= 0 ? '$daysUntil天后' : '已过',
                style: const TextStyle(
                  fontFamily: AppTypography.fontMono,
                  fontSize: StrideTokens.fs11,
                  color: StrideTokens.muted,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
