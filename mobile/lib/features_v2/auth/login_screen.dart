/// A2 — Login screen. Dual tab mirroring the miniprogram login page
/// (stride-devops#419): 验证码 (SMS, default) / 邮箱密码, with a 60s
/// resend countdown, an explicit agreement gate and legal links to the
/// declaration viewer.
library;

import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/auth_controller.dart';
import '../../core/auth/auth_models.dart';
import '../../core/router/routes.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/top_bar.dart';
import 'start_screen.dart' show StrideAuthPrimaryButton;

/// 与 auth-service `^1[3-9]\d{9}$` 同口径（#419：客户端校验对齐后端）。
final RegExp _phoneRe = RegExp(r'^1[3-9]\d{9}$');

const int _codeResendSeconds = 60;

class AuthLoginScreen extends ConsumerStatefulWidget {
  const AuthLoginScreen({super.key});

  @override
  ConsumerState<AuthLoginScreen> createState() => _AuthLoginScreenState();
}

class _AuthLoginScreenState extends ConsumerState<AuthLoginScreen> {
  int _tab = 0; // 0 = 验证码（默认），1 = 邮箱密码

  final _phoneCtrl = TextEditingController();
  final _codeCtrl = TextEditingController();
  final _emailCtrl = TextEditingController();
  final _pwdCtrl = TextEditingController();

  bool _agreed = false;
  bool _loading = false;
  bool _sending = false;
  int _countdown = 0;
  Timer? _countdownTimer;
  String? _error;

  @override
  void initState() {
    super.initState();
    // 会话失效回登录页时预填上次的手机号（#419 决议 4，一键重发验证码）；
    // 只在用户还没输入时预填，别覆盖手快敲进去的字。
    ref.read(authRepositoryProvider).lastSmsPhone().then((phone) {
      if (phone != null && phone.isNotEmpty && _phoneCtrl.text.isEmpty && mounted) {
        _phoneCtrl.text = phone;
      }
    });
    _phoneCtrl.addListener(_onEdit);
    _codeCtrl.addListener(_onEdit);
    _emailCtrl.addListener(_onEdit);
    _pwdCtrl.addListener(_onEdit);
  }

  @override
  void dispose() {
    _countdownTimer?.cancel();
    _phoneCtrl.dispose();
    _codeCtrl.dispose();
    _emailCtrl.dispose();
    _pwdCtrl.dispose();
    super.dispose();
  }

  void _onEdit() {
    // Rebuild on every keystroke so the submit button re-evaluates
    // [_canSubmit] — not only when there's an error to clear. Without the
    // unconditional setState the 登录 button never enables as the user types.
    setState(() => _error = null);
  }

  bool get _canSubmit {
    if (_loading) return false;
    return _tab == 0
        ? _phoneCtrl.text.trim().isNotEmpty && _codeCtrl.text.isNotEmpty
        : _emailCtrl.text.trim().isNotEmpty && _pwdCtrl.text.isNotEmpty;
  }

