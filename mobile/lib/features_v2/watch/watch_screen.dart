/// 手表管理（/me/watch）—— 双品牌（COROS/Garmin）绑定/解绑/绑定态展示，
/// 复刻小程序 pages/watch（stride-devops#462）。
///
/// 契约：GET / DELETE /api/users/me/watch、POST /api/users/me/watch/login
/// （失败统一 400 防枚举）。region 仅 Garmin 分支显示（COROS 由后端
/// token 自动探测）；Garmin 表单带「关闭两步验证」提示。
/// 绑定成功 → 清表单 + toast + 刷新 → fire-and-forget ensureSync →
/// 跳 onboarding 接同步进度（服务端 watchLogin 只置 watch_ready 不触发同步）。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/api_exception.dart';
import '../../core/auth/current_user.dart';
import '../../core/router/routes.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../../data/api/stride_api.dart';
import '../../data/models/watch.dart';
import '../_shared/widgets/seg_control.dart';
import '../_shared/widgets/top_bar.dart';
import '../onboarding/onboarding_sync.dart';
import 'watch_providers.dart';

class WatchScreen extends ConsumerStatefulWidget {
  const WatchScreen({super.key, this.initialProvider});

  /// `?provider=coros|garmin` 直达对应品牌表单（onboarding 品牌卡跳转用），
  /// 其他值按未传处理。
  final String? initialProvider;

  @override
  ConsumerState<WatchScreen> createState() => _WatchScreenState();
}

class _WatchScreenState extends ConsumerState<WatchScreen> {
  static const _regionOptions = ['中国区', '国际区'];

  String? _connectProvider; // coros | garmin；null = 品牌选择网格
  final _email = TextEditingController();
  final _password = TextEditingController();
  String _region = 'cn';
  bool _connecting = false;
  bool _disconnecting = false;
  bool _confirmingUnbind = false;
  String? _formError;

