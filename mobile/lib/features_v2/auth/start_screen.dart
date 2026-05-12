/// A1 — Auth start screen. Logo + slogan + login / register buttons.
library;

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/router/routes_v2.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';

class AuthStartScreen extends StatelessWidget {
  const AuthStartScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: StrideTokens.bg,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: StrideTokens.space2xl),
          child: Column(
            children: [
              const Spacer(flex: 3),
              const Text(
                'STRIDE',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fsDisplay48,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 4,
                  color: StrideTokens.fg,
                ),
              ),
              const SizedBox(height: StrideTokens.spaceMd),
              const Text(
                '马拉松跑步应用',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs14,
                  color: StrideTokens.muted,
                  letterSpacing: 1,
                ),
              ),
              const Spacer(flex: 4),
              _PrimaryButton(
                label: '登录',
                onPressed: () => context.go(RoutesV2.authLogin),
              ),
              const SizedBox(height: StrideTokens.spaceMd),
              _OutlineButton(
                label: '注册',
                onPressed: () => context.go(RoutesV2.authRegister),
              ),
              const SizedBox(height: StrideTokens.space2xl),
            ],
          ),
        ),
      ),
    );
  }
}

class _PrimaryButton extends StatelessWidget {
  const _PrimaryButton({required this.label, required this.onPressed, this.loading = false});
  final String label;
  final VoidCallback? onPressed;
  final bool loading;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      height: 48,
      child: FilledButton(
        style: FilledButton.styleFrom(
          backgroundColor: StrideTokens.accent,
          foregroundColor: StrideTokens.accentFg,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
          ),
        ),
        onPressed: loading ? null : onPressed,
        child: loading
            ? const SizedBox(
                width: 18, height: 18,
                child: CircularProgressIndicator(strokeWidth: 2, color: StrideTokens.accentFg),
              )
            : Text(
                label,
                style: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs15,
                  fontWeight: FontWeight.w600,
                ),
              ),
      ),
    );
  }
}

class _OutlineButton extends StatelessWidget {
  const _OutlineButton({required this.label, required this.onPressed});
  final String label;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      height: 48,
      child: OutlinedButton(
        style: OutlinedButton.styleFrom(
          foregroundColor: StrideTokens.fg,
          side: const BorderSide(color: StrideTokens.border),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
          ),
        ),
        onPressed: onPressed,
        child: Text(
          label,
          style: const TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs15,
            fontWeight: FontWeight.w500,
          ),
        ),
      ),
    );
  }
}

// Exported for reuse within auth feature.
class StrideAuthPrimaryButton extends StatelessWidget {
  const StrideAuthPrimaryButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.loading = false,
  });
  final String label;
  final VoidCallback? onPressed;
  final bool loading;

  @override
  Widget build(BuildContext context) =>
      _PrimaryButton(label: label, onPressed: onPressed, loading: loading);
}
