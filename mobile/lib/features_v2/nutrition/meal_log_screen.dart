/// F3 — 营养记录 (Meal Log screen).
///
/// US-006: GET/POST /api/{user}/nutrition/meals
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/current_user.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../../data/api/stride_api.dart';
import '../_shared/widgets/seg_control.dart';
import '../_shared/widgets/stat_row.dart';
import '../_shared/widgets/top_bar.dart';
import 'models/meals_daily.dart';
import 'providers/meals_provider.dart';

class MealLogScreen extends ConsumerStatefulWidget {
  const MealLogScreen({super.key});

  @override
  ConsumerState<MealLogScreen> createState() => _MealLogScreenState();
}

class _MealLogScreenState extends ConsumerState<MealLogScreen> {
  DateTime _selectedDate = DateTime.now();

  String get _dateKey => _formatIso(_selectedDate);

  @override
  Widget build(BuildContext context) {
    final mealsAsync = ref.watch(mealsDailyProvider(_dateKey));

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        title: '营养记录',
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.pop(),
        ),
      ),
      floatingActionButton: FloatingActionButton(
        backgroundColor: StrideTokens.accent,
        foregroundColor: StrideTokens.surface,
        onPressed: () => _showAddSheet(context),
        child: const Icon(Icons.add),
      ),
      body: Column(
        children: [
          _DatePickerBar(
            selectedDate: _selectedDate,
            onDateChanged: (d) => setState(() => _selectedDate = d),
          ),
          Expanded(
            child: mealsAsync.when(
              loading: () =>
                  const Center(child: CircularProgressIndicator()),
              error: (e, _) =>
                  Center(child: Text('加载失败: $e')),
              data: (data) => _MealBody(mealsDaily: data),
            ),
          ),
        ],
      ),
    );
  }

  void _showAddSheet(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: StrideTokens.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(
            top: Radius.circular(StrideTokens.radiusLg)),
      ),
      builder: (_) => _AddMealSheet(
        dateKey: _dateKey,
        onSubmitted: () => ref.invalidate(mealsDailyProvider(_dateKey)),
      ),
    );
  }
}

// ── Date picker bar ───────────────────────────────────────────────────────────

class _DatePickerBar extends StatelessWidget {
  const _DatePickerBar({
    required this.selectedDate,
    required this.onDateChanged,
  });

  final DateTime selectedDate;
  final void Function(DateTime) onDateChanged;

