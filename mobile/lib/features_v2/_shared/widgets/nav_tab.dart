/// StrideNavTab — single bottom-nav tab item.
///
/// Mirrors `.nav-tab .item` from the design mock
/// (`~/Downloads/index.html`, lines 258–289). A 4px top indicator
/// strip uses the accent color when selected.
library;

import 'package:flutter/material.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/tokens.dart';

class StrideNavTab extends StatelessWidget {
  const StrideNavTab({
    super.key,
    required this.icon,
    required this.label,
    required this.selected,
    required this.onTap,
    this.accentWhenIdle = false,
  });

  final IconData icon;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  /// When true, the icon (not the label) keeps the accent color even when
  /// unselected — used for the "教练" tab to read as the intelligent core.
  final bool accentWhenIdle;

  @override
  Widget build(BuildContext context) {
    final color = selected ? StrideTokens.accent : StrideTokens.muted;
    final iconColor =
        selected ? StrideTokens.accent : (accentWhenIdle ? StrideTokens.accent : StrideTokens.muted);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            height: 4,
            width: 32,
            decoration: BoxDecoration(
              color: selected ? StrideTokens.accent : Colors.transparent,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          const SizedBox(height: 6),
          Icon(icon, size: 22, color: iconColor),
          const SizedBox(height: 2),
          Text(
            label,
            style: TextStyle(
              fontFamily: AppTypography.fontMono,
              fontSize: StrideTokens.fs11,
              fontWeight: FontWeight.w500,
              color: color,
            ),
          ),
        ],
      ),
    );
  }
}
