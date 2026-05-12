/// ProfileMenuItem — ListTile wrapper for G1 profile screen entry items.
library;

import 'package:flutter/material.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/tokens.dart';

class ProfileMenuItem extends StatelessWidget {
  const ProfileMenuItem({
    super.key,
    required this.icon,
    required this.label,
    this.trailing,
    this.onTap,
    this.enabled = true,
    this.destructive = false,
  });

  final IconData icon;
  final String label;

  /// Optional trailing widget (e.g. a badge or value text).
  final Widget? trailing;

  final VoidCallback? onTap;
  final bool enabled;

  /// When true, renders label in danger color (for "退出登录").
  final bool destructive;

  @override
  Widget build(BuildContext context) {
    final fgColor = destructive
        ? StrideTokens.danger
        : enabled
            ? StrideTokens.fg
            : StrideTokens.muted2;

    return InkWell(
      onTap: enabled ? onTap : null,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: StrideTokens.spaceLg,
          vertical: StrideTokens.spaceMd,
        ),
        child: Row(
          children: [
            Icon(icon, size: 20, color: fgColor),
            const SizedBox(width: StrideTokens.spaceLg),
            Expanded(
              child: Text(
                label,
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs14,
                  fontWeight: FontWeight.w400,
                  color: fgColor,
                ),
              ),
            ),
            if (trailing != null) ...[
              const SizedBox(width: StrideTokens.spaceSm),
              trailing!,
            ] else if (!destructive)
              Icon(
                Icons.chevron_right,
                size: 18,
                color: enabled ? StrideTokens.muted : StrideTokens.muted2,
              ),
          ],
        ),
      ),
    );
  }
}
