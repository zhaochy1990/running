/// WfRow — key/value row used in section bodies (区间, 营养, 睡眠, 菜单).
///
/// Spec: `spec/mobile_design.html:2681-2685`:
///   `.wf-row`     grid 1fr-auto, gap 10, padding 8 0, border-bottom border
///   `.wf-row .l`  sans 12px fg-soft
///   `.wf-row .r`  mono 12px fg w600  (variant `.r.acc` → accent color)
///
/// `trailing` defaults to a [Text] styled per the design; pass a custom
/// widget (e.g. an icon + label) for cases where simple text isn't enough.
library;

import 'package:flutter/material.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/tokens.dart';

enum WfRowEmphasis { normal, accent, muted }

class WfRow extends StatelessWidget {
  const WfRow({
    super.key,
    required this.label,
    this.value,
    this.trailing,
    this.emphasis = WfRowEmphasis.normal,
    this.divider = true,
  }) : assert(
          value != null || trailing != null,
          'WfRow needs either a value string or a custom trailing widget',
        );

  final String label;
  final String? value;
  final Widget? trailing;
  final WfRowEmphasis emphasis;

  /// Show the 1px bottom border. Disable on the last row of a section.
  final bool divider;

  @override
  Widget build(BuildContext context) {
    final valueColor = switch (emphasis) {
      WfRowEmphasis.normal => StrideTokens.fg,
      WfRowEmphasis.accent => StrideTokens.accent,
      WfRowEmphasis.muted => StrideTokens.muted,
    };

    return Container(
      padding: const EdgeInsets.symmetric(vertical: 8),
      decoration: BoxDecoration(
        border: divider
            ? const Border(
                bottom: BorderSide(color: StrideTokens.border, width: 1),
              )
            : null,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(
            child: Text(
              label,
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs12,
                color: StrideTokens.fgSoft,
                height: 1.4,
              ),
            ),
          ),
          const SizedBox(width: 10),
          trailing ??
              Text(
                value!,
                style: TextStyle(
                  fontFamily: AppTypography.fontMono,
                  fontSize: StrideTokens.fs12,
                  fontWeight: FontWeight.w600,
                  color: valueColor,
                ),
              ),
        ],
      ),
    );
  }
}
