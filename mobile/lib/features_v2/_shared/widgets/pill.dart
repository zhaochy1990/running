/// StridePill — small rounded badge used throughout the mobile UI.
///
/// Mirrors the `.pill` family from the design mock
/// (`~/Downloads/index.html`, lines 337–365).
library;

import 'package:flutter/material.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/pill_colors.dart';
import '../../../core/theme/tokens.dart';

class StridePill extends StatelessWidget {
  const StridePill({
    super.key,
    required this.text,
    this.variant = PillVariant.muted,
    this.dense = false,
  });

  final String text;
  final PillVariant variant;
  final bool dense;

  @override
  Widget build(BuildContext context) {
    final colors = PillColors.of(variant);
    return Container(
      height: dense ? 18 : 20,
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: colors.bg,
        borderRadius: BorderRadius.circular(StrideTokens.radiusPill),
        border: Border.all(color: colors.border, width: 1),
      ),
      child: Text(
        text,
        style: TextStyle(
          fontFamily: AppTypography.fontMono,
          fontSize: StrideTokens.fs11,
          fontWeight: FontWeight.w500,
          color: colors.fg,
          height: 1.0,
        ),
      ),
    );
  }
}
