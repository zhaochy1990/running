/// MetricCard — half-width card for a single health metric.
///
/// Used in the 2×2 grid on the E1 health overview screen.
/// Shows: title, main value+unit, optional subtitle/delta line, optional pill.
library;

import 'package:flutter/material.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/pill_colors.dart';
import '../../../core/theme/tokens.dart';
import '../../_shared/widgets/pill.dart';

class MetricCard extends StatelessWidget {
  const MetricCard({
    super.key,
    required this.title,
    required this.value,
    this.unit,
    this.subtitle,
    this.pill,
    this.pillVariant = PillVariant.muted,
    this.delta,
    this.deltaPositiveIsBad = false,
  });

  final String title;

  /// Main displayed value (string so callers can show "—" for null).
  final String value;

  final String? unit;

  /// Optional sub-text below the value (e.g. "区间 45–65").
  final String? subtitle;

  /// Optional pill text.
  final String? pill;
  final PillVariant pillVariant;

  /// Optional numeric delta (e.g. +3 bpm vs baseline). Shown with an arrow.
  final int? delta;

  /// When true, a positive delta is displayed in warn/danger color.
  final bool deltaPositiveIsBad;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            title,
            style: const TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs12,
              color: StrideTokens.muted,
              height: 1.2,
            ),
          ),
          const SizedBox(height: StrideTokens.spaceXs),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                value,
                style: const TextStyle(
                  fontFamily: AppTypography.fontMono,
                  fontSize: StrideTokens.fs22,
                  fontWeight: FontWeight.w700,
                  color: StrideTokens.fg,
                  height: 1.1,
                ),
              ),
              if (unit != null) ...[
                const SizedBox(width: 3),
                Padding(
                  padding: const EdgeInsets.only(bottom: 2),
                  child: Text(
                    unit!,
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
          if (delta != null) ...[
            const SizedBox(height: 2),
            _DeltaRow(delta: delta!, positiveIsBad: deltaPositiveIsBad),
          ],
          if (subtitle != null) ...[
            const SizedBox(height: 2),
            Text(
              subtitle!,
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs11,
                color: StrideTokens.muted,
                height: 1.3,
              ),
            ),
          ],
          if (pill != null) ...[
            const SizedBox(height: StrideTokens.spaceSm),
            StridePill(text: pill!, variant: pillVariant),
          ],
        ],
      ),
    );
  }
}

class _DeltaRow extends StatelessWidget {
  const _DeltaRow({required this.delta, required this.positiveIsBad});

  final int delta;
  final bool positiveIsBad;

  @override
  Widget build(BuildContext context) {
    final isPositive = delta > 0;
    final isNeutral = delta == 0;
    Color color;
    IconData icon;
    if (isNeutral) {
      color = StrideTokens.muted;
      icon = Icons.remove;
    } else if (isPositive) {
      color = positiveIsBad ? StrideTokens.warn : StrideTokens.accent;
      icon = Icons.arrow_upward;
    } else {
      color = positiveIsBad ? StrideTokens.accent : StrideTokens.warn;
      icon = Icons.arrow_downward;
    }
    final prefix = isPositive ? '+' : '';
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 12, color: color),
        const SizedBox(width: 2),
        Text(
          '$prefix$delta vs 基线',
          style: TextStyle(
            fontFamily: AppTypography.fontMono,
            fontSize: StrideTokens.fs11,
            color: color,
          ),
        ),
      ],
    );
  }
}
