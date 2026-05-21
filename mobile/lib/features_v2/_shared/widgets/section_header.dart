/// WfSectionHeader — small mono kicker that opens each in-body section.
///
/// Spec: `spec/mobile_design.html:2664-2670`:
///   font-family mono, fs 9, weight 700, letter-spacing 0.16em, uppercase,
///   color muted, flex with optional trailing .v (fg, weight 700).
///
/// Wrap callers in a `Padding(top: 14)` block to match `.wf-section`'s
/// `margin-top: 14` from spec line 2663.
library;

import 'package:flutter/material.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/tokens.dart';

class WfSectionHeader extends StatelessWidget {
  const WfSectionHeader({
    super.key,
    required this.title,
    this.trailing,
  });

  final String title;

  /// Optional right-aligned mono value (e.g. "5/05 — 5/11", "周 W02").
  /// Rendered with fg colour + weight 700 per spec `.wf-section-h .v`.
  final String? trailing;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            child: Text(
              title.toUpperCase(),
              style: const TextStyle(
                fontFamily: AppTypography.fontMono,
                fontSize: 9,
                fontWeight: FontWeight.w700,
                letterSpacing: 1.44,
                color: StrideTokens.muted,
              ),
            ),
          ),
          if (trailing != null)
            Text(
              trailing!,
              style: const TextStyle(
                fontFamily: AppTypography.fontMono,
                fontSize: 9,
                fontWeight: FontWeight.w700,
                letterSpacing: 1.44,
                color: StrideTokens.fg,
              ),
            ),
        ],
      ),
    );
  }
}
