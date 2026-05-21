/// WfProgressBar — thin progress bar matching `.wf-bar` from
/// `spec/mobile_design.html:2706-2707`:
///
///   height 6px, 1px border (border token), radius 3px,
///   background = page bg (so empty portion reads "outline only"),
///   accent fill driven by [value] (0.0–1.0).
library;

import 'package:flutter/material.dart';

import '../../../core/theme/tokens.dart';

class WfProgressBar extends StatelessWidget {
  const WfProgressBar({
    super.key,
    required this.value,
    this.height = 6,
  });

  /// 0.0 – 1.0. Values outside the range are clamped.
  final double value;
  final double height;

  @override
  Widget build(BuildContext context) {
    final pct = value.clamp(0.0, 1.0);
    return Container(
      height: height,
      decoration: BoxDecoration(
        color: StrideTokens.bg,
        border: Border.all(color: StrideTokens.border, width: 1),
        borderRadius: BorderRadius.circular(3),
      ),
      clipBehavior: Clip.antiAlias,
      child: Align(
        alignment: Alignment.centerLeft,
        child: FractionallySizedBox(
          widthFactor: pct,
          heightFactor: 1,
          child: const ColoredBox(color: StrideTokens.accent),
        ),
      ),
    );
  }
}