  @override
  Widget build(BuildContext context) {
    final label = _formatDisplay(selectedDate);
    return Container(
      color: StrideTokens.surface,
      padding: const EdgeInsets.symmetric(
        horizontal: StrideTokens.spaceLg,
        vertical: StrideTokens.spaceSm,
      ),
      child: Row(
        children: [
          const Icon(Icons.calendar_today_outlined,
              size: 16, color: StrideTokens.muted),
          const SizedBox(width: StrideTokens.spaceSm),
          Text(
            label,
            style: const TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs14,
              color: StrideTokens.fg,
            ),
          ),
          const Spacer(),
          TextButton(
            onPressed: () async {
              final picked = await showDatePicker(
                context: context,
                initialDate: selectedDate,
                firstDate: DateTime(2024),
                lastDate: DateTime.now().add(const Duration(days: 1)),
              );
              if (picked != null) onDateChanged(picked);
            },
            child: const Text(
              '切换日期',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs13,
                color: StrideTokens.accent,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ── Meal body ─────────────────────────────────────────────────────────────────

class _MealBody extends StatelessWidget {
  const _MealBody({required this.mealsDaily});

  final MealsDaily? mealsDaily;

  static const _mealTypes = ['breakfast', 'lunch', 'dinner', 'snack'];
  static const _mealLabels = ['早餐', '午餐', '晚餐', '加餐'];

  @override
  Widget build(BuildContext context) {
    final meals = mealsDaily?.meals ?? [];
    final totals = mealsDaily?.dailyTotals ?? MealTotals.zero;

    return ListView(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      children: [
        for (int i = 0; i < _mealTypes.length; i++) ...[
          _MealTypeCard(
            mealType: _mealTypes[i],
            label: _mealLabels[i],
            meals: meals.where((m) => m.mealType == _mealTypes[i]).toList(),
          ),
          const SizedBox(height: StrideTokens.spaceMd),
        ],
        // Daily totals
        Container(
          padding: const EdgeInsets.all(StrideTokens.spaceLg),
          decoration: BoxDecoration(
            color: StrideTokens.surface,
            borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
            border: Border.all(color: StrideTokens.border2),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                '日合计',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs13,
                  fontWeight: FontWeight.w600,
                  color: StrideTokens.fgSoft,
                ),
              ),
              const SizedBox(height: StrideTokens.spaceSm),
              StrideStatRow(
                items: [
                  StatItem(
                    label: '总热量',
                    value: totals.kcal.toStringAsFixed(0),
                    unit: 'kcal',
                  ),
                  StatItem(
                    label: '蛋白质',
                    value: totals.proteinG.toStringAsFixed(1),
                    unit: 'g',
                  ),
                  StatItem(
                    label: '碳水',
                    value: totals.carbG.toStringAsFixed(1),
                    unit: 'g',
                  ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: StrideTokens.space3xl),
      ],
    );
  }
}

class _MealTypeCard extends StatelessWidget {
  const _MealTypeCard({
    required this.mealType,
    required this.label,
    required this.meals,
  });

  final String mealType;
  final String label;
  final List<Meal> meals;

  @override
  Widget build(BuildContext context) {
    final allItems = meals.expand((m) => m.items).toList();
    final totalKcal = allItems.fold<double>(0, (s, i) => s + i.kcal);

    return Container(
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(
              StrideTokens.spaceLg,
              StrideTokens.spaceMd,
              StrideTokens.spaceLg,
              StrideTokens.spaceXs,
            ),
            child: Row(
              children: [
                Text(
                  label,
                  style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs14,
                    fontWeight: FontWeight.w600,
                    color: StrideTokens.fg,
                  ),
                ),
                const Spacer(),
                if (totalKcal > 0)
                  Text(
                    '${totalKcal.toStringAsFixed(0)} kcal',
                    style: const TextStyle(
                      fontFamily: AppTypography.fontMono,
                      fontSize: StrideTokens.fs12,
                      color: StrideTokens.muted,
                    ),
                  ),
              ],
            ),
          ),
          if (allItems.isEmpty)
            const Padding(
              padding: EdgeInsets.fromLTRB(
                StrideTokens.spaceLg,
                StrideTokens.spaceXs,
                StrideTokens.spaceLg,
                StrideTokens.spaceMd,
              ),
              child: Text(
                '暂无记录',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs13,
                  color: StrideTokens.muted,
                ),
              ),
            )
          else
            ...allItems.map(
              (item) => Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: StrideTokens.spaceLg,
                  vertical: StrideTokens.spaceXs,
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        item.name,
                        style: const TextStyle(
                          fontFamily: AppTypography.fontSans,
                          fontSize: StrideTokens.fs13,
                          color: StrideTokens.fg,
                        ),
                      ),
                    ),
                    Text(
                      '${item.kcal.toStringAsFixed(0)} kcal',
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
          const SizedBox(height: StrideTokens.spaceXs),
        ],
      ),
    );
  }
}

// ── Add meal bottom sheet ─────────────────────────────────────────────────────

class _AddMealSheet extends ConsumerStatefulWidget {
  const _AddMealSheet({
    required this.dateKey,
    required this.onSubmitted,
  });

  final String dateKey;
  final VoidCallback onSubmitted;

  @override
  ConsumerState<_AddMealSheet> createState() => _AddMealSheetState();
}

class _AddMealSheetState extends ConsumerState<_AddMealSheet> {
  int _mealTypeIndex = 0;
  final List<_ItemRow> _rows = [_ItemRow()];
  final _notesController = TextEditingController();
  bool _submitting = false;

  static const _mealTypes = ['breakfast', 'lunch', 'dinner', 'snack'];

  @override
  void dispose() {
    _notesController.dispose();
    for (final r in _rows) {
      r.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom,
      ),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(
          StrideTokens.spaceLg,
          StrideTokens.spaceLg,
          StrideTokens.spaceLg,
          StrideTokens.space3xl,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text(
              '添加餐食',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs18,
                fontWeight: FontWeight.w700,
                color: StrideTokens.fg,
              ),
            ),
            const SizedBox(height: StrideTokens.spaceLg),
            const Text(
              '餐次',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs13,
                color: StrideTokens.muted,
              ),
            ),
            const SizedBox(height: StrideTokens.spaceXs),
            StrideSegControl(
              options: const ['早餐', '午餐', '晚餐', '加餐'],
              selectedIndex: _mealTypeIndex,
              onChanged: (i) => setState(() => _mealTypeIndex = i),
            ),
            const SizedBox(height: StrideTokens.spaceLg),
            const Text(
              '食物条目',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs13,
                color: StrideTokens.muted,
              ),
            ),
            const SizedBox(height: StrideTokens.spaceXs),
            // Column headers
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 4),
              child: Row(
                children: [
                  Expanded(
                    flex: 3,
                    child: Text('名称',
                        style: TextStyle(
                            fontFamily: AppTypography.fontSans,
                            fontSize: StrideTokens.fs11,
                            color: StrideTokens.muted)),
                  ),
                  SizedBox(width: 4),
                  Expanded(
                    child: Text('kcal',
                        style: TextStyle(
                            fontFamily: AppTypography.fontSans,
                            fontSize: StrideTokens.fs11,
                            color: StrideTokens.muted)),
                  ),
                  SizedBox(width: 4),
                  Expanded(
                    child: Text('蛋白g',
                        style: TextStyle(
                            fontFamily: AppTypography.fontSans,
                            fontSize: StrideTokens.fs11,
                            color: StrideTokens.muted)),
                  ),
                  SizedBox(width: 4),
                  Expanded(
                    child: Text('碳水g',
                        style: TextStyle(
                            fontFamily: AppTypography.fontSans,
                            fontSize: StrideTokens.fs11,
                            color: StrideTokens.muted)),
                  ),
                  SizedBox(width: 4),
                  Expanded(
                    child: Text('脂肪g',
                        style: TextStyle(
                            fontFamily: AppTypography.fontSans,
                            fontSize: StrideTokens.fs11,
                            color: StrideTokens.muted)),
                  ),
                  SizedBox(width: 28),
                ],
              ),
            ),
            ..._rows.asMap().entries.map(
                  (e) => _ItemRowWidget(
                    key: ValueKey(e.key),
                    row: e.value,
                    showDelete: _rows.length > 1,
                    onDelete: () => setState(() => _rows.removeAt(e.key)),
                  ),
                ),
            TextButton.icon(
              onPressed: () => setState(() => _rows.add(_ItemRow())),
              icon: const Icon(Icons.add, size: 16),
              label: const Text(
                '添加一行',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs13,
                ),
              ),
            ),
            const SizedBox(height: StrideTokens.spaceSm),
            TextField(
              controller: _notesController,
              decoration: const InputDecoration(
                labelText: '备注（可选）',
                isDense: true,
                contentPadding:
                    EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                border: OutlineInputBorder(),
              ),
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs13,
              ),
            ),
            const SizedBox(height: StrideTokens.spaceLg),
            SizedBox(
              width: double.infinity,
              height: 48,
              child: ElevatedButton(
                onPressed: _submitting ? null : _submit,
                style: ElevatedButton.styleFrom(
                  backgroundColor: StrideTokens.accent,
                  foregroundColor: StrideTokens.surface,
                  shape: RoundedRectangleBorder(
                    borderRadius:
                        BorderRadius.circular(StrideTokens.radiusMd),
                  ),
                ),
                child: _submitting
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: StrideTokens.surface,
                        ),
                      )
                    : const Text(
                        '提交',
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
    );
  }

  Future<void> _submit() async {
    final validRows = _rows
        .where((r) => r.nameController.text.trim().isNotEmpty)
        .toList();
    if (validRows.isEmpty) return;

    setState(() => _submitting = true);

    final userId = ref.read(currentUserIdProvider);
    if (userId == null) {
      setState(() => _submitting = false);
      return;
    }

    final items = validRows.map((r) {
      return <String, dynamic>{
        'name': r.nameController.text.trim(),
        'kcal': double.tryParse(r.kcalController.text) ?? 0.0,
        'protein_g': double.tryParse(r.proteinController.text) ?? 0.0,
        'carb_g': double.tryParse(r.carbController.text) ?? 0.0,
        'fat_g': double.tryParse(r.fatController.text) ?? 0.0,
      };
    }).toList();

    final body = <String, dynamic>{
      'date': widget.dateKey,
      'meal_type': _mealTypes[_mealTypeIndex],
      'items': items,
      if (_notesController.text.trim().isNotEmpty)
        'notes': _notesController.text.trim(),
    };

    try {
      await ref.read(strideApiProvider).postMeal(userId, body);
      if (mounted) {
        widget.onSubmitted();
        Navigator.of(context).pop();
      }
    } catch (e) {
      if (mounted) {
        setState(() => _submitting = false);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('提交失败: $e')),
        );
      }
    }
  }
}

