/// Onboarding 单页三步（资料必填 → 绑表可跳 → 同步可跳）—— 小程序镜像。
///
/// 完成只发生在资料步（ADR 0013）；绑表与同步是可选动作，跳过不影响
/// "已完成"。路由守卫不再有 blocked 死路：无表用户放行进首页空态。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/current_user.dart';
import '../../core/router/routes.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../../shared/utils/shanghai_date.dart';
import '../_shared/widgets/onboarding_scaffold.dart';
import '../_shared/widgets/seg_control.dart';
import 'onboarding_controller.dart';

/// OPTIONS 展示与 VALUES 提交分离（Go oneof：中文标签直接 422）。
const _sexOptions = ['男', '女', '其他'];
const _sexValues = ['male', 'female', 'other'];
const _ageOptions = ['暂不透露', '不足 6 个月', '6 个月 – 1 年', '1 – 3 年', '3 年以上'];
const _ageValues = ['unknown', 'lt_6m', '6m_1y', '1y_3y', '3y_plus'];

class OnboardingScreen extends ConsumerWidget {
  const OnboardingScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(onboardingControllerProvider);
    final controller = ref.read(onboardingControllerProvider.notifier);

    switch (state.step) {
      case OnboardingStep.loading:
        return const _LoadingView();
      case OnboardingStep.profile:
        return _ProfileView(state: state, controller: controller);
      case OnboardingStep.watch:
        return _WatchView(state: state, controller: controller);
      case OnboardingStep.sync:
        return _SyncView(state: state, controller: controller);
      case OnboardingStep.ready:
        return const _ReadyView();
    }
  }
}

void _goHome(BuildContext context, WidgetRef ref) {
  // 路由守卫读 currentUserProvider，回首页前让它重取（completed_at 已写上）。
  ref.invalidate(currentUserProvider);
  context.go(Routes.training);
}

// ── loading ────────────────────────────────────────────────────────────────

class _LoadingView extends StatelessWidget {
  const _LoadingView();

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      backgroundColor: StrideTokens.bg,
      body: Center(
        child: CircularProgressIndicator(color: StrideTokens.accent),
      ),
    );
  }
}

// ── 第一步：资料（必填）───────────────────────────────────────────────────

class _ProfileView extends StatelessWidget {
  const _ProfileView({required this.state, required this.controller});

  final OnboardingUi state;
  final OnboardingController controller;

  static DateTime get _todayShanghai => DateTime.parse(shanghaiToday());

  static DateTime _clampInitial(DateTime d) {
    final first = DateTime(1940);
    final last = _todayShanghai;
    if (d.isBefore(first)) return first;
    if (d.isAfter(last)) return last;
    return d;
  }