  @override
  void initState() {
    super.initState();
    final p = widget.initialProvider;
    if (p == 'coros' || p == 'garmin') _connectProvider = p;
  }

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final watchAsync = ref.watch(watchInfoProvider);
    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: const StrideTopBar(title: '手表管理'),
      body: watchAsync.when(
        loading: () => const Center(
          child: CircularProgressIndicator(color: StrideTokens.accent),
        ),
        error: (_, _) => Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text(
                '加载手表信息失败',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs14,
                  color: StrideTokens.muted,
                ),
              ),
              const SizedBox(height: StrideTokens.spaceMd),
              FilledButton(
                onPressed: () => ref.invalidate(watchInfoProvider),
                style: FilledButton.styleFrom(
                  backgroundColor: StrideTokens.accent,
                  foregroundColor: StrideTokens.accentFg,
                ),
                child: const Text('重试'),
              ),
            ],
          ),
        ),
        data: (info) => ListView(
          padding: const EdgeInsets.all(StrideTokens.spaceLg),
          children: [
            _statusCard(info),
            const SizedBox(height: StrideTokens.spaceLg),
            if (info.bound) _unbindCard() else _bindCard(),
          ],
        ),
      ),
    );
  }

  // ── 当前绑定 ───────────────────────────────────────────────────────────

  Widget _statusCard(WatchInfo info) {
    return _card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const _SectionLabel('当前绑定'),
          const SizedBox(height: StrideTokens.spaceLg),
          if (info.bound) ...[
            Row(
              children: [
                const Icon(Icons.watch_outlined,
                    size: 22, color: StrideTokens.accent),
                const SizedBox(width: StrideTokens.spaceMd),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        info.brandLabel,
                        style: const TextStyle(
                          fontFamily: AppTypography.fontSans,
                          fontSize: StrideTokens.fs15,
                          fontWeight: FontWeight.w700,
                          color: StrideTokens.fg,
                        ),
                      ),
                      if (info.email != null) ...[
                        const SizedBox(height: 2),
                        Text(
                          info.email!,
                          style: const TextStyle(
                            fontFamily: AppTypography.fontSans,
                            fontSize: StrideTokens.fs12,
                            color: StrideTokens.muted,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                const _ConnectedPill(),
              ],
            ),
            if (info.device != null) ...[
              const SizedBox(height: StrideTokens.spaceMd),
              _metaRow('设备型号', info.device!),
            ],
            if (info.lastSyncText != null) ...[
              const SizedBox(height: StrideTokens.spaceSm),
              _metaRow('最后同步', info.lastSyncText!),
            ],
            if (info.capabilities.isNotEmpty) ...[
              const SizedBox(height: StrideTokens.spaceMd),
              const Text(
                '支持功能',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs12,
                  fontWeight: FontWeight.w600,
                  color: StrideTokens.fgSoft,
                  letterSpacing: 0.5,
                ),
              ),
              const SizedBox(height: StrideTokens.spaceSm),
              Wrap(
                spacing: StrideTokens.spaceSm,
                runSpacing: StrideTokens.spaceSm,
                children: [
                  for (final c in info.capabilities)
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: StrideTokens.spaceSm,
                        vertical: 2,
                      ),
                      decoration: BoxDecoration(
                        color: StrideTokens.bg,
                        border: Border.all(color: StrideTokens.border2),
                        borderRadius:
                            BorderRadius.circular(StrideTokens.radiusSm),
                      ),
                      child: Text(
                        c,
                        style: const TextStyle(
                          fontFamily: AppTypography.fontSans,
                          fontSize: StrideTokens.fs12,
                          color: StrideTokens.muted,
                        ),
                      ),
                    ),
                ],
              ),
            ],
          ] else ...[
            const Center(
              child: Column(
                children: [
                  Text('⌚', style: TextStyle(fontSize: 40)),
                  SizedBox(height: StrideTokens.spaceSm),
                  Text(
                    '未绑定手表',
                    style: TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs15,
                      fontWeight: FontWeight.w600,
                      color: StrideTokens.fg,
                    ),
                  ),
                  SizedBox(height: 2),
                  Text(
                    '绑定手表后可同步训练数据',
                    style: TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs12,
                      color: StrideTokens.muted,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }

  // ── 解绑（内联确认卡片，非模态）────────────────────────────────────────

  Widget _unbindCard() {
    return _card(
      danger: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const _SectionLabel('解除绑定', danger: true),
          const SizedBox(height: StrideTokens.spaceSm),
          const Text(
            '解除绑定将清除手表登录凭据。已同步的训练数据不会被删除，但无法再同步新数据。',
            style: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs13,
              color: StrideTokens.muted,
              height: 1.5,
            ),
          ),
          const SizedBox(height: StrideTokens.spaceLg),
          if (_confirmingUnbind)
            Row(
              children: [
                Expanded(
                  child: FilledButton(
                    onPressed: _disconnecting ? null : _unbind,
                    style: FilledButton.styleFrom(
                      backgroundColor: StrideTokens.danger,
                      foregroundColor: StrideTokens.surface,
                      disabledBackgroundColor:
                          StrideTokens.danger.withValues(alpha: 0.4),
                    ),
                    child: Text(_disconnecting ? '解除中...' : '确认解除'),
                  ),
                ),
                const SizedBox(width: StrideTokens.spaceMd),
                Expanded(
                  child: OutlinedButton(
                    onPressed: _disconnecting
                        ? null
                        : () => setState(() => _confirmingUnbind = false),
                    child: const Text('取消'),
                  ),
                ),
              ],
            )
          else
            SizedBox(
              width: double.infinity,
              child: OutlinedButton(
                onPressed: () => setState(() => _confirmingUnbind = true),
                style: OutlinedButton.styleFrom(
                  foregroundColor: StrideTokens.danger,
                  side: const BorderSide(color: StrideTokens.danger),
                ),
                child: const Text('解除绑定'),
              ),
            ),
        ],
      ),
    );
  }

  Future<void> _unbind() async {
    if (_disconnecting) return;
    setState(() => _disconnecting = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(strideApiProvider).unbindWatch();
    } catch (_) {
      if (!mounted) return;
      setState(() => _disconnecting = false);
      messenger.showSnackBar(
        const SnackBar(
          content: Text('解除绑定失败，请重试'),
          backgroundColor: StrideTokens.danger,
        ),
      );
      return;
    }
    if (!mounted) return;
    setState(() {
      _disconnecting = false;
      _confirmingUnbind = false;
    });
    ref.invalidate(watchInfoProvider);
    ref.invalidate(currentUserProvider);
    messenger.showSnackBar(
      const SnackBar(
        content: Text('已解除绑定'),
        backgroundColor: StrideTokens.accent,
      ),
    );
  }

  // ── 绑定表单 ───────────────────────────────────────────────────────────

  Widget _bindCard() {
    return _card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const _SectionLabel('绑定手表'),
          const SizedBox(height: StrideTokens.spaceLg),
          if (_connectProvider == null)
            Row(
              children: [
                Expanded(
                  child: _brandCard(
                    name: 'COROS',
                    sub: '高驰',
                    onTap: () => _selectProvider('coros'),
                  ),
                ),
                const SizedBox(width: StrideTokens.spaceMd),
                Expanded(
                  child: _brandCard(
                    name: 'Garmin',
                    sub: '佳明',
                    onTap: () => _selectProvider('garmin'),
                  ),
                ),
              ],
            )
          else ...[
            Row(
              children: [
                Expanded(
                  child: Text(
                    _connectProvider == 'coros' ? 'COROS 高驰' : 'Garmin 佳明',
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs15,
                      fontWeight: FontWeight.w700,
                      color: StrideTokens.fg,
                    ),
                  ),
                ),
                TextButton(
                  onPressed: _connecting
                      ? null
                      : () => setState(() {
                          _connectProvider = null;
                          _formError = null;
                        }),
                  child: const Text(
                    '换一个',
                    style: TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs13,
                      color: StrideTokens.accent,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: StrideTokens.spaceSm),
            TextField(
              controller: _email,
              keyboardType: TextInputType.emailAddress,
              autocorrect: false,
              enableSuggestions: false,
              onChanged: (_) => setState(() => _formError = null),
              style: _inputStyle,
              decoration:
                  _inputDecoration(hint: _isGarmin ? '邮箱' : '邮箱或手机号'),
            ),
            const SizedBox(height: StrideTokens.spaceMd),
            TextField(
              controller: _password,
              obscureText: true,
              onChanged: (_) => setState(() => _formError = null),
              style: _inputStyle,
              decoration: _inputDecoration(hint: '密码'),
            ),
            if (_isGarmin) ...[
              const SizedBox(height: StrideTokens.spaceMd),
              const Text(
                '账号区域',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs12,
                  fontWeight: FontWeight.w600,
                  color: StrideTokens.fgSoft,
                  letterSpacing: 0.5,
                ),
              ),
              const SizedBox(height: StrideTokens.spaceSm),
              StrideSegControl(
                options: _regionOptions,
                selectedIndex: _region == 'global' ? 1 : 0,
                onChanged: (i) =>
                    setState(() => _region = i == 1 ? 'global' : 'cn'),
              ),
              const SizedBox(height: StrideTokens.spaceSm),
              const Text(
                '佳明账号需关闭两步验证（暂不支持 MFA）',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs12,
                  color: StrideTokens.muted,
                ),
              ),
            ],
            if (_formError != null) ...[
              const SizedBox(height: StrideTokens.spaceMd),
              Text(
                _formError!,
                style: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs13,
                  color: StrideTokens.danger,
                ),
              ),
            ],
            const SizedBox(height: StrideTokens.spaceLg),
            SizedBox(
              width: double.infinity,
              height: 46,
              child: FilledButton(
                onPressed:
                    (_connecting || _emailTrimmed.isEmpty || _password.text.isEmpty)
                        ? null
                        : _bind,
                style: FilledButton.styleFrom(
                  backgroundColor: StrideTokens.accent,
                  foregroundColor: StrideTokens.accentFg,
                  disabledBackgroundColor:
                      StrideTokens.accent.withValues(alpha: 0.4),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
                  ),
                ),
                child: _connecting
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: StrideTokens.accentFg,
                        ),
                      )
                    : Text(_connecting ? '连接中...' : '绑定'),
              ),
            ),
          ],
        ],
      ),
    );
  }

  bool get _isGarmin => _connectProvider == 'garmin';

  String get _emailTrimmed => _email.text.trim();

  void _selectProvider(String p) =>
      setState(() { _connectProvider = p; _formError = null; });

  Future<void> _bind() async {
    final provider = _connectProvider;
    if (provider == null || _connecting) return;
    final email = _emailTrimmed;
    final password = _password.text;
    if (email.isEmpty || password.isEmpty) return;
    final region = _region;

    setState(() {
      _connecting = true;
      _formError = null;
    });
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref
          .read(strideApiProvider)
          .watchLogin(
            provider: provider,
            email: email,
            password: password,
            region: region,
          );
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _connecting = false;
        _formError = _loginError(e);
      });
      return;
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _connecting = false;
        _formError = '网络异常，请检查网络后重试';
      });
      return;
    }
    if (!mounted) return;
    setState(() => _connecting = false);
    // 先取再 invalidate：invalidate 后 currentUserProvider 重取未落定，
    // currentUserIdProvider 会读到 null，会静默跳过 ensureSync + 跳转。
    final userId = ref.read(currentUserIdProvider);
    _email.clear();
    _password.clear();
    ref.invalidate(watchInfoProvider);
    ref.invalidate(currentUserProvider);
    messenger.showSnackBar(
      const SnackBar(
        content: Text('绑定成功'),
        backgroundColor: StrideTokens.accent,
      ),
    );
    if (userId == null) return;
    // fire-and-forget：绑表是用户可见动作，不值得为它加一次往返延迟；
    // onboarding 页自己会重算落点并接续（失败时也由它重试）。
    unawaited(
      ref
          .read(onboardingSyncProvider)
          .ensureSync(userId)
          .then<void>((_) {}, onError: (Object _) {}),
    );
    context.go(Routes.onboarding);
  }

  // Go watch/login 失败统一 400：error 体优先展示，防枚举的兜底文案收尾。
  String _loginError(ApiException e) {
    final d = e.detail;
    if (d is Map) {
      final msg = (d['error'] ?? d['detail'])?.toString();
      if (msg != null && msg.isNotEmpty) return msg;
    }
    if (e.message.isNotEmpty && e.message != 'HTTP ${e.statusCode}') {
      return e.message;
    }
    return '登录失败，请检查账号密码';
  }


  // ── 小部件 ─────────────────────────────────────────────────────────────

  Widget _brandCard({
    required String name,
    required String sub,
    required VoidCallback onTap,
  }) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(StrideTokens.radiusLg),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: StrideTokens.spaceLg),
        decoration: BoxDecoration(
          color: StrideTokens.bg,
          border: Border.all(color: StrideTokens.border),
          borderRadius: BorderRadius.circular(StrideTokens.radiusLg),
        ),
        child: Column(
          children: [
            Text(
              name,
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs15,
                fontWeight: FontWeight.w700,
                color: StrideTokens.fg,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              sub,
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs12,
                color: StrideTokens.muted,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

Widget _card({required Widget child, bool danger = false}) {
  return Container(
    padding: const EdgeInsets.all(StrideTokens.spaceLg),
    decoration: BoxDecoration(
      color: StrideTokens.surface,
      border: Border.all(
        color: danger
            ? StrideTokens.danger.withValues(alpha: 0.35)
            : StrideTokens.border2,
      ),
      borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
    ),
    child: child,
  );
}

Widget _metaRow(String label, String value) {
  return Row(
    mainAxisAlignment: MainAxisAlignment.spaceBetween,
    children: [
      Text(
        label,
        style: const TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: StrideTokens.fs13,
          color: StrideTokens.muted,
        ),
      ),
      Flexible(
        child: Text(
          value,
          textAlign: TextAlign.right,
          style: const TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs13,
            color: StrideTokens.fg,
          ),
        ),
      ),
    ],
  );
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text, {this.danger = false});

  final String text;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: TextStyle(
        fontFamily: AppTypography.fontSans,
        fontSize: StrideTokens.fs12,
        fontWeight: FontWeight.w600,
        color: danger ? StrideTokens.danger : StrideTokens.fgSoft,
        letterSpacing: 0.5,
      ),
    );
  }
}

