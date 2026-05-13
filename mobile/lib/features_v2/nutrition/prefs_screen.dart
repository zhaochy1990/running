/// F1 — 营养偏好 (Nutrition Preferences screen).
///
/// US-004: GET/PUT /api/users/me/nutrition-prefs
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/router/routes_v2.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/seg_control.dart';
import '../_shared/widgets/top_bar.dart';
import 'models/nutrition_prefs.dart';
import 'providers/nutrition_prefs_provider.dart';

class NutritionPrefsScreen extends ConsumerStatefulWidget {
  const NutritionPrefsScreen({super.key});

  @override
  ConsumerState<NutritionPrefsScreen> createState() =>
      _NutritionPrefsScreenState();
}

class _NutritionPrefsScreenState extends ConsumerState<NutritionPrefsScreen> {
  final _bmrController = TextEditingController();
  final _tdeeController = TextEditingController();
  final _allergyController = TextEditingController();
  bool _loaded = false;

  @override
  void dispose() {
    _bmrController.dispose();
    _tdeeController.dispose();
    _allergyController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final prefsAsync = ref.watch(nutritionPrefsProvider);
    final form = ref.watch(nutritionPrefsFormProvider);

    // Seed form from API once, via ref.listen (runs between frames, not inside build).
    ref.listen<AsyncValue<NutritionPrefs?>>(nutritionPrefsProvider, (_, next) {
      if (_loaded) return;
      next.whenData((prefs) {
        _loaded = true;
        if (prefs != null) {
          ref.read(nutritionPrefsFormProvider.notifier).loadFrom(prefs);
          _bmrController.text = prefs.bmrKcal?.toString() ?? '';
          _tdeeController.text = prefs.tdeeKcal?.toString() ?? '';
        }
      });
    });

    final disabled = !form.enabled;

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        title: '营养偏好',
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.pop(),
        ),
        actions: [
          TextButton(
            onPressed: () => context.push(RoutesV2.nutritionDaily),
            child: const Text(
              '今日建议',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs13,
                color: StrideTokens.accent,
              ),
            ),
          ),
        ],
      ),
      body: prefsAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('加载失败: $e')),
        data: (_) => _buildForm(context, form,
            ref.read(nutritionPrefsFormProvider.notifier), disabled),
      ),
    );
  }

  Widget _buildForm(
    BuildContext context,
    NutritionPrefsForm form,
    NutritionPrefsNotifier notifier,
    bool disabled,
  ) {
    return ListView(
      padding: const EdgeInsets.symmetric(
        horizontal: StrideTokens.spaceLg,
        vertical: StrideTokens.spaceXl,
      ),
      children: [
        // ── Enable toggle ────────────────────────────────────────────────
        _Card(
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const _Label('启用营养建议'),
              Switch(
                value: form.enabled,
                activeThumbColor: StrideTokens.accent,
                onChanged: notifier.setEnabled,
              ),
            ],
          ),
        ),
        const SizedBox(height: StrideTokens.spaceMd),

        // ── Diet type ────────────────────────────────────────────────────
        Opacity(
          opacity: disabled ? 0.4 : 1.0,
          child: IgnorePointer(
            ignoring: disabled,
            child: _Card(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const _Label('饮食类型'),
                  const SizedBox(height: StrideTokens.spaceSm),
                  StrideSegControl(
                    options: const ['无忌口', '素食', '清真', '其他'],
                    selectedIndex: _dietIndex(form.dietType),
                    onChanged: (i) =>
                        notifier.setDietType(_dietValue(i)),
                  ),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(height: StrideTokens.spaceMd),

        // ── Allergies ────────────────────────────────────────────────────
        Opacity(
          opacity: disabled ? 0.4 : 1.0,
          child: IgnorePointer(
            ignoring: disabled,
            child: _Card(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const _Label('过敏食材'),
                  const SizedBox(height: StrideTokens.spaceSm),
                  if (form.allergies.isNotEmpty)
                    Wrap(
                      spacing: StrideTokens.spaceXs,
                      runSpacing: StrideTokens.spaceXs,
                      children: form.allergies
                          .map(
                            (a) => Chip(
                              label: Text(
                                a,
                                style: const TextStyle(
                                  fontFamily: AppTypography.fontSans,
                                  fontSize: StrideTokens.fs12,
                                ),
                              ),
                              deleteIcon: const Icon(Icons.close, size: 14),
                              onDeleted: () => notifier.removeAllergy(a),
                              backgroundColor: StrideTokens.accentFg,
                              side: BorderSide.none,
                              padding: EdgeInsets.zero,
                              visualDensity: VisualDensity.compact,
                            ),
                          )
                          .toList(),
                    ),
                  const SizedBox(height: StrideTokens.spaceSm),
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _allergyController,
                          decoration: const InputDecoration(
                            hintText: '输入过敏食材后按添加',
                            hintStyle: TextStyle(
                              fontFamily: AppTypography.fontSans,
                              fontSize: StrideTokens.fs13,
                              color: StrideTokens.muted,
                            ),
                            isDense: true,
                            contentPadding: EdgeInsets.symmetric(
                                horizontal: 10, vertical: 8),
                            border: OutlineInputBorder(),
                          ),
                          style: const TextStyle(
                            fontFamily: AppTypography.fontSans,
                            fontSize: StrideTokens.fs13,
                          ),
                          onSubmitted: (_) => _addAllergy(form, notifier),
                        ),
                      ),
                      const SizedBox(width: StrideTokens.spaceSm),
                      TextButton(
                        onPressed: form.allergies.length < 20
                            ? () => _addAllergy(form, notifier)
                            : null,
                        child: const Text('添加'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(height: StrideTokens.spaceMd),

        // ── Goal ─────────────────────────────────────────────────────────
        Opacity(
          opacity: disabled ? 0.4 : 1.0,
          child: IgnorePointer(
            ignoring: disabled,
            child: _Card(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const _Label('目标'),
                  const SizedBox(height: StrideTokens.spaceSm),
                  StrideSegControl(
                    options: const ['增肌', '减脂', '维持', '备赛'],
                    selectedIndex: _goalIndex(form.goal),
                    onChanged: (i) => notifier.setGoal(_goalValue(i)),
                  ),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(height: StrideTokens.spaceMd),

        // ── BMR / TDEE ───────────────────────────────────────────────────
        Opacity(
          opacity: disabled ? 0.4 : 1.0,
          child: IgnorePointer(
            ignoring: disabled,
            child: _Card(
              child: Row(
                children: [
                  Expanded(
                    child: _KcalField(
                      label: 'BMR (kcal/天)',
                      controller: _bmrController,
                      onChanged: (v) =>
                          notifier.setBmrKcal(v.isEmpty ? null : int.tryParse(v)),
                    ),
                  ),
                  const SizedBox(width: StrideTokens.spaceMd),
                  Expanded(
                    child: _KcalField(
                      label: 'TDEE (kcal/天)',
                      controller: _tdeeController,
                      onChanged: (v) =>
                          notifier.setTdeeKcal(v.isEmpty ? null : int.tryParse(v)),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(height: StrideTokens.spaceMd),

        // ── Macro sliders ────────────────────────────────────────────────
        Opacity(
          opacity: disabled ? 0.4 : 1.0,
          child: IgnorePointer(
            ignoring: disabled,
            child: _Card(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const _Label('宏量比例（总和 = 100%）'),
                  const SizedBox(height: StrideTokens.spaceSm),
                  _MacroSlider(
                    label: '蛋白质',
                    value: form.macroProteinPct,
                    color: StrideTokens.accent,
                    onChanged: notifier.setProteinPct,
                  ),
                  _MacroSlider(
                    label: '碳水',
                    value: form.macroCarbPct,
                    color: StrideTokens.warn,
                    onChanged: notifier.setCarbPct,
                  ),
                  _MacroSlider(
                    label: '脂肪',
                    value: form.macroFatPct,
                    color: StrideTokens.muted2,
                    onChanged: notifier.setFatPct,
                  ),
                  const SizedBox(height: StrideTokens.spaceXs),
                  Text(
                    '合计 ${(form.macroProteinPct + form.macroCarbPct + form.macroFatPct).toStringAsFixed(1)}%',
                    style: const TextStyle(
                      fontFamily: AppTypography.fontMono,
                      fontSize: StrideTokens.fs12,
                      color: StrideTokens.muted,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(height: StrideTokens.space3xl),

        // ── Save button ──────────────────────────────────────────────────
        _SaveButton(
          submitting: form.submitting,
          onPressed: () => _save(context, ref),
        ),
        const SizedBox(height: StrideTokens.space3xl),
      ],
    );
  }

  void _addAllergy(NutritionPrefsForm form, NutritionPrefsNotifier notifier) {
    final text = _allergyController.text.trim();
    if (text.isEmpty || form.allergies.length >= 20) return;
    notifier.addAllergy(text);
    _allergyController.clear();
  }

  Future<void> _save(BuildContext context, WidgetRef ref) async {
    final notifier = ref.read(nutritionPrefsFormProvider.notifier);
    final ok = await notifier.submit();
    if (!context.mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(ok ? '营养偏好已保存' : '保存失败，请重试'),
        duration: const Duration(seconds: 2),
      ),
    );
  }

  static int _dietIndex(String v) {
    const m = {'none': 0, 'vegetarian': 1, 'halal': 2, 'other': 3};
    return m[v] ?? 0;
  }

  static String _dietValue(int i) {
    const m = ['none', 'vegetarian', 'halal', 'other'];
    return m[i];
  }

  static int _goalIndex(String v) {
    const m = {'bulk': 0, 'cut': 1, 'maintain': 2, 'race': 3};
    return m[v] ?? 2;
  }

  static String _goalValue(int i) {
    const m = ['bulk', 'cut', 'maintain', 'race'];
    return m[i];
  }
}

// ── Sub-widgets ───────────────────────────────────────────────────────────────

class _Card extends StatelessWidget {
  const _Card({required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: child,
    );
  }
}

class _Label extends StatelessWidget {
  const _Label(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: const TextStyle(
        fontFamily: AppTypography.fontSans,
        fontSize: StrideTokens.fs13,
        fontWeight: FontWeight.w500,
        color: StrideTokens.fgSoft,
      ),
    );
  }
}

class _KcalField extends StatelessWidget {
  const _KcalField({
    required this.label,
    required this.controller,
    required this.onChanged,
  });

  final String label;
  final TextEditingController controller;
  final void Function(String) onChanged;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _Label(label),
        const SizedBox(height: StrideTokens.spaceXs),
        TextField(
          controller: controller,
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          decoration: const InputDecoration(
            isDense: true,
            contentPadding:
                EdgeInsets.symmetric(horizontal: 10, vertical: 8),
            border: OutlineInputBorder(),
            hintText: '可选',
            hintStyle: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs13,
              color: StrideTokens.muted,
            ),
          ),
          style: const TextStyle(
            fontFamily: AppTypography.fontMono,
            fontSize: StrideTokens.fs13,
          ),
          onChanged: onChanged,
        ),
      ],
    );
  }
}

class _MacroSlider extends StatelessWidget {
  const _MacroSlider({
    required this.label,
    required this.value,
    required this.color,
    required this.onChanged,
  });

  final String label;
  final double value;
  final Color color;
  final void Function(double) onChanged;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          SizedBox(
            width: 48,
            child: Text(
              label,
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs12,
                color: StrideTokens.muted,
              ),
            ),
          ),
          Expanded(
            child: SliderTheme(
              data: SliderThemeData(
                activeTrackColor: color,
                thumbColor: color,
                inactiveTrackColor: StrideTokens.border,
                overlayColor: color.withAlpha(30),
                trackHeight: 3,
                thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 7),
              ),
              child: Slider(
                value: value.clamp(0.0, 100.0),
                min: 0,
                max: 100,
                onChanged: onChanged,
              ),
            ),
          ),
          SizedBox(
            width: 40,
            child: Text(
              '${value.toStringAsFixed(1)}%',
              textAlign: TextAlign.right,
              style: const TextStyle(
                fontFamily: AppTypography.fontMono,
                fontSize: StrideTokens.fs12,
                color: StrideTokens.fg,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _SaveButton extends StatelessWidget {
  const _SaveButton({required this.submitting, required this.onPressed});

  final bool submitting;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 48,
      child: ElevatedButton(
        onPressed: submitting ? null : onPressed,
        style: ElevatedButton.styleFrom(
          backgroundColor: StrideTokens.accent,
          foregroundColor: StrideTokens.surface,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
          ),
        ),
        child: submitting
            ? const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: StrideTokens.surface,
                ),
              )
            : const Text(
                '保存',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs15,
                  fontWeight: FontWeight.w600,
                ),
              ),
      ),
    );
  }
}