  Future<void> _pickDob(BuildContext context) async {
    // 未选过时默认打开 1990-01-01，防「随手一点把生日设成今天」。
    final initial = _clampInitial(
      state.dob == null ? DateTime(1990) : DateTime.parse(state.dob!),
    );
    final picked = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: DateTime(1940),
      lastDate: _todayShanghai,
      helpText: '选择生日',
    );
    if (picked != null) {
      controller.setDob(
        '${picked.year.toString().padLeft(4, '0')}-'
        '${picked.month.toString().padLeft(2, '0')}-'
        '${picked.day.toString().padLeft(2, '0')}',
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return OnboardingScaffold(
      stepIndex: 0,
      totalSteps: 3,
      stepName: '资料',
      title: '先认识一下你',
      lede: '这些信息用来算训练负荷和能力基线，填一次就好',
      ctaLabel: state.saving ? '保存中…' : '保存并继续',
      ctaLoading: state.saving,
      onCta: state.saving ? null : () => controller.saveProfile(),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _label('昵称'),
          TextField(
            controller: TextEditingController(text: state.displayName)
              ..selection = TextSelection.collapsed(
                offset: state.displayName.length,
              ),
            onChanged: controller.setDisplayName,
            style: _inputStyle,
            decoration: _inputDecoration(hint: '怎么称呼你'),
          ),
          const SizedBox(height: StrideTokens.spaceXl),
          _label('性别'),
          StrideSegControl(
            options: _sexOptions,
            selectedIndex: state.sex == null
                ? -1
                : _sexValues
                      .indexOf(state.sex!)
                      .clamp(0, _sexValues.length - 1),
            onChanged: (i) => controller.setSex(_sexValues[i]),
          ),
          const SizedBox(height: StrideTokens.spaceXl),
          _label('生日'),
          InkWell(
            onTap: () => _pickDob(context),
            borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
            child: Container(
              height: 48,
              padding: const EdgeInsets.symmetric(
                horizontal: StrideTokens.spaceMd,
              ),
              alignment: Alignment.centerLeft,
              decoration: BoxDecoration(
                color: StrideTokens.surface,
                border: Border.all(color: StrideTokens.border),
                borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
              ),
              child: Text(
                state.dob ?? '请选择',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs15,
                  color: state.dob == null
                      ? StrideTokens.muted2
                      : StrideTokens.fg,
                ),
              ),
            ),
          ),
          const SizedBox(height: StrideTokens.spaceXl),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _label('身高 (cm)'),
                    TextField(
                      controller: TextEditingController(text: state.heightCm),
                      keyboardType: const TextInputType.numberWithOptions(
                        decimal: true,
                      ),
                      onChanged: controller.setHeightCm,
                      style: _inputStyle,
                      decoration: _inputDecoration(hint: '170'),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: StrideTokens.spaceMd),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _label('体重 (kg)'),
                    TextField(
                      controller: TextEditingController(text: state.weightKg),
                      keyboardType: const TextInputType.numberWithOptions(
                        decimal: true,
                      ),
                      onChanged: controller.setWeightKg,
                      style: _inputStyle,
                      decoration: _inputDecoration(hint: '65'),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: StrideTokens.spaceXl),
          _label('跑步年限'),
          DropdownButtonFormField<String>(
            initialValue: state.runningAgeRange,
            hint: const Text(
              '请选择',
              style: TextStyle(color: StrideTokens.muted2),
            ),
            items: [
              for (var i = 0; i < _ageOptions.length; i++)
                DropdownMenuItem(
                  value: _ageValues[i],
                  child: Text(_ageOptions[i]),
                ),
            ],
            onChanged: controller.setRunningAgeRange,
            decoration: _dropdownDecoration(),
          ),
          if (state.formError != null) ...[
            const SizedBox(height: StrideTokens.spaceLg),
            _ErrorText(state.formError!),
          ],
          const SizedBox(height: StrideTokens.spaceLg),
        ],
      ),
    );
  }
}

// ── 第二步：绑表（可跳过）─────────────────────────────────────────────────

class _WatchView extends ConsumerWidget {
  const _WatchView({required this.state, required this.controller});

