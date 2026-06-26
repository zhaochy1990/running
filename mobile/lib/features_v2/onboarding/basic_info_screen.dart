/// B4 — Basic info capture (final onboarding step).
///
/// Fields: sex, birth year, height (cm), weight (kg), resting HR,
/// max HR. RHR/MaxHR may be auto-filled from the
/// `/api/users/me/onboarding/defaults` endpoint.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/router/routes_v2.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/onboarding_scaffold.dart';
import '../_shared/widgets/seg_control.dart';
import 'providers/basic_info_provider.dart';
import 'providers/onboarding_defaults_provider.dart';

class BasicInfoScreen extends ConsumerStatefulWidget {
  const BasicInfoScreen({super.key});

  @override
  ConsumerState<BasicInfoScreen> createState() => _BasicInfoScreenState();
}

class _BasicInfoScreenState extends ConsumerState<BasicInfoScreen> {
  final _birthYearCtrl = TextEditingController();
  final _heightCtrl = TextEditingController();
  final _weightCtrl = TextEditingController();
  final _rhrCtrl = TextEditingController();
  final _maxHrCtrl = TextEditingController();

  @override
  void dispose() {
    _birthYearCtrl.dispose();
    _heightCtrl.dispose();
    _weightCtrl.dispose();
    _rhrCtrl.dispose();
    _maxHrCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final form = ref.watch(basicInfoControllerProvider);
    final controller = ref.read(basicInfoControllerProvider.notifier);
    final defaultsAsync = ref.watch(onboardingDefaultsProvider);

    return OnboardingScaffold(
      stepIndex: 3,
      stepName: '基础信息',
      title: '完善你的基础信息',
      lede: '用于估算你的训练负荷与配速区间，数据只用于你自己的计划。',
      ctaLabel: '完成，进入 STRIDE →',
      ctaLoading: form.submitting,
      onCta: (!form.isComplete || form.submitting)
          ? null
          : () async {
              final ok = await controller.submit();
              if (!context.mounted) return;
              if (ok) {
                context.go(RoutesV2.home);
              } else {
                final err =
                    ref.read(basicInfoControllerProvider).error ?? '提交失败，请稍后再试';
                ScaffoldMessenger.of(
                  context,
                ).showSnackBar(SnackBar(content: Text(err)));
              }
            },
      skipLabel: '稍后填写',
      onSkip: () => context.go(RoutesV2.home),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _label('性别'),
          StrideSegControl(
            options: const ['男', '女'],
            selectedIndex: form.sex == 'male'
                ? 0
                : form.sex == 'female'
                ? 1
                : -1,
            onChanged: (i) => controller.setSex(i == 0 ? 'male' : 'female'),
          ),
          const SizedBox(height: StrideTokens.spaceXl),
          _label('出生年'),
          _numField(
            controller: _birthYearCtrl,
            hint: '例如 1990',
            onChanged: (v) => controller.setBirthYear(int.tryParse(v)),
          ),
          const SizedBox(height: StrideTokens.spaceXl),
          _label('身高 (cm)'),
          _numField(
            controller: _heightCtrl,
            hint: '例如 170',
            onChanged: (v) => controller.setHeightCm(double.tryParse(v)),
          ),
          const SizedBox(height: StrideTokens.spaceXl),
          _label('体重 (kg)'),
          _numField(
            controller: _weightCtrl,
            hint: '例如 65.0',
            decimal: true,
            onChanged: (v) => controller.setWeightKg(double.tryParse(v)),
          ),
          const SizedBox(height: StrideTokens.spaceXl),
          _label('静息心率 (bpm)'),
          Row(
            children: [
              Expanded(
                child: _numField(
                  controller: _rhrCtrl,
                  hint: defaultsAsync.maybeWhen(
                    data: (d) => d.suggestedRhr?.toString() ?? '例如 55',
                    orElse: () => '例如 55',
                  ),
                  onChanged: (v) => controller.setRestingHr(int.tryParse(v)),
                ),
              ),
              const SizedBox(width: StrideTokens.spaceSm),
              _autoFillButton(
                label: '从手表',
                enabled: defaultsAsync.maybeWhen(
                  data: (d) => d.suggestedRhr != null,
                  orElse: () => false,
                ),
                onPressed: () {
                  final v = defaultsAsync.valueOrNull?.suggestedRhr;
                  if (v != null) {
                    _rhrCtrl.text = v.toString();
                    controller.setRestingHr(v);
                  }
                },
              ),
            ],
          ),
          const SizedBox(height: StrideTokens.spaceXl),
          _label('最大心率 (bpm)'),
          Row(
            children: [
              Expanded(
                child: _numField(
                  controller: _maxHrCtrl,
                  hint: defaultsAsync.maybeWhen(
                    data: (d) => d.suggestedMaxHr?.toString() ?? '例如 185',
                    orElse: () => '例如 185',
                  ),
                  onChanged: (v) => controller.setMaxHr(int.tryParse(v)),
                ),
              ),
              const SizedBox(width: StrideTokens.spaceSm),
              _autoFillButton(
                label: '220-age',
                enabled: defaultsAsync.maybeWhen(
                  data: (d) => d.suggestedMaxHr != null,
                  orElse: () => false,
                ),
                onPressed: () {
                  final v = defaultsAsync.valueOrNull?.suggestedMaxHr;
                  if (v != null) {
                    _maxHrCtrl.text = v.toString();
                    controller.setMaxHr(v);
                  }
                },
              ),
            ],
          ),
          const SizedBox(height: StrideTokens.spaceLg),
        ],
      ),
    );
  }

  Widget _label(String text) => Padding(
    padding: const EdgeInsets.only(bottom: StrideTokens.spaceSm),
    child: Text(
      text,
      style: const TextStyle(
        fontFamily: AppTypography.fontSans,
        fontSize: StrideTokens.fs12,
        color: StrideTokens.muted,
      ),
    ),
  );

  Widget _numField({
    required TextEditingController controller,
    required String hint,
    required void Function(String) onChanged,
    bool decimal = false,
  }) {
    return TextField(
      controller: controller,
      keyboardType: TextInputType.numberWithOptions(decimal: decimal),
      onChanged: onChanged,
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

  Widget _autoFillButton({
    required String label,
    required bool enabled,
    required VoidCallback onPressed,
  }) {
    return TextButton(
      onPressed: enabled ? onPressed : null,
      style: TextButton.styleFrom(
        foregroundColor: StrideTokens.accent,
        disabledForegroundColor: StrideTokens.muted2,
      ),
      child: Text(
        label,
        style: const TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: StrideTokens.fs12,
        ),
      ),
    );
  }
}
