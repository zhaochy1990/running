import 'package:flutter/material.dart';

import 'tokens.dart';

/// Visual variant for [StridePill].
///
/// Mirrors `.pill.green / .pill.warn / .pill.solid / .pill.danger`
/// from the design mock (`~/Downloads/index.html`).
enum PillVariant { green, warn, solid, danger, muted }

/// Resolved color triplet (background / foreground / border) for a pill.
class PillColors {
  const PillColors({required this.bg, required this.fg, required this.border});

  final Color bg;
  final Color fg;
  final Color border;

  static const Map<PillVariant, PillColors> _map = {
    PillVariant.green: PillColors(
      bg: StrideTokens.accentFg,
      fg: StrideTokens.accent,
      // approximation of `color-mix(accent 35%, border)`
      border: Color(0xFFB6D9C2),
    ),
    PillVariant.warn: PillColors(
      bg: StrideTokens.surface,
      fg: StrideTokens.warn,
      border: Color(0xFFE6CFAE),
    ),
    PillVariant.solid: PillColors(
      bg: StrideTokens.fg,
      fg: StrideTokens.surface,
      border: StrideTokens.fg,
    ),
    PillVariant.danger: PillColors(
      bg: StrideTokens.surface,
      fg: StrideTokens.danger,
      border: Color(0xFFE6B5AC),
    ),
    PillVariant.muted: PillColors(
      bg: StrideTokens.surface,
      fg: StrideTokens.fgSoft,
      border: StrideTokens.border,
    ),
  };

  static PillColors of(PillVariant variant) => _map[variant]!;
}
