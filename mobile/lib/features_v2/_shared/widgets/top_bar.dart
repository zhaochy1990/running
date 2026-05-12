/// StrideTopBar — slim app top bar with optional leading + actions.
///
/// Mirrors `.top-bar` from the design mock
/// (`~/Downloads/index.html`, lines 297–312).
library;

import 'package:flutter/material.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/tokens.dart';

class StrideTopBar extends StatelessWidget implements PreferredSizeWidget {
  const StrideTopBar({
    super.key,
    this.title,
    this.leading,
    this.actions = const [],
    this.compact = false,
  });

  final String? title;
  final Widget? leading;
  final List<Widget> actions;
  final bool compact;

  @override
  Size get preferredSize => Size.fromHeight(compact ? 40 : 48);

  @override
  Widget build(BuildContext context) {
    return Container(
      height: preferredSize.height,
      padding: const EdgeInsets.symmetric(horizontal: StrideTokens.spaceLg),
      decoration: const BoxDecoration(
        color: StrideTokens.surface,
        border: Border(bottom: BorderSide(color: StrideTokens.border2)),
      ),
      child: Row(
        children: [
          if (leading != null) ...[
            IconTheme(
              data: const IconThemeData(size: 20, color: StrideTokens.fgSoft),
              child: leading!,
            ),
            const SizedBox(width: StrideTokens.spaceSm),
          ],
          if (title != null)
            Expanded(
              child: Text(
                title!,
                style: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs14,
                  fontWeight: FontWeight.w500,
                  color: StrideTokens.fg,
                ),
              ),
            )
          else
            const Spacer(),
          for (int i = 0; i < actions.length; i++) ...[
            if (i > 0) const SizedBox(width: StrideTokens.spaceSm),
            IconTheme(
              data: const IconThemeData(size: 20, color: StrideTokens.fgSoft),
              child: actions[i],
            ),
          ],
        ],
      ),
    );
  }
}
