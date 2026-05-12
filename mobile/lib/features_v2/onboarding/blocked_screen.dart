/// B5 — Not-bound watch full-screen block.
///
/// Shown when an authenticated user has no watch bound. Cannot be
/// dismissed; the only action is to start the onboarding flow.
library;

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/router/routes_v2.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';

class BlockedScreen extends StatelessWidget {
  const BlockedScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      child: Scaffold(
        backgroundColor: StrideTokens.bg,
        body: Center(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(
                  Icons.watch_off,
                  size: 64,
                  color: StrideTokens.muted2,
                ),
                const SizedBox(height: 16),
                Text(
                  '需要先绑定一款手表',
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs20,
                    fontWeight: FontWeight.w600,
                    color: StrideTokens.fg,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  '所有功能依赖手表数据，请先完成绑定',
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs13,
                    color: StrideTokens.muted,
                  ),
                ),
                const SizedBox(height: 32),
                ElevatedButton(
                  onPressed: () =>
                      context.go(RoutesV2.onboardingBrand),
                  child: const Text('立即绑定'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
