/// A2 — Login screen. Email + password + submit, with 401 / network
/// error mapping and a loading state on the primary button.
library;

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/auth_controller.dart';
import '../../core/auth/auth_models.dart';
import '../../core/router/routes_v2.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/top_bar.dart';
import 'start_screen.dart' show StrideAuthPrimaryButton;

class AuthLoginScreen extends ConsumerStatefulWidget {
  const AuthLoginScreen({super.key});

  @override
  ConsumerState<AuthLoginScreen> createState() => _AuthLoginScreenState();
}

class _AuthLoginScreenState extends ConsumerState<AuthLoginScreen> {
  final _emailCtrl = TextEditingController();
  final _pwdCtrl = TextEditingController();
  bool _loading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _emailCtrl.addListener(_onEdit);
    _pwdCtrl.addListener(_onEdit);
  }

  @override
  void dispose() {
    _emailCtrl.dispose();
    _pwdCtrl.dispose();
    super.dispose();
  }

  void _onEdit() {
    if (_error != null) setState(() => _error = null);
  }

  bool get _canSubmit =>
      _emailCtrl.text.trim().isNotEmpty &&
      _pwdCtrl.text.isNotEmpty &&
      !_loading;

  Future<void> _submit() async {
    FocusScope.of(context).unfocus();
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await ref
          .read(authControllerProvider.notifier)
          .login(_emailCtrl.text.trim(), _pwdCtrl.text);
      // Router redirect handles navigation.
    } on AuthException catch (e) {
      setState(() {
        _error = e.statusCode == 401 ? '邮箱或密码错误' : (e.message);
      });
    } on DioException catch (_) {
      setState(() => _error = '网络异常，请检查连接');
    } catch (_) {
      setState(() => _error = '网络异常，请检查连接');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        title: '登录',
        leading: InkWell(
          onTap: () => context.go(RoutesV2.authStart),
          child: const Icon(Icons.arrow_back_ios_new, size: 18),
        ),
      ),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: StrideTokens.space2xl),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: StrideTokens.space2xl),
              _label('邮箱'),
              _field(
                controller: _emailCtrl,
                keyboardType: TextInputType.emailAddress,
                hint: 'you@example.com',
              ),
              const SizedBox(height: StrideTokens.spaceLg),
              _label('密码'),
              _field(
                controller: _pwdCtrl,
                obscure: true,
                hint: '至少 8 位',
              ),
              if (_error != null) ...[
                const SizedBox(height: StrideTokens.spaceMd),
                Text(
                  _error!,
                  key: const Key('login-error'),
                  style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs13,
                    color: StrideTokens.danger,
                  ),
                ),
              ],
              const SizedBox(height: StrideTokens.space2xl),
              StrideAuthPrimaryButton(
                label: '登录',
                onPressed: _canSubmit ? _submit : null,
                loading: _loading,
              ),
              const SizedBox(height: StrideTokens.spaceMd),
              TextButton(
                onPressed: () => context.go(RoutesV2.authRegister),
                child: const Text(
                  '还没有账号？去注册',
                  style: TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs14,
                    color: StrideTokens.fgSoft,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _label(String text) => Padding(
        padding: const EdgeInsets.only(bottom: StrideTokens.spaceXs),
        child: Text(
          text,
          style: const TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs12,
            color: StrideTokens.muted,
          ),
        ),
      );

  Widget _field({
    required TextEditingController controller,
    String? hint,
    bool obscure = false,
    TextInputType? keyboardType,
  }) {
    return TextField(
      controller: controller,
      obscureText: obscure,
      keyboardType: keyboardType,
      style: const TextStyle(
        fontFamily: AppTypography.fontSans,
        fontSize: StrideTokens.fs15,
        color: StrideTokens.fg,
      ),
      decoration: InputDecoration(
        hintText: hint,
        filled: true,
        fillColor: StrideTokens.surface,
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
          borderSide: const BorderSide(color: StrideTokens.border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
          borderSide: const BorderSide(color: StrideTokens.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
          borderSide: const BorderSide(color: StrideTokens.accent),
        ),
      ),
    );
  }
}