class _ConnectedPill extends StatelessWidget {
  const _ConnectedPill();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: StrideTokens.spaceSm,
        vertical: 3,
      ),
      decoration: BoxDecoration(
        color: StrideTokens.accent.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(99),
      ),
      child: const Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.circle, size: 6, color: StrideTokens.accent),
          SizedBox(width: 4),
          Text(
            '已连接',
            style: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs12,
              color: StrideTokens.accent,
            ),
          ),
        ],
      ),
    );
  }
}

// 手表页局部复用 onboarding 表单的视觉参数（色板/圆角/字体与全 App 一致）。
const _inputStyle = TextStyle(
  fontFamily: AppTypography.fontSans,
  fontSize: StrideTokens.fs15,
  color: StrideTokens.fg,
);

InputDecoration _inputDecoration({required String hint}) {
  final border = OutlineInputBorder(
    borderSide: const BorderSide(color: StrideTokens.border),
    borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
  );
  return InputDecoration(
    hintText: hint,
    hintStyle: const TextStyle(
      color: StrideTokens.muted2,
      fontSize: StrideTokens.fs14,
    ),
    filled: true,
    fillColor: StrideTokens.surface,
    contentPadding: const EdgeInsets.symmetric(
      horizontal: StrideTokens.spaceMd,
      vertical: StrideTokens.spaceMd,
    ),
    border: border,
    enabledBorder: border,
    focusedBorder: border.copyWith(
      borderSide: const BorderSide(color: StrideTokens.accent),
    ),
  );
}