  final OnboardingUi state;
  final OnboardingController controller;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return OnboardingScaffold(
      stepIndex: 1,
      totalSteps: 3,
      stepName: '手表',
      title: '连接你的运动手表',
      lede: '绑定后训练数据自动同步，训练量与疲劳趋势无需手动记录',
      skipLabel: '稍后再说，先逛逛',
      onSkip: () => _goHome(context, ref),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _brandCard(
            name: 'COROS 高驰',
            desc: '同步训练与心率数据',
            selected: state.provider == 'coros',
            onTap: () => controller.selectProvider('coros'),
          ),
          const SizedBox(height: StrideTokens.spaceMd),
          _brandCard(
            name: 'Garmin 佳明',
            desc: '同步训练与生理数据',
            selected: state.provider == 'garmin',
            onTap: () => controller.selectProvider('garmin'),
          ),
          if (state.provider != null) ...[
            const SizedBox(height: StrideTokens.spaceLg),
            _credentialForm(context),
          ],
          if (state.watchError != null) ...[
            const SizedBox(height: StrideTokens.spaceLg),
            _ErrorText(state.watchError!),
          ],
          const SizedBox(height: StrideTokens.spaceLg),
        ],
      ),
    );
  }

  Widget _credentialForm(BuildContext context) {
    final isGarmin = state.provider == 'garmin';
    return Container(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        border: Border.all(color: StrideTokens.border2),
        borderRadius: BorderRadius.circular(StrideTokens.radiusLg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (isGarmin) ...[
            _label('账号区域'),
            StrideSegControl(
              options: const ['中国区', '国际区'],
              selectedIndex: state.watchRegion == 'global' ? 1 : 0,
              onChanged: (i) =>
                  controller.setWatchRegion(i == 1 ? 'global' : 'cn'),
            ),
            const SizedBox(height: StrideTokens.spaceSm),
            const Align(
              alignment: Alignment.centerLeft,
              child: Text(
                '佳明账号需关闭两步验证（暂不支持 MFA）',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs12,
                  color: StrideTokens.muted,
                ),
              ),
            ),
            const SizedBox(height: StrideTokens.spaceXl),
          ],
          _label('${isGarmin ? 'Garmin' : 'COROS'} 账号'),
          TextField(
            controller: TextEditingController(text: state.watchEmail),
            keyboardType: TextInputType.emailAddress,
            autocorrect: false,
            enableSuggestions: false,
            onChanged: controller.setWatchEmail,
            style: _inputStyle,
            // 占位文案差异对齐小程序：COROS 支持手机号，Garmin 仅邮箱。
            decoration: _inputDecoration(
              hint: isGarmin ? '邮箱' : '邮箱或手机号',
            ),
          ),
          const SizedBox(height: StrideTokens.spaceXl),
          _label('密码'),
          TextField(
            controller: TextEditingController(text: state.watchPassword),
            obscureText: true,
            onChanged: controller.setWatchPassword,
            style: _inputStyle,
            decoration: _inputDecoration(hint: '登录密码'),
          ),
          const SizedBox(height: StrideTokens.spaceXl),
          SizedBox(
            width: double.infinity,
            height: 50,
            child: FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: StrideTokens.accent,
                foregroundColor: StrideTokens.accentFg,
                disabledBackgroundColor: StrideTokens.accent.withValues(
                  alpha: 0.4,
                ),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
                ),
              ),
              onPressed: state.connecting ? null : () => controller.bindWatch(),
              child: state.connecting
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: StrideTokens.accentFg,
                      ),
                    )
                  : Text(
                      state.connecting ? '绑定中…' : '绑定',
                      style: const TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs15,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _brandCard({
    required String name,
    required String desc,
    required bool selected,
    required VoidCallback onTap,
  }) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(StrideTokens.radiusLg),
      child: Container(
        padding: const EdgeInsets.symmetric(
          horizontal: StrideTokens.spaceXl,
          vertical: StrideTokens.spaceLg,
        ),
        decoration: BoxDecoration(
          color: StrideTokens.surface,
          borderRadius: BorderRadius.circular(StrideTokens.radiusLg),
          border: Border.all(
            color: selected ? StrideTokens.accent : StrideTokens.border,
            width: selected ? 1.5 : 1,
          ),
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    name,
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs15,
                      fontWeight: FontWeight.w600,
                      color: StrideTokens.fg,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    desc,
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs12,
                      color: StrideTokens.muted,
                    ),
                  ),
                ],
              ),
            ),
            if (selected)
              const Icon(
                Icons.check_circle,
                size: 22,
                color: StrideTokens.accent,
              ),
          ],
        ),
      ),
    );
  }
}

// ── 第三步：同步（可跳过）─────────────────────────────────────────────────

class _SyncView extends ConsumerWidget {
  const _SyncView({required this.state, required this.controller});

