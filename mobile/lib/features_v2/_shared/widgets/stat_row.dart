/// StrideStatRow — three-column equal-width metric row.
///
/// Mirrors `.stat-row` from the design mock
/// (`~/Downloads/index.html`, lines 372–397). Each column shows
/// a small muted label, a large mono value, and an optional unit.
library;

import 'package:flutter/material.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/tokens.dart';

class StatItem {
  const StatItem({required this.label, required this.value, this.unit});

  final String label;
  final String value;
  final String? unit;
}

class StrideStatRow extends StatelessWidget {
  const StrideStatRow({super.key, required this.items, this.mono = true})
    : assert(items.length == 3, 'StrideStatRow requires exactly 3 items');

  final List<StatItem> items;
  final bool mono;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (int i = 0; i < items.length; i++)
          Expanded(child: _buildItem(items[i])),
      ],
    );
  }

  Widget _buildItem(StatItem item) {
    final valueFont = mono ? AppTypography.fontMono : AppTypography.fontSans;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          item.label,
          style: const TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs12,
            color: StrideTokens.muted,
            height: 1.2,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          item.value,
          style: TextStyle(
            fontFamily: valueFont,
            fontSize: StrideTokens.fs18,
            fontWeight: FontWeight.w700,
            color: StrideTokens.fg,
            height: 1.1,
          ),
        ),
        if (item.unit != null) ...[
          const SizedBox(height: 2),
          Text(
            item.unit!,
            style: const TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs11,
              color: StrideTokens.muted,
              height: 1.1,
            ),
          ),
        ],
      ],
    );
  }
}
