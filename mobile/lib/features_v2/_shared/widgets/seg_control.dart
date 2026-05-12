/// StrideSegControl — horizontal segmented control.
///
/// Mirrors `.seg` from the design mock
/// (`~/Downloads/index.html`, lines 314–337).
library;

import 'package:flutter/material.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/tokens.dart';

class StrideSegControl extends StatelessWidget {
  const StrideSegControl({
    super.key,
    required this.options,
    required this.selectedIndex,
    required this.onChanged,
  });

  final List<String> options;
  final int selectedIndex;
  final void Function(int) onChanged;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(2),
      decoration: BoxDecoration(
        color: StrideTokens.muted2,
        borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
      ),
      child: Row(
        children: [
          for (int i = 0; i < options.length; i++)
            Expanded(child: _segItem(i, options[i])),
        ],
      ),
    );
  }

  Widget _segItem(int index, String label) {
    final active = index == selectedIndex;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => onChanged(index),
      child: Container(
        height: 28,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: active ? StrideTokens.surface : Colors.transparent,
          borderRadius: BorderRadius.circular(StrideTokens.radiusSm - 2),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs13,
            fontWeight: active ? FontWeight.w600 : FontWeight.w500,
            color: active ? StrideTokens.accent : StrideTokens.fgSoft,
          ),
        ),
      ),
    );
  }
}
