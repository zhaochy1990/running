/// B2 — COROS account bind screen.
///
/// Captures the user's COROS Training Hub email/password and an
/// explicit region selector (auto-detected from device locale,
/// override is the escape hatch when the heuristic is wrong).
///
/// On success: route forward to /v2/onboarding/sync (B3).
library;

import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/router/routes_v2.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/top_bar.dart';
import '../auth/start_screen.dart' show StrideAuthPrimaryButton;
import 'providers/coros_link_provider.dart';

class CorosLinkScreen extends ConsumerStatefulWidget {
  const CorosLinkScreen({super.key});

  @override
  ConsumerState<CorosLinkScreen> createState() => _CorosLinkScreenState();
}

class _CorosLinkScreenState extends ConsumerState<CorosLinkScreen> {
  final _emailCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();
  String _region = _defaultRegion();

  static String _defaultRegion() {
    // Best-effort locale heuristic: zh_CN → cn, otherwise global.
    // Kept synchronous so the radio renders with a sensible default
    // on first frame; user can flip it manually.
    try {
      final loc = Platform.localeName.toLowerCase();
      if (loc.startsWith('zh_cn') || loc.startsWith('zh-cn')) return 'cn';
    } catch (_) {
      // Platform not available (e.g. web/tests) — fall through.
    }
    return 'global';
  }

  @override
  void initState() {
    super.initState();
    _emailCtrl.addListener(_onChanged);
    _passwordCtrl.addListener(_onChanged);
  }

  @override
  void dispose() {
    _emailCtrl.dispose();
    _passwordCtrl.dispose();
    super.dispose();
  }

  void _onChanged() {
    // Clear inline error as soon as the user edits — matches the
    // common "type to retry" pattern.
    ref.read(corosLinkProvider.notifier).clearError();
    setState(() {});
  }

  bool get _canSubmit =>
      _emailCtrl.text.trim().isNotEmpty &&
      _passwordCtrl.text.isNotEmpty &&
      !ref.read(corosLinkProvider).loading;

