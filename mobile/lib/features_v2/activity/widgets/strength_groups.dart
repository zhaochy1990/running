/// StrengthGroups — 力量活动分组卡（对齐小程序 buildStrengthSegments）。
///
/// rest（mode 15/16/17）跳过、连续同名合并、组数=段数、组内均 HR。
library;

import 'package:flutter/material.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/tokens.dart';
import '../models/activity_detail.dart';
import '../utils/strength_groups.dart';

class StrengthGroups extends StatelessWidget {
  const StrengthGroups({super.key, required this.segments});

  final List<LapV2> segments;

  @override
  Widget build(BuildContext context) {
    final groups = buildStrengthGroups(segments);
    if (groups.isEmpty) {
      return const SizedBox.shrink();
    }

    return Column(
      children: [
        const Divider(height: 1, color: StrideTokens.border2),
        for (final g in groups)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: StrideTokens.spaceSm),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    g.name,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs13,
                      fontWeight: FontWeight.w600,
                      color: StrideTokens.fg,
                    ),
                  ),
                ),
                const SizedBox(width: StrideTokens.spaceSm),
                Text(
                                    '$g.sets 组 · ${durationShort(g.durationS)}'
                  ' · 均 HR ${g.avgHr ?? '--'}',
                  style: const TextStyle(
                    fontFamily: AppTypography.fontMono,
                    fontSize: StrideTokens.fs12,
                    color: StrideTokens.muted,
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }

  /// 秒 →「X分Y秒 / Y秒」简写（组时长量级；对齐小程序 fmtDurationShort）。
  static String durationShort(num seconds) {
    final s = seconds.round();
    if (s >= 60) {
      final m = s ~/ 60;
      final rest = s % 60;
      return rest > 0 ? '$m分$rest秒' : '$m分';
    }
    return '$s秒';
  }
}
