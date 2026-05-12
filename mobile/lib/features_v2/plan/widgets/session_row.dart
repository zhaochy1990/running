/// SessionRow — a single day's training session row in D2 周计划预览.
///
/// Displays:
///   - 日期 + 星期
///   - 课型 pill (E/M/T/I/R/strength/rest)
///   - 课名
///   - 距离 or 时长
library;

import 'package:flutter/material.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/pill_colors.dart';
import '../../../core/theme/tokens.dart';
import '../../_shared/widgets/pill.dart';
import '../../../data/models/plan.dart';

class SessionRow extends StatelessWidget {
  const SessionRow({
    super.key,
    required this.date,
    required this.session,
    required this.onTap,
  });

  final String date;
  final PlannedSession session;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final dateObj = DateTime.tryParse(date);
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: StrideTokens.spaceLg,
          vertical: StrideTokens.spaceMd,
        ),
        child: Row(
          children: [
            // Date column
            SizedBox(
              width: 40,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    dateObj != null
                        ? '${dateObj.month}/${dateObj.day}'
                        : date.substring(5),
                    style: const TextStyle(
                      fontFamily: AppTypography.fontMono,
                      fontSize: StrideTokens.fs13,
                      fontWeight: FontWeight.w600,
                      color: StrideTokens.fg,
                    ),
                  ),
                  Text(
                    _weekdayLabel(dateObj),
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs11,
                      color: StrideTokens.muted,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: StrideTokens.spaceMd),
            // Kind pill
            StridePill(
              text: _kindLabel(session.kind),
              variant: _kindVariant(session.kind),
              dense: true,
            ),
            const SizedBox(width: StrideTokens.spaceMd),
            // Session name
            Expanded(
              child: Text(
                session.title ?? _kindFullLabel(session.kind),
                style: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs14,
                  color: StrideTokens.fg,
                ),
                overflow: TextOverflow.ellipsis,
              ),
            ),
            // Distance or duration
            const SizedBox(width: StrideTokens.spaceSm),
            Text(
              _metricLabel(),
              style: const TextStyle(
                fontFamily: AppTypography.fontMono,
                fontSize: StrideTokens.fs13,
                color: StrideTokens.fgSoft,
              ),
            ),
            const SizedBox(width: StrideTokens.spaceXs),
            const Icon(
              Icons.chevron_right,
              size: 16,
              color: StrideTokens.muted,
            ),
          ],
        ),
      ),
    );
  }

  String _metricLabel() {
    if (session.totalDistanceM != null && session.totalDistanceM! > 0) {
      return '${(session.totalDistanceM! / 1000).toStringAsFixed(1)}km';
    }
    if (session.totalDurationS != null && session.totalDurationS! > 0) {
      final min = (session.totalDurationS! / 60).round();
      return '${min}min';
    }
    return '—';
  }

  static String _weekdayLabel(DateTime? dt) {
    if (dt == null) return '';
    const labels = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    return labels[dt.weekday];
  }

  static String _kindLabel(String kind) {
    return switch (kind.toUpperCase()) {
      'REST' => '休',
      'STRENGTH' => '力',
      _ => kind.toUpperCase(),
    };
  }

  static String _kindFullLabel(String kind) {
    return switch (kind.toUpperCase()) {
      'E' => '轻松跑',
      'M' => '马配跑',
      'T' => '节奏跑',
      'I' => '间歇跑',
      'R' => '冲刺跑',
      'REST' => '休息日',
      'STRENGTH' => '力量训练',
      _ => '训练课',
    };
  }

  static PillVariant _kindVariant(String kind) {
    return switch (kind.toUpperCase()) {
      'E' => PillVariant.green,
      'REST' => PillVariant.muted,
      'R' => PillVariant.danger,
      'STRENGTH' => PillVariant.solid,
      _ => PillVariant.warn, // M / T / I
    };
  }
}

/// RestDayRow — shown when a day has no sessions.
class RestDayRow extends StatelessWidget {
  const RestDayRow({super.key, required this.date});

  final String date;

  @override
  Widget build(BuildContext context) {
    final dateObj = DateTime.tryParse(date);
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: StrideTokens.spaceLg,
        vertical: StrideTokens.spaceMd,
      ),
      child: Row(
        children: [
          SizedBox(
            width: 40,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  dateObj != null
                      ? '${dateObj.month}/${dateObj.day}'
                      : date.substring(5),
                  style: const TextStyle(
                    fontFamily: AppTypography.fontMono,
                    fontSize: StrideTokens.fs13,
                    fontWeight: FontWeight.w600,
                    color: StrideTokens.fg,
                  ),
                ),
                Text(
                  _weekdayLabel(dateObj),
                  style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs11,
                    color: StrideTokens.muted,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: StrideTokens.spaceMd),
          const StridePill(text: '休', variant: PillVariant.muted, dense: true),
          const SizedBox(width: StrideTokens.spaceMd),
          const Text(
            '休息日',
            style: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs14,
              color: StrideTokens.muted,
            ),
          ),
        ],
      ),
    );
  }

  static String _weekdayLabel(DateTime? dt) {
    if (dt == null) return '';
    const labels = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    return labels[dt.weekday];
  }
}