// ── Item row model ────────────────────────────────────────────────────────────

class _ItemRow {
  final nameController = TextEditingController();
  final kcalController = TextEditingController();
  final proteinController = TextEditingController();
  final carbController = TextEditingController();
  final fatController = TextEditingController();

  void dispose() {
    nameController.dispose();
    kcalController.dispose();
    proteinController.dispose();
    carbController.dispose();
    fatController.dispose();
  }
}

class _ItemRowWidget extends StatelessWidget {
  const _ItemRowWidget({
    super.key,
    required this.row,
    required this.showDelete,
    required this.onDelete,
  });

  final _ItemRow row;
  final bool showDelete;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Expanded(
            flex: 3,
            child: _InputField(controller: row.nameController, isText: true),
          ),
          const SizedBox(width: 4),
          Expanded(child: _InputField(controller: row.kcalController)),
          const SizedBox(width: 4),
          Expanded(child: _InputField(controller: row.proteinController)),
          const SizedBox(width: 4),
          Expanded(child: _InputField(controller: row.carbController)),
          const SizedBox(width: 4),
          Expanded(child: _InputField(controller: row.fatController)),
          SizedBox(
            width: 28,
            child: showDelete
                ? IconButton(
                    padding: EdgeInsets.zero,
                    icon: const Icon(Icons.remove_circle_outline,
                        size: 16, color: StrideTokens.muted),
                    onPressed: onDelete,
                  )
                : null,
          ),
        ],
      ),
    );
  }
}

class _InputField extends StatelessWidget {
  const _InputField({required this.controller, this.isText = false});

  final TextEditingController controller;
  final bool isText;

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      keyboardType: isText
          ? TextInputType.text
          : const TextInputType.numberWithOptions(decimal: true),
      inputFormatters: isText
          ? []
          : [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
      decoration: const InputDecoration(
        isDense: true,
        contentPadding:
            EdgeInsets.symmetric(horizontal: 6, vertical: 6),
        border: OutlineInputBorder(),
      ),
      style: TextStyle(
        fontFamily:
            isText ? AppTypography.fontSans : AppTypography.fontMono,
        fontSize: StrideTokens.fs12,
      ),
    );
  }
}

// ── Date helpers ──────────────────────────────────────────────────────────────

String _formatIso(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-'
    '${d.month.toString().padLeft(2, '0')}-'
    '${d.day.toString().padLeft(2, '0')}';

String _formatDisplay(DateTime d) => '${d.year}年${d.month}月${d.day}日';