  Future<void> _submit() async {
    FocusScope.of(context).unfocus();
    await ref.read(corosLinkProvider.notifier).bind(
          email: _emailCtrl.text.trim(),
          password: _passwordCtrl.text,
          region: _region,
        );
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(corosLinkProvider);

    // Side effect: on success, advance to B3.
    ref.listen<CorosLinkState>(corosLinkProvider, (prev, next) {
      if (next.success && !(prev?.success ?? false)) {
        context.go(RoutesV2.onboardingSync);
      }
    });

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        title: '绑定 COROS',
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          padding: EdgeInsets.zero,
          onPressed: () => context.go(RoutesV2.onboardingBrand),
        ),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(StrideTokens.spaceLg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const _TrustCard(),
              const SizedBox(height: StrideTokens.space2xl),
              const _Label('邮箱'),
              const SizedBox(height: StrideTokens.spaceSm),
              TextField(
                controller: _emailCtrl,
                keyboardType: TextInputType.emailAddress,
                autocorrect: false,
                enableSuggestions: false,
                decoration: _inputDecoration(hint: 'name@example.com'),
              ),
              const SizedBox(height: StrideTokens.spaceLg),
              const _Label('密码'),
              const SizedBox(height: StrideTokens.spaceSm),
              TextField(
                controller: _passwordCtrl,
                obscureText: true,
                decoration: _inputDecoration(hint: 'COROS 账号密码'),
              ),
              const SizedBox(height: StrideTokens.spaceLg),
              const _Label('区域'),
              const SizedBox(height: StrideTokens.spaceSm),
              _RegionPicker(
                value: _region,
                onChanged: (v) => setState(() => _region = v),
              ),
              if (state.error != null) ...[
                const SizedBox(height: StrideTokens.spaceLg),
                _ErrorText(state.error!),
              ],
              const SizedBox(height: StrideTokens.space2xl),
              StrideAuthPrimaryButton(
                label: '绑定',
                loading: state.loading,
                onPressed: _canSubmit ? _submit : null,
              ),
              const SizedBox(height: StrideTokens.spaceMd),
              const Text(
                '我们仅将凭据用于通过 COROS 接口拉取你的训练数据，'
                '不会用于其他用途。',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs12,
                  color: StrideTokens.muted,
                  height: 1.5,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

InputDecoration _inputDecoration({required String hint}) {
  const border = OutlineInputBorder(
    borderSide: BorderSide(color: StrideTokens.border),
    borderRadius: BorderRadius.all(Radius.circular(StrideTokens.radiusMd)),
  );
  return InputDecoration(
    hintText: hint,
    hintStyle: const TextStyle(
      fontFamily: AppTypography.fontSans,
      color: StrideTokens.muted2,
      fontSize: StrideTokens.fs14,
    ),
    filled: true,
    fillColor: StrideTokens.surface,
    border: border,
    enabledBorder: border,
    focusedBorder: const OutlineInputBorder(
      borderSide: BorderSide(color: StrideTokens.accent),
      borderRadius: BorderRadius.all(Radius.circular(StrideTokens.radiusMd)),
    ),
    contentPadding: const EdgeInsets.symmetric(
      horizontal: StrideTokens.spaceMd,
      vertical: StrideTokens.spaceMd,
    ),
  );
}

class _Label extends StatelessWidget {
  const _Label(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Text(
        text,
        style: const TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: StrideTokens.fs12,
          fontWeight: FontWeight.w600,
          color: StrideTokens.fgSoft,
          letterSpacing: 0.5,
        ),
      );
}

class _TrustCard extends StatelessWidget {
  const _TrustCard();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        border: Border.all(color: StrideTokens.border2),
        borderRadius: BorderRadius.circular(StrideTokens.radiusLg),
      ),
      child: const Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.shield_outlined, color: StrideTokens.accent, size: 22),
          SizedBox(width: StrideTokens.spaceMd),
          Expanded(
            child: Text(
              '凭据安全传输并由 COROS 验证。STRIDE 仅保留访问令牌，'
              '不存储你的密码。',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs13,
                color: StrideTokens.fgSoft,
                height: 1.5,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _RegionPicker extends StatelessWidget {
  const _RegionPicker({required this.value, required this.onChanged});
  final String value;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(child: _opt('中国', 'cn')),
        const SizedBox(width: StrideTokens.spaceMd),
        Expanded(child: _opt('全球', 'global')),
      ],
    );
  }

  Widget _opt(String label, String v) {
    final selected = value == v;
    return InkWell(
      onTap: () => onChanged(v),
      borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
      child: Container(
        height: 44,
        padding: const EdgeInsets.symmetric(horizontal: StrideTokens.spaceMd),
        decoration: BoxDecoration(
          color: selected ? StrideTokens.accentFg : StrideTokens.surface,
          border: Border.all(
            color: selected ? StrideTokens.accent : StrideTokens.border,
            width: selected ? 1.5 : 1,
          ),
          borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        ),
        child: Row(
          children: [
            Icon(
              selected ? Icons.radio_button_checked : Icons.radio_button_off,
              size: 18,
              color: selected ? StrideTokens.accent : StrideTokens.muted2,
            ),
            const SizedBox(width: StrideTokens.spaceSm),
            Text(
              label,
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs14,
                fontWeight: FontWeight.w500,
                color: selected ? StrideTokens.fg : StrideTokens.fgSoft,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ErrorText extends StatelessWidget {
  const _ErrorText(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(StrideTokens.spaceMd),
      decoration: BoxDecoration(
        color: const Color(0xFFFDECEA),
        border: Border.all(color: StrideTokens.danger.withValues(alpha: 0.4)),
        borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.error_outline, size: 18, color: StrideTokens.danger),
          const SizedBox(width: StrideTokens.spaceSm),
          Expanded(
            child: Text(
              text,
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs13,
                color: StrideTokens.danger,
                height: 1.4,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
