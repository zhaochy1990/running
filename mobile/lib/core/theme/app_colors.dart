import 'package:flutter/material.dart';

/// Color tokens — Vercel DESIGN.md base + STRIDE accent override.
///
/// See [mobile/DESIGN.md](../../../DESIGN.md) for the full design system
/// and [mobile/STRIDE_OVERRIDES.md](../../../STRIDE_OVERRIDES.md) for the
/// two STRIDE-specific deviations (accent color, extended Mono usage).
abstract final class AppColors {
  // ── Backgrounds ────────────────────────────────────────────────────────
  static const Color background = Color(0xFFFAFAFA);
  static const Color surface = Color(0xFFFFFFFF);
  static const Color surfaceMuted = Color(0xFFF5F5F5);

  // ── Foregrounds (text, icons) ──────────────────────────────────────────
  static const Color foreground = Color(0xFF0A0A0A);
  static const Color foregroundMuted = Color(0xFF525252);
  static const Color foregroundSubtle = Color(0xFF8C8C8C);

  // ── Borders ────────────────────────────────────────────────────────────
  static const Color border = Color(0xFFE5E5E5);
  static const Color borderStrong = Color(0xFFD4D4D4);

  // ── Gray scale (Vercel) ────────────────────────────────────────────────
  static const Color gray100 = Color(0xFFF5F5F5);
  static const Color gray200 = Color(0xFFE5E5E5);
  static const Color gray300 = Color(0xFFD4D4D4);
  static const Color gray400 = Color(0xFFA3A3A3);
  static const Color gray500 = Color(0xFF737373);
  static const Color gray600 = Color(0xFF525252);
  static const Color gray700 = Color(0xFF404040);
  static const Color gray800 = Color(0xFF262626);
  static const Color gray900 = Color(0xFF171717);
  static const Color gray1000 = Color(0xFF0A0A0A);

  // ── STRIDE accent (override #1) ────────────────────────────────────────
  /// Primary accent: STRIDE green. Used for CTAs, focus rings,
  /// sparkline highlights, "today" badges, like-button active.
  static const Color accent = Color(0xFF00E676);
  static const Color accentMuted = Color(0xFFB2F0CA);
  static const Color accentDark = Color(0xFF00B85A);

  // ── Status (sparingly applied) ─────────────────────────────────────────
  static const Color success = Color(0xFF00E676);
  static const Color warning = Color(0xFFF59E0B);
  static const Color danger = Color(0xFFE11D48);
  static const Color info = Color(0xFF3B82F6);

  // ── Sport / training-zone tints (mirrors frontend/src/api.ts) ──────────
  static const Color sportRun = Color(0xFF00E676);
  static const Color sportTrack = Color(0xFFB388FF);
  static const Color sportTrail = Color(0xFFFFAB00);
  static const Color sportStrength = Color(0xFFFF6D00);

  /// Heart-rate / training-effect zone colors (Z1-Z5 progression)
  static const Color zoneZ1 = Color(0xFF00E5FF);
  static const Color zoneZ2 = Color(0xFF64DD17);
  static const Color zoneZ3 = Color(0xFFFFAB00);
  static const Color zoneZ4 = Color(0xFFFF6D00);
  static const Color zoneZ5 = Color(0xFFFF1744);
}
