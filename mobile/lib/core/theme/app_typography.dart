import 'package:flutter/material.dart';

import 'app_colors.dart';

/// Typography tokens — Geist Sans for body/headings, Geist Mono for all
/// numeric data (override #2 from STRIDE_OVERRIDES.md).
abstract final class AppTypography {
  static const String fontSans = 'GeistSans';
  static const String fontMono = 'GeistMono';

  /// Body / heading text — Geist Sans
  static const TextTheme textTheme = TextTheme(
    // Display
    displayLarge: TextStyle(
      fontFamily: fontSans,
      fontSize: 48,
      fontWeight: FontWeight.w700,
      letterSpacing: -1.2,
      height: 1.1,
      color: AppColors.foreground,
    ),
    displayMedium: TextStyle(
      fontFamily: fontSans,
      fontSize: 36,
      fontWeight: FontWeight.w700,
      letterSpacing: -0.8,
      height: 1.15,
      color: AppColors.foreground,
    ),
    displaySmall: TextStyle(
      fontFamily: fontSans,
      fontSize: 28,
      fontWeight: FontWeight.w600,
      letterSpacing: -0.5,
      height: 1.2,
      color: AppColors.foreground,
    ),

    // Headings
    headlineMedium: TextStyle(
      fontFamily: fontSans,
      fontSize: 22,
      fontWeight: FontWeight.w600,
      letterSpacing: -0.3,
      height: 1.25,
      color: AppColors.foreground,
    ),
    headlineSmall: TextStyle(
      fontFamily: fontSans,
      fontSize: 18,
      fontWeight: FontWeight.w600,
      letterSpacing: -0.2,
      height: 1.3,
      color: AppColors.foreground,
    ),

    // Title (used in app bars, card headers)
    titleLarge: TextStyle(
      fontFamily: fontSans,
      fontSize: 16,
      fontWeight: FontWeight.w600,
      height: 1.35,
      color: AppColors.foreground,
    ),
    titleMedium: TextStyle(
      fontFamily: fontSans,
      fontSize: 14,
      fontWeight: FontWeight.w500,
      height: 1.4,
      color: AppColors.foreground,
    ),
    titleSmall: TextStyle(
      fontFamily: fontSans,
      fontSize: 13,
      fontWeight: FontWeight.w500,
      letterSpacing: 0.1,
      height: 1.4,
      color: AppColors.foregroundMuted,
    ),

    // Body
    bodyLarge: TextStyle(
      fontFamily: fontSans,
      fontSize: 16,
      fontWeight: FontWeight.w400,
      height: 1.55,
      color: AppColors.foreground,
    ),
    bodyMedium: TextStyle(
      fontFamily: fontSans,
      fontSize: 14,
      fontWeight: FontWeight.w400,
      height: 1.55,
      color: AppColors.foreground,
    ),
    bodySmall: TextStyle(
      fontFamily: fontSans,
      fontSize: 12,
      fontWeight: FontWeight.w400,
      height: 1.5,
      color: AppColors.foregroundMuted,
    ),

    // Label (buttons, chips)
    labelLarge: TextStyle(
      fontFamily: fontSans,
      fontSize: 14,
      fontWeight: FontWeight.w500,
      letterSpacing: 0.2,
      color: AppColors.foreground,
    ),
    labelMedium: TextStyle(
      fontFamily: fontSans,
      fontSize: 12,
      fontWeight: FontWeight.w500,
      letterSpacing: 0.3,
      color: AppColors.foregroundMuted,
    ),
    labelSmall: TextStyle(
      fontFamily: fontSans,
      fontSize: 11,
      fontWeight: FontWeight.w500,
      letterSpacing: 0.4,
      color: AppColors.foregroundSubtle,
    ),
  );

  // ── Mono variants (numeric data per STRIDE_OVERRIDES.md) ────────────────

  /// Display-size mono — used for race results, hero metrics
  static const TextStyle monoDisplay = TextStyle(
    fontFamily: fontMono,
    fontSize: 32,
    fontWeight: FontWeight.w700,
    letterSpacing: -0.5,
    height: 1.1,
    color: AppColors.foreground,
  );

  /// Headline-size mono — for primary metric in cards (e.g. "26.2 km")
  static const TextStyle monoHeadline = TextStyle(
    fontFamily: fontMono,
    fontSize: 22,
    fontWeight: FontWeight.w700,
    letterSpacing: -0.2,
    height: 1.2,
    color: AppColors.foreground,
  );

  /// Title-size mono — for secondary metrics in cards
  static const TextStyle monoTitle = TextStyle(
    fontFamily: fontMono,
    fontSize: 16,
    fontWeight: FontWeight.w500,
    height: 1.3,
    color: AppColors.foreground,
  );

  /// Body-size mono — for inline numbers in lists, table cells
  static const TextStyle monoBody = TextStyle(
    fontFamily: fontMono,
    fontSize: 14,
    fontWeight: FontWeight.w400,
    height: 1.4,
    color: AppColors.foreground,
  );

  /// Caption-size mono — for sublabels, deltas
  static const TextStyle monoCaption = TextStyle(
    fontFamily: fontMono,
    fontSize: 12,
    fontWeight: FontWeight.w400,
    height: 1.4,
    color: AppColors.foregroundMuted,
  );
}