  final OnboardingUi state;
  final OnboardingController controller;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hasError = state.syncError != null;
    return OnboardingScaffold(
      stepIndex: 2,
      totalSteps: 3,
      stepName: '同步',
      title: state.syncPending ? '还在同步中' : '正在准备你的训练数据',
      lede: state.syncPending
          ? '数据量大时会久一些，下次进来会自动接着同步'
          : '首次同步会拉取历史训练并计算能力基线，通常需要十几分钟',
      skipLabel: hasError ? '稍后再说，先逛逛' : '先进入首页',
      onSkip: () => _goHome(context, ref),
      ctaLabel: hasError ? '重试' : null,
      onCta: hasError ? () => controller.retrySync() : null,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (!state.syncPending && !hasError) ...[
            const SizedBox(height: StrideTokens.space2xl),
            const Center(
              child: SizedBox(
                width: 56,
                height: 56,
                child: CircularProgressIndicator(
                  strokeWidth: 3,
                  color: StrideTokens.accent,
                ),
              ),
            ),
            const SizedBox(height: StrideTokens.space2xl),
            Container(
              padding: const EdgeInsets.all(StrideTokens.spaceLg),
              decoration: BoxDecoration(
                color: StrideTokens.surface,
                border: Border.all(color: StrideTokens.border2),
                borderRadius: BorderRadius.circular(StrideTokens.radiusLg),
              ),
              child: Column(
                children: [
                  Text(
                    state.syncText,
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs15,
                      fontWeight: FontWeight.w500,
                      color: StrideTokens.fg,
                    ),
                  ),
                  const SizedBox(height: StrideTokens.spaceMd),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(99),
                    child: LinearProgressIndicator(
                      value: state.percent > 0 ? state.percent / 100 : 0,
                      minHeight: 8,
                      backgroundColor: StrideTokens.grid,
                      color: StrideTokens.accent,
                    ),
                  ),
                  const SizedBox(height: StrideTokens.spaceSm),
                  const Text(
                    '可以先退出，下次进来会接着同步',
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
          if (hasError) ...[
            const SizedBox(height: StrideTokens.spaceLg),
            _ErrorText(state.syncError!),
          ],
          const SizedBox(height: StrideTokens.spaceLg),
        ],
      ),
    );
  }
}

// ── ready ──────────────────────────────────────────────────────────────────

class _ReadyView extends ConsumerWidget {
  const _ReadyView();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      backgroundColor: StrideTokens.bg,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: StrideTokens.space2xl,
          ),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Center(
                child: Icon(
                  Icons.check_circle,
                  size: 64,
                  color: StrideTokens.accent,
                ),
              ),
              const SizedBox(height: StrideTokens.spaceXl),
              const Text(
                '准备就绪',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs22,
                  fontWeight: FontWeight.w700,
                  color: StrideTokens.fg,
                ),
              ),
              const SizedBox(height: StrideTokens.spaceSm),
              const Text(
                '档案已保存。绑了手表的话，训练数据会在首页自动出现',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs14,
                  color: StrideTokens.muted,
                  height: 1.5,
                ),
              ),
              const SizedBox(height: StrideTokens.space2xl),
              SizedBox(
                width: double.infinity,
                height: 50,
                child: FilledButton(
                  style: FilledButton.styleFrom(
                    backgroundColor: StrideTokens.accent,
                    foregroundColor: StrideTokens.accentFg,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(
                        StrideTokens.radiusMd,
                      ),
                    ),
                  ),
                  onPressed: () => _goHome(context, ref),
                  child: const Text(
                    '进入首页',
                    style: TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs15,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ── shared bits ────────────────────────────────────────────────────────────

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

InputDecoration _dropdownDecoration() => _inputDecoration(hint: '请选择');

Widget _label(String text) => Padding(
  padding: const EdgeInsets.only(bottom: StrideTokens.spaceSm),
  child: Text(
    text,
    style: const TextStyle(
      fontFamily: AppTypography.fontSans,
      fontSize: StrideTokens.fs12,
      fontWeight: FontWeight.w600,
      color: StrideTokens.fgSoft,
      letterSpacing: 0.5,
    ),
  ),
);

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
