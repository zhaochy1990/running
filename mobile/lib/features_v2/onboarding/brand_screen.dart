/// B1 — Select watch brand.
///
/// Onboarding step: COROS (v1 primary) or Garmin (v1.1, disabled).
/// Cannot be skipped — the watch is the prerequisite for all features.
library;

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/router/routes_v2.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/pill_colors.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/pill.dart';
import '../_shared/widgets/top_bar.dart';

class BrandScreen extends StatelessWidget {
  const BrandScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: const StrideTopBar(title: '选择你的手表'),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(StrideTokens.spaceXl),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: StrideTokens.spaceLg),
              const Text(
                '我们仅读取训练数据，不会修改手表设置',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs13,
                  color: StrideTokens.muted,
                ),
              ),
              const SizedBox(height: StrideTokens.space2xl),
              _BrandCard(
                brand: 'COROS',
                badge: const StridePill(text: '主推', variant: PillVariant.green),
                enabled: true,
                onTap: () => context.go(RoutesV2.onboardingCoros),
              ),
              const SizedBox(height: StrideTokens.spaceLg),
              const _BrandCard(
                brand: 'Garmin',
                badge: StridePill(
                  text: 'v1.1 即将支持',
                  variant: PillVariant.muted,
                ),
                enabled: false,
                onTap: null,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _BrandCard extends StatelessWidget {
  const _BrandCard({
    required this.brand,
    required this.badge,
    required this.enabled,
    required this.onTap,
  });

  final String brand;
  final Widget badge;
  final bool enabled;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final card = Container(
      padding: const EdgeInsets.symmetric(
        horizontal: StrideTokens.spaceXl,
        vertical: StrideTokens.space2xl,
      ),
      decoration: BoxDecoration(
        color: enabled ? StrideTokens.surface : StrideTokens.bg,
        borderRadius: BorderRadius.circular(StrideTokens.radiusLg),
        border: Border.all(
          color: enabled ? StrideTokens.border : StrideTokens.border2,
        ),
      ),
      child: Row(
        children: [
          Text(
            brand,
            style: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs20,
              fontWeight: FontWeight.w600,
              color: enabled ? StrideTokens.fg : StrideTokens.muted2,
            ),
          ),
          const SizedBox(width: StrideTokens.spaceMd),
          badge,
          const Spacer(),
          Icon(
            Icons.chevron_right,
            size: 24,
            color: enabled ? StrideTokens.fgSoft : StrideTokens.muted2,
          ),
        ],
      ),
    );
    if (!enabled) return card;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(StrideTokens.radiusLg),
      child: card,
    );
  }
}
