/// PhaseChip — compact phase indicator for the horizontal phase timeline.
library;

import 'package:flutter/material.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/tokens.dart';
import '../models/master_plan.dart';

class PhaseChip extends StatelessWidget {
  const PhaseChip({
    super.key,
    required this.phase,
    required this.isCurrent,
    required this.isPast,
    this.onTap,
  });

  final PlanPhase phase;
  final bool isCurrent;
  final bool isPast;
  final VoidCallback? onTap;

  /// Format "2026-05-12" → "5.12"
  static String _shortDate(String iso) {
    final parts = iso.split('-');
    if (parts.length < 3) return iso;
    return '${int.tryParse(parts[1]) ?? parts[1]}.${int.tryParse(parts[2]) ?? parts[2]}';
  }

  @override
  Widget build(BuildContext context) {
    final Color bg;
    final Color fg;
    final Color border;

    if (isCurrent) {
      bg = StrideTokens.accent;
      fg = StrideTokens.surface;
      border = StrideTokens.accent;
    } else if (isPast) {
      bg = StrideTokens.border2;
      fg = StrideTokens.muted;
      border = StrideTokens.border;
    } else {
      bg = StrideTokens.surface;
      fg = StrideTokens.fg;
      border = StrideTokens.border;
    }

    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(StrideTokens.radiusPill),
          border: Border.all(color: border),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              phase.name,
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs12,
                fontWeight: isCurrent ? FontWeight.w600 : FontWeight.w400,
                color: fg,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              '${_shortDate(phase.startDate)}–${_shortDate(phase.endDate)}',
              style: TextStyle(
                fontFamily: AppTypography.fontMono,
                fontSize: StrideTokens.fs10,
                color: isCurrent
                    ? StrideTokens.surface.withValues(alpha: 0.8)
                    : StrideTokens.muted,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
