/// StrengthExerciseRow — single row in the D3 strength exercise list.
///
/// Displays: exercise name + "组×次/时间" + rest interval.
/// Used when [PlannedSession] carries exercise spec data from the backend.
library;

import 'package:flutter/material.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/tokens.dart';

class StrengthExerciseRow extends StatelessWidget {
  const StrengthExerciseRow({
    super.key,
    required this.name,
    required this.setsReps,
    this.restSeconds,
    this.showDivider = true,
  });

  /// Exercise name, e.g. "平板支撑".
  final String name;

  /// Sets × reps or time string, e.g. "3×12" or "3×60s".
  final String setsReps;

  /// Rest interval in seconds. Null means no rest shown.
  final int? restSeconds;

  final bool showDivider;

  @override
  Widget build(BuildContext context) {
    final restStr = restSeconds != null ? '休息 ${restSeconds}s' : null;

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: StrideTokens.spaceLg,
            vertical: StrideTokens.spaceMd,
          ),
          child: Row(
            children: [
              // Exercise name
              Expanded(
                child: Text(
                  name,
                  style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs14,
                    color: StrideTokens.fg,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ),
              const SizedBox(width: StrideTokens.spaceMd),
              // Sets × reps
              Text(
                setsReps,
                style: const TextStyle(
                  fontFamily: AppTypography.fontMono,
                  fontSize: StrideTokens.fs13,
                  color: StrideTokens.fgSoft,
                  fontWeight: FontWeight.w600,
                ),
              ),
              if (restStr != null) ...[
                const SizedBox(width: StrideTokens.spaceMd),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: StrideTokens.spaceSm,
                    vertical: 2,
                  ),
                  decoration: BoxDecoration(
                    color: StrideTokens.grid,
                    borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
                  ),
                  child: Text(
                    restStr,
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs11,
                      color: StrideTokens.muted,
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
        if (showDivider)
          const Divider(
            height: 1,
            indent: StrideTokens.spaceLg,
            endIndent: StrideTokens.spaceLg,
            color: StrideTokens.border2,
          ),
      ],
    );
  }
}
