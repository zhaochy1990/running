/// StridePhoneCard — dev-only iPhone-shaped frame used in previews
/// and a future widget book.
///
/// Mirrors `.phone` from the design mock
/// (`~/Downloads/index.html`, lines 195–256). Minimal implementation:
/// rounded 390x844 container that clips its child.
library;

import 'package:flutter/material.dart';

import '../../../core/theme/tokens.dart';

class StridePhoneCard extends StatelessWidget {
  const StridePhoneCard({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(StrideTokens.radiusPhone),
      child: Container(
        width: 390,
        height: 844,
        color: StrideTokens.bg,
        child: child,
      ),
    );
  }
}
