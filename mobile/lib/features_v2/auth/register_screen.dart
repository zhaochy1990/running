/// A3 — Register screen. Email + password + invite code + agreement.
///
/// Realtime validation: email format, password ≥ 8 chars,
/// passwords match, invite code present, agreement checked.
library;

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/auth_controller.dart';
import '../../core/auth/auth_models.dart';
import '../../core/router/routes_v2.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/top_bar.dart';
import 'start_screen.dart' show StrideAuthPrimaryButton;

final _emailRe = RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+\$');

class AuthRegisterScreen extends ConsumerStatefulWidget {
  const AuthRegisterScreen({super.key});

  @override
  ConsumerState<AuthRegisterScreen> createState() =>
      _AuthRegisterScreenState();
}

class _AuthRegisterScreenState extends ConsumerState<AuthRegisterScreen> {
  final _emailCtrl = TextEditingController();
  final _pwdCtrl = TextEditingController();
  final _pwdConfirmCtrl = TextEditingController();
  final _inviteCtrl = TextEditingController();
  bool _agreed = false;
  bool _loading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _emailCtrl.addListener(_onEdit);
    _pwdCtrl.addListener(_onEdit);
    _pwdConfirmCtrl.addListener(_onEdit);
    _inviteCtrl.addListener(_onEdit);
  }

  @override
  void dispose() {
    _emailCtrl.dispose();
    _pwdCtrl.dispose();
    _pwdConfirmCtrl.dispose();
    _inviteCtrl.dispose();
    super.dispose();
  }

  void _onEdit() {
    if (_error != null) setState(() => _error = null);
    setState(() {});
  }

  bool get _emailValid =>
      _emailRe.hasMatch(_emailCtrl.text.trim());
  bool get _passwordValid => _pwdCtrl.text.length >= 8;
  bool get _passwordsMatch =>
      _pwdConfirmCtrl.text.isNotEmpty && _pwdCtrl.text == _pwdConfirmCtrl.text;
  bool get _inviteValid =>
      _inviteCtrl.text.trim().length >= 6 &&
          _inviteCtrl.text.trim().length <= 8;
  bool get _canSubmit =>
      _emailValid &&
      _passwordValid &&
      _passwordsMatch &&
      _inviteValid &&
      _agreed &&
      !_loading;

  String _strengthLabel() {
    final p = _pwdCtrl.text;
    if (p.length < 8) return '弱';
    final hasUpper = p.contains(RegExp(r'[A-Z]'));
    final hasLower = p.contains(RegExp(r'[a-z]'));
    final hasDigit = p.contains(RegExp(r'[0-9]'));
    final hasSym = p.contains(RegExp(r'[^A-Za-z0-9]'));
    final score = [hasUpper, hasLower, hasDigit, hasSym].where((b) => b).length;
    if (p.length >= 12 && score >= 3) return '强';
    if (score >= 2) return '中';
    return '弱';
  }

  Future<void> _submit() async {
    FocusScope.of(context).unfocus();
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await ref.read(authControllerProvider.notifier).register(
            email: _emailCtrl.text.trim(),
            password: _pwdCtrl.text,
            inviteCode: _inviteCtrl.text.trim().toUpperCase(),
          );
      // Router redirect handles navigation post-login.
    } on AuthException catch (e) {
      setState(() => _error = e.message);
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
        title: '注册',
        leading: InkWell(
          onTap: () => context.go(RoutesV2.authStart),
          child: const Icon(Icons.arrow_back_ios_new, size: 18),
        ),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(
            horizontal: StrideTokens.space2xl,
          ),
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
              _label('密码 (至少 8 位)'),
              _field(
                controller: _pwdCtrl,
                obscure: true,
                hint: '至少 8 位',
              ),
              if (_pwdCtrl.text.isNotEmpty) ...[
                const SizedBox(height: StrideTokens.spaceXs),
                Text(
                  '强度: ${_strengthLabel()}',
                  style: const TextStyle(
                    fontFamily: AppTypography.fontMono,
                    fontSize: StrideTokens.fs11,
                    color: StrideTokens.muted,
                  ),
                ),
              ],
              const SizedBox(height: StrideTokens.spaceLg),
              _label('确认密码'),
              _field(
                controller: _pwdConfirmCtrl,
                obscure: true,
                hint: '再输入一次密码',
              ),
              if (_pwdConfirmCtrl.text.isNotEmpty && !_passwordsMatch)
                const Padding(
                  padding: EdgeInsets.only(top: StrideTokens.spaceXs),
                  child: Text(
                    '两次密码不一致',
                    style: TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs11,
                      color: StrideTokens.danger,
                    ),
                  ),
                ),
              const SizedBox(height: StrideTokens.spaceLg),
              _label('邀请码'),
              _field(
                controller: _inviteCtrl,
                hint: '6-8 位',
                upperCase: true,
              ),
              const SizedBox(height: StrideTokens.spaceLg),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Checkbox(
                    value: _agreed,
                    onChanged: (v) => setState(() => _agreed = v ?? false),
                    visualDensity: VisualDensity.compact,
                  ),
                  const Expanded(
                    child: Padding(
                      padding: EdgeInsets.only(top: 10),
                      child: Text(
                        '我已阅读并同意《用户协议》《隐私政策》',
                        style: TextStyle(
                          fontFamily: AppTypography.fontSans,
                          fontSize: StrideTokens.fs13,
                          color: StrideTokens.fgSoft,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
              if (_error != null) ...[
                const SizedBox(height: StrideTokens.spaceMd),
                Text(
                  _error!,
                  key: const Key('register-error'),
                  style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs13,
                    color: StrideTokens.danger,
                  ),
                ),
              ],
              const SizedBox(height: StrideTokens.space2xl),
              StrideAuthPrimaryButton(
                label: '注册',
                onPressed: _canSubmit ? _submit : null,
                loading: _loading,
              ),
              const SizedBox(height: StrideTokens.spaceMd),
              TextButton(
                onPressed: () => context.go(RoutesV2.authLogin),
                child: const Text(
                  '已有账号？去登录',
                  style: TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs14,
                    color: StrideTokens.fgSoft,
                  ),
                ),
              ),
              const SizedBox(height: StrideTokens.space2xl),
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
    bool upperCase = false,
  }) {
    return TextField(
      controller: controller,
      obscureText: obscure,
      keyboardType: keyboardType,
      inputFormatters: upperCase
          ? [
              TextInputFormatter.withFunction((oldValue, newValue) {
                return newValue.copyWith(text: newValue.text.toUpperCase());
              }),
            ]
          : null,
      style: const TextStyle(
        fontFamily: AppTypography.fontSans,
        fontSize: StrideTokens.fs15,
        color: StrideTokens.fg,
      ),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(color: StrideTokens.muted2),
        filled: true,
        fillColor: StrideTokens.surface,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: StrideTokens.spaceMd,
          vertical: StrideTokens.spaceMd,
        ),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
          borderSide: const BorderSide(color: StrideTokens.border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
          borderSide: const BorderSide(color: StrideTokens.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
          borderSide: const BorderSide(color: StrideTokens.accent),
        ),
      ),
    );
  }
}
