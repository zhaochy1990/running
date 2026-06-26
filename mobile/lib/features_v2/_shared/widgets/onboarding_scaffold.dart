/// OnboardingScaffold — the shared focus-flow chrome for the B1–B4 steps.
///
/// Mirrors `spec/stitch/mobile/onboarding-*.html`: a row of step dots + a
/// mono eyebrow (`引导 · N / total · 步骤`), an H1 + optional lede, a scrollable
/// body, and a bottom-pinned primary CTA (+ optional skip link).
library;

import 'package:flutter/material.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/tokens.dart';

class OnboardingScaffold extends StatelessWidget {
  const OnboardingScaffold({
    super.key,
    required this.stepIndex,
    required this.stepName,
    required this.title,
    required this.child,
    this.totalSteps = 4,
    this.lede,
    this.onBack,
    this.ctaLabel,
    this.onCta,
    this.ctaLoading = false,
    this.skipLabel,
    this.onSkip,
  });

  /// 0-based index of the current step.
  final int stepIndex;
  final int totalSteps;

  /// Short step name shown in the eyebrow, e.g. "基础信息".
  final String stepName;
  final String title;
  final String? lede;
  final Widget child;

  /// Optional back affordance (omit on no-back steps like sync).
  final VoidCallback? onBack;

  /// Bottom-pinned primary CTA. When [ctaLabel] / [onCta] are null the bottom
  /// bar is hidden (e.g. the watch-brand step advances on card tap).
  final String? ctaLabel;
  final VoidCallback? onCta;
  final bool ctaLoading;

  final String? skipLabel;
  final VoidCallback? onSkip;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: StrideTokens.bg,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // ── Header: back + step dots + eyebrow + H1 + lede ───────────
            Padding(
              padding: const EdgeInsets.fromLTRB(
                StrideTokens.spaceLg,
                StrideTokens.spaceMd,
                StrideTokens.spaceLg,
                0,
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    height: 32,
                    child: Row(
                      children: [
                        if (onBack != null)
                          GestureDetector(
                            behavior: HitTestBehavior.opaque,
                            onTap: onBack,
                            child: const Icon(
                              Icons.arrow_back_ios_new,
                              size: 18,
                              color: StrideTokens.fgSoft,
                            ),
                          ),
                        const Spacer(),
                        _StepDots(stepIndex: stepIndex, totalSteps: totalSteps),
                        const Spacer(),
                        if (onBack != null) const SizedBox(width: 18),
                      ],
                    ),
                  ),
                  const SizedBox(height: StrideTokens.spaceLg),
                  Text(
                    '引导 · ${stepIndex + 1} / $totalSteps · $stepName',
                    style: const TextStyle(
                      fontFamily: AppTypography.fontMono,
                      fontSize: StrideTokens.fs11,
                      color: StrideTokens.muted,
                      letterSpacing: 1.2,
                    ),
                  ),
                  const SizedBox(height: StrideTokens.spaceSm),
                  Text(
                    title,
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs22,
                      fontWeight: FontWeight.w700,
                      color: StrideTokens.fg,
                      height: 1.2,
                    ),
                  ),
                  if (lede != null) ...[
                    const SizedBox(height: StrideTokens.spaceSm),
                    Text(
                      lede!,
                      style: const TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs14,
                        color: StrideTokens.muted,
                        height: 1.5,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(height: StrideTokens.spaceLg),
            // ── Scrollable body ──────────────────────────────────────────
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(
                  StrideTokens.spaceLg,
                  0,
                  StrideTokens.spaceLg,
                  StrideTokens.spaceLg,
                ),
                child: child,
              ),
            ),
            // ── Bottom-pinned CTA ────────────────────────────────────────
            if (ctaLabel != null)
              Padding(
                padding: EdgeInsets.fromLTRB(
                  StrideTokens.spaceLg,
                  StrideTokens.spaceSm,
                  StrideTokens.spaceLg,
                  StrideTokens.spaceMd +
                      MediaQuery.of(context).viewInsets.bottom,
                ),
                child: Column(
                  children: [
                    SizedBox(
                      width: double.infinity,
                      height: 50,
                      child: FilledButton(
                        style: FilledButton.styleFrom(
                          backgroundColor: StrideTokens.accent,
                          foregroundColor: StrideTokens.accentFg,
                          disabledBackgroundColor: StrideTokens.accent
                              .withValues(alpha: 0.4),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(
                              StrideTokens.radiusMd,
                            ),
                          ),
                        ),
                        onPressed: ctaLoading ? null : onCta,
                        child: ctaLoading
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: StrideTokens.accentFg,
                                ),
                              )
                            : Text(
                                ctaLabel!,
                                style: const TextStyle(
                                  fontFamily: AppTypography.fontSans,
                                  fontSize: StrideTokens.fs15,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                      ),
                    ),
                    if (skipLabel != null)
                      TextButton(
                        onPressed: onSkip,
                        child: Text(
                          skipLabel!,
                          style: const TextStyle(
                            fontFamily: AppTypography.fontSans,
                            fontSize: StrideTokens.fs13,
                            color: StrideTokens.muted,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _StepDots extends StatelessWidget {
  const _StepDots({required this.stepIndex, required this.totalSteps});
  final int stepIndex;
  final int totalSteps;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var i = 0; i < totalSteps; i++) ...[
          if (i > 0) const SizedBox(width: 6),
          _dot(i),
        ],
      ],
    );
  }

  Widget _dot(int i) {
    final bool done = i < stepIndex;
    final bool current = i == stepIndex;
    return Container(
      width: current ? 9 : 7,
      height: current ? 9 : 7,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: done ? StrideTokens.accent : StrideTokens.surface,
        border: Border.all(
          color: (done || current) ? StrideTokens.accent : StrideTokens.border,
          width: current ? 2 : 1,
        ),
      ),
    );
  }
}
