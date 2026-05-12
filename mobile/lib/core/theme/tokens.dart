import 'package:flutter/material.dart';

/// Design tokens — centralized constants extracted from the STRIDE
/// mobile design mock (`~/Downloads/index.html`, `:root` CSS vars).
///
/// Keep this file as the single source of truth for colors, radius,
/// font size scale, and spacing. Higher-level themes (`AppColors`,
/// `AppTheme`) and shared widgets pull from here.
abstract final class StrideTokens {
  // ── Color tokens ──────────────────────────────────────────────────────
  static const Color bg = Color(0xFFF7F9FB);
  static const Color surface = Color(0xFFFFFFFF);
  static const Color fg = Color(0xFF2C3340);
  static const Color fgSoft = Color(0xFF4A5260);
  static const Color muted = Color(0xFF6B7280);
  static const Color muted2 = Color(0xFFAAB1BD);
  static const Color border = Color(0xFFDFE3EA);
  static const Color border2 = Color(0xFFEBEEF3);
  static const Color accent = Color(0xFF1FAD5B);
  static const Color accentFg = Color(0xFFE8FFEF);
  static const Color warn = Color(0xFFD89A3D);
  static const Color danger = Color(0xFFD74331);
  static const Color grid = Color(0xFFEFF2F6);

  // ── Font size scale ───────────────────────────────────────────────────
  static const double fs10 = 10;
  static const double fs11 = 11;
  static const double fs12 = 12;
  static const double fs13 = 13;
  static const double fs14 = 14;
  static const double fs15 = 15;
  static const double fs18 = 18;
  static const double fs20 = 20;
  static const double fs22 = 22;
  static const double fsDisplay40 = 40;
  static const double fsDisplay48 = 48;
  static const double fsDisplay64 = 64;

  // ── Radius scale ──────────────────────────────────────────────────────
  static const double radiusNone = 0;
  static const double radiusSm = 8;
  static const double radiusMd = 12;
  static const double radiusLg = 14;
  static const double radiusXl = 24;
  static const double radiusPill = 100;
  static const double radiusPhone = 44;

  // ── Spacing scale ─────────────────────────────────────────────────────
  static const double spaceXs = 4;
  static const double spaceSm = 8;
  static const double spaceMd = 12;
  static const double spaceLg = 16;
  static const double spaceXl = 20;
  static const double space2xl = 24;
  static const double space3xl = 32;
}
