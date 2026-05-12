/// PhaseDetailCard — expandable card showing full phase details.
library;

import 'package:flutter/material.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/tokens.dart';
import '../models/master_plan.dart';

class PhaseDetailCard extends StatelessWidget {
  const PhaseDetailCard({
    super.key,
    required this.phase,
    required this.milestones,
    required this.isCurrent,
  });

  final PlanPhase phase;
  final List<PlanMilestone> milestones;
  final bool isCurrent;

  /// Format "2026-05-12" → "2026.05.12"
  static String _fmtDate(String iso) => iso.replaceAll('-', '.');

  /// Weeks from date range (inclusive).
  static int _weeksInRange(String startIso, String endIso) {
    try {
      final s = DateTime.parse(startIso);
      final e = DateTime.parse(endIso);
      return ((e.difference(s).inDays) / 7).ceil().clamp(1, 999);
    } catch (_) {
      return 0;
    }
  }

  @override
  Widget build(BuildContext context) {
    final weeks = _weeksInRange(phase.startDate, phase.endDate);
    final phaseMilestones = milestones
        .where((m) => phase.milestoneIds.contains(m.id))
        .toList();

    return Container(
      margin: const EdgeInsets.only(bottom: StrideTokens.spaceMd),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(
          color: isCurrent ? StrideTokens.accent : StrideTokens.border2,
          width: isCurrent ? 1.5 : 1,
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.all(StrideTokens.spaceMd),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Header row: phase name + date range + weeks badge
            Row(
              children: [
                if (isCurrent)
                  Container(
                    margin: const EdgeInsets.only(right: StrideTokens.spaceSm),
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                    decoration: BoxDecoration(
                      color: StrideTokens.accentFg,
                      borderRadius: BorderRadius.circular(4),
                    ),
                    child: const Text(
                      '当前',
                      style: TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs11,
                        fontWeight: FontWeight.w600,
                        color: StrideTokens.accent,
                      ),
                    ),
                  ),
                Expanded(
                  child: Text(
                    phase.name,
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs14,
                      fontWeight: FontWeight.w600,
                      color: StrideTokens.fg,
                    ),
                  ),
                ),
                Text(
                  '$weeks 周',
                  style: const TextStyle(
                    fontFamily: AppTypography.fontMono,
                    fontSize: StrideTokens.fs12,
                    color: StrideTokens.muted,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 4),
            // Date range
            Text(
              '${_fmtDate(phase.startDate)} – ${_fmtDate(phase.endDate)}',
              style: const TextStyle(
                fontFamily: AppTypography.fontMono,
                fontSize: StrideTokens.fs11,
                color: StrideTokens.muted,
              ),
            ),
            const SizedBox(height: StrideTokens.spaceSm),
            // Focus
            Text(
              phase.focus,
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs13,
                color: StrideTokens.fgSoft,
                height: 1.5,
              ),
            ),
            const SizedBox(height: StrideTokens.spaceSm),
            // Weekly distance range
            _StatRow(
              label: '周量区间',
              value:
                  '${phase.weeklyDistanceKmLow.toStringAsFixed(0)}–${phase.weeklyDistanceKmHigh.toStringAsFixed(0)} km',
            ),
            // Key session types chips
            if (phase.keySessionTypes.isNotEmpty) ...[
              const SizedBox(height: StrideTokens.spaceSm),
              Wrap(
                spacing: StrideTokens.spaceSm,
                runSpacing: 4,
                children: phase.keySessionTypes
                    .map(
                      (s) => Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(
                          color: StrideTokens.grid,
                          borderRadius:
                              BorderRadius.circular(StrideTokens.radiusPill),
                        ),
                        child: Text(
                          s,
                          style: const TextStyle(
                            fontFamily: AppTypography.fontSans,
                            fontSize: StrideTokens.fs11,
                            color: StrideTokens.fgSoft,
                          ),
                        ),
                      ),
                    )
                    .toList(),
              ),
            ],
            // Milestones in this phase
            if (phaseMilestones.isNotEmpty) ...[
              const SizedBox(height: StrideTokens.spaceSm),
              const Divider(height: 1, color: StrideTokens.border2),
              const SizedBox(height: StrideTokens.spaceSm),
              for (final ms in phaseMilestones)
                _MiniMilestoneRow(milestone: ms),
            ],
          ],
        ),
      ),
    );
  }
}

class _StatRow extends StatelessWidget {
  const _StatRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Text(
          label,
          style: const TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs12,
            color: StrideTokens.muted,
          ),
        ),
        const SizedBox(width: StrideTokens.spaceSm),
        Text(
          value,
          style: const TextStyle(
            fontFamily: AppTypography.fontMono,
            fontSize: StrideTokens.fs12,
            fontWeight: FontWeight.w500,
            color: StrideTokens.fg,
          ),
        ),
      ],
    );
  }
}

class _MiniMilestoneRow extends StatelessWidget {
  const _MiniMilestoneRow({required this.milestone});

  final PlanMilestone milestone;

  @override
  Widget build(BuildContext context) {
    final isCompleted = milestone.completedActual != null;
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        children: [
          Icon(
            isCompleted ? Icons.check_circle : Icons.radio_button_unchecked,
            size: 14,
            color: isCompleted ? StrideTokens.accent : StrideTokens.muted,
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              milestone.target,
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs12,
                color:
                    isCompleted ? StrideTokens.muted : StrideTokens.fgSoft,
                decoration:
                    isCompleted ? TextDecoration.lineThrough : null,
              ),
            ),
          ),
          Text(
            milestone.date.replaceAll('-', '.'),
            style: const TextStyle(
              fontFamily: AppTypography.fontMono,
              fontSize: StrideTokens.fs11,
              color: StrideTokens.muted,
            ),
          ),
        ],
      ),
    );
  }
}