  void _startCountdown() {
    setState(() => _countdown = _codeResendSeconds);
    _countdownTimer?.cancel();
    _countdownTimer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) {
        t.cancel();
        return;
      }
      final next = _countdown - 1;
      setState(() => _countdown = next > 0 ? next : 0);
      if (next <= 0) t.cancel();
    });
  }

  Future<void> _sendCode() async {
    if (_sending || _countdown > 0) return;
    // 未主动勾选协议不允许发短信（同 _submit 的合规门槛，对齐小程序口径）。
    if (!_agreed) {
      setState(() => _error = '请先阅读并勾选同意《用户协议》和《隐私政策》');
      return;
    }
    final phone = _phoneCtrl.text.trim();
    if (!_phoneRe.hasMatch(phone)) {
      setState(() => _error = '请输入正确的手机号');
      return;
    }
    setState(() {
      _sending = true;
      _error = null;
    });
    try {
      await ref.read(authRepositoryProvider).sendSmsCode(phone: phone);
      if (!mounted) return;
      _startCountdown();
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(
          content: Text('验证码已发送'),
          duration: Duration(seconds: 2),
        ));
    } on AuthException catch (e) {
      // 发送失败不启动倒计时——60s 冷却/日上限的中文提示展示在错误区。
      if (mounted) setState(() => _error = e.localized);
    } on DioException {
      if (mounted) setState(() => _error = '网络异常，请检查连接');
    } catch (_) {
      if (mounted) setState(() => _error = '发送失败，请重试');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _submit() async {
    FocusScope.of(context).unfocus();

    // 未主动勾选协议不允许登录（对齐小程序：由用户自主勾选，不允许默示同意）。
    if (!_agreed) {
      setState(() => _error = '请先阅读并勾选同意《用户协议》和《隐私政策》');
      return;
    }

    final controller = ref.read(authControllerProvider.notifier);
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      if (_tab == 0) {
        final phone = _phoneCtrl.text.trim();
        final code = _codeCtrl.text;
        if (!_phoneRe.hasMatch(phone)) {
          setState(() => _error = '请输入正确的手机号');
          return;
        }
        if (!RegExp(r'^\d{6}$').hasMatch(code)) {
          setState(() => _error = '请输入 6 位验证码');
          return;
        }
        await controller.loginWithSms(phone: phone, code: code);
      } else {
        await controller.login(_emailCtrl.text.trim(), _pwdCtrl.text);
      }
      // Router redirect handles navigation.
    } on AuthException catch (e) {
      setState(() => _error = e.localized);
    } on DioException {
      setState(() => _error = '网络异常，请检查连接');
    } catch (_) {
      setState(() => _error = '登录失败，请重试');
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
          onTap: () => context.go(Routes.authStart),
          child: const Icon(Icons.arrow_back_ios_new, size: 18),
        ),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: StrideTokens.space2xl),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: StrideTokens.space2xl),
              _buildTabs(),
              const SizedBox(height: StrideTokens.space2xl),
              if (_tab == 0) ..._buildSmsFields(),
              if (_tab == 1) ..._buildEmailFields(),
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
              if (_tab == 1) ...[
                const SizedBox(height: StrideTokens.spaceMd),
                TextButton(
                  onPressed: () => context.go(Routes.authRegister),
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
              const SizedBox(height: StrideTokens.spaceLg),
              _buildAgreementRow(),
              const SizedBox(height: StrideTokens.space2xl),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildTabs() {
    return Container(
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border),
      ),
      child: Row(
        children: [
          _tabButton(0, '验证码登录'),
          _tabButton(1, '邮箱密码登录'),
        ],
      ),
    );
  }

  Widget _tabButton(int index, String label) {
    final selected = _tab == index;
    return Expanded(
      child: InkWell(
        key: Key('login-tab-$index'),
        onTap: () => setState(() {
          _tab = index;
          _error = null;
        }),
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 10),
          decoration: BoxDecoration(
            color: selected ? StrideTokens.accent : Colors.transparent,
            borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
          ),
          child: Text(
            label,
            textAlign: TextAlign.center,
            style: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs14,
              fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
              color: selected ? StrideTokens.surface : StrideTokens.muted,
            ),
          ),
        ),
      ),
    );
  }

  List<Widget> _buildSmsFields() {
    return [
      _label('手机号'),
      _field(
        key: const Key('login-phone'),
        controller: _phoneCtrl,
        keyboardType: TextInputType.phone,
        hint: '请输入手机号',
      ),
      const SizedBox(height: StrideTokens.spaceLg),
      _label('验证码'),
      Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: _field(
              key: const Key('login-code'),
              controller: _codeCtrl,
              keyboardType: TextInputType.number,
              hint: '6 位验证码',
            ),
          ),
          const SizedBox(width: StrideTokens.spaceMd),
          _sendCodeButton(),
        ],
      ),
    ];
  }

  Widget _sendCodeButton() {
    final disabled = _sending || _countdown > 0;
    final text = _countdown > 0 ? '$_countdown s' : '获取验证码';
    return SizedBox(
      height: 48,
      child: TextButton(
        key: const Key('login-send-code'),
        onPressed: disabled ? null : _sendCode,
        style: TextButton.styleFrom(
          foregroundColor: StrideTokens.accent,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
            side: const BorderSide(color: StrideTokens.border),
          ),
        ),
        child: Text(
          text,
          style: TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs13,
            color: disabled ? StrideTokens.muted2 : StrideTokens.accent,
          ),
        ),
      ),
    );
  }

  List<Widget> _buildEmailFields() {
    return [
      _label('邮箱'),
      _field(
        key: const Key('login-email'),
        controller: _emailCtrl,
        keyboardType: TextInputType.emailAddress,
        hint: 'you@example.com',
      ),
      const SizedBox(height: StrideTokens.spaceLg),
      _label('密码'),
      _field(
        key: const Key('login-password'),
        controller: _pwdCtrl,
        obscure: true,
        hint: '至少 8 位',
      ),
    ];
  }

  Widget _buildAgreementRow() {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 24,
          height: 24,
          child: Checkbox(
            key: const Key('login-agree'),
            value: _agreed,
            onChanged: (v) => setState(() {
              _agreed = v ?? false;
              _error = null;
            }),
          ),
        ),
        const SizedBox(width: StrideTokens.spaceXs),
        Expanded(
          child: Wrap(
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              const Text(
                '我已阅读并同意',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs12,
                  color: StrideTokens.muted,
                ),
              ),
              _legalLink('《用户协议》', Routes.declaration('user_agreement')),
              const Text(
                '和',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs12,
                  color: StrideTokens.muted,
                ),
              ),
              _legalLink('《隐私政策》', Routes.declaration('privacy_policy')),
            ],
          ),
        ),
      ],
    );
  }

  Widget _legalLink(String label, String location) {
    return GestureDetector(
      // push（非 go）：声明页作为二级页入栈，返回键回到登录页。
      onTap: () => context.push(location),
      child: Text(
        label,
        style: const TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: StrideTokens.fs12,
          color: StrideTokens.accent,
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
    Key? key,
    required TextEditingController controller,
    String? hint,
    bool obscure = false,
    TextInputType? keyboardType,
  }) {
    return TextField(
      key: key,
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
