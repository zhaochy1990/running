/// StrideScreenHero — the eyebrow + h1 + deck block that opens every
/// screen in the design mock.
///
/// Spec: `spec/mobile_design.html` `:root` rules at lines 2660-2662
/// - `.wf-eyebrow`  mono 10px accent letter-spacing 0.14em uppercase, mt 12
/// - `.wf h1`       sans 22px w600 letter-spacing -0.018em, line-height 1.18
/// - `.wf-deck`     sans 12px muted line-height 1.5, mb 10
///
/// Optional [leading] sits to the left of the eyebrow/title block
/// (e.g. back-button on pushed screens); [trailing] sits on the right
/// at the title row (e.g. D8's accent "训练反馈" entry button).
library;

import 'package:flutter/material.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/tokens.dart';

class StrideScreenHero extends StatelessWidget {
  const StrideScreenHero({
    super.key,
    required this.eyebrow,
    required this.title,
    this.deck,
    this.leading,
    this.trailing,
  });

  /// Convenience constructor for pushed screens that need a back arrow as the
  /// hero's leading slot. Defaults to `Navigator.maybePop` so it works on any
  /// stack depth; callers can override via [onBack].
  StrideScreenHero.withBack({
    super.key,
    required this.eyebrow,
    required this.title,
    this.deck,
    this.trailing,
    VoidCallback? onBack,
  }) : leading = _BackButton(onPressed: onBack);

  /// Convenience constructor for primary tab screens that open the global
  /// account drawer from a top-left ≡ button. [onMenu] is wired by the caller
  /// to `shellScaffoldKey.currentState?.openDrawer()` (the shell owns the key).
  StrideScreenHero.withMenu({
    super.key,
    required this.eyebrow,
    required this.title,
    this.deck,
    this.trailing,
    required VoidCallback onMenu,
  }) : leading = _MenuButton(onPressed: onMenu);

  final String eyebrow;
  final String title;
  final String? deck;
  final Widget? leading;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        StrideTokens.spaceLg,
        StrideTokens.spaceMd,
        StrideTokens.spaceLg,
        StrideTokens.spaceSm,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (leading != null)
            Padding(
              padding: const EdgeInsets.only(bottom: StrideTokens.spaceSm),
              child: IconTheme(
                data: const IconThemeData(
                  size: 20,
                  color: StrideTokens.fgSoft,
                ),
                child: leading!,
              ),
            ),
          Text(
            eyebrow.toUpperCase(),
            style: const TextStyle(
              fontFamily: AppTypography.fontMono,
              fontSize: StrideTokens.fs10,
              color: StrideTokens.accent,
              letterSpacing: 1.4,
              height: 1.2,
            ),
          ),
          const SizedBox(height: 4),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Text(
                  title,
                  style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs22,
                    fontWeight: FontWeight.w600,
                    color: StrideTokens.fg,
                    letterSpacing: -0.4,
                    height: 1.18,
                  ),
                ),
              ),
              if (trailing != null) ...[
                const SizedBox(width: StrideTokens.spaceSm),
                trailing!,
              ],
            ],
          ),
          if (deck != null && deck!.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              deck!,
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs12,
                color: StrideTokens.muted,
                height: 1.5,
              ),
            ),
          ],
          const SizedBox(height: 6),
        ],
      ),
    );
  }
}

class _BackButton extends StatelessWidget {
  const _BackButton({this.onPressed});
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return IconButton(
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints(minWidth: 24, minHeight: 24),
      icon: const Icon(Icons.arrow_back, size: 20),
      onPressed: onPressed ?? () => Navigator.of(context).maybePop(),
    );
  }
}

class _MenuButton extends StatelessWidget {
  const _MenuButton({required this.onPressed});
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return IconButton(
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints(minWidth: 24, minHeight: 24),
      icon: const Icon(Icons.menu, size: 20),
      tooltip: '菜单',
      onPressed: onPressed,
    );
  }
}
