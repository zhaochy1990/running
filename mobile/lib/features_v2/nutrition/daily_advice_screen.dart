/// F2 — 每日营养建议 (Daily Nutrition Advice screen).
///
/// US-005: GET /api/{user}/nutrition/daily?date=YYYY-MM-DD
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/router/routes_v2.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/pill_colors.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/pill.dart';
import '../_shared/widgets/stat_row.dart';
import '../_shared/widgets/top_bar.dart';
import 'models/daily_advice.dart';
import 'providers/daily_advice_provider.dart';

class DailyAdviceScreen extends ConsumerStatefulWidget {
  const DailyAdviceScreen({super.key});

  @override
  ConsumerState<DailyAdviceScreen> createState() => _DailyAdviceScreenState();
}

class _DailyAdviceScreenState extends ConsumerState<DailyAdviceScreen> {
  DateTime _selectedDate = DateTime.now();

  String get _dateKey => _formatIso(_selectedDate);

  @override
  Widget build(BuildContext context) {
    final adviceAsync = ref.watch(dailyAdviceProvider(_dateKey));

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        title: '每日营养建议',
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.pop(),
        ),
      ),
      body: Column(
        children: [
          _DatePickerBar(
            selectedDate: _selectedDate,
            onDateChanged: (d) => setState(() => _selectedDate = d),
          ),
          Expanded(
            child: adviceAsync.when(
              loading: () =>
                  const Center(child: CircularProgressIndicator()),
              error: (e, _) =>
                  Center(child: Text('加载失败: $e')),
              data: (advice) {
                if (advice == null) {
                  return _NoPrefsPlaceholder(
                    onSetupTap: () => context.push(RoutesV2.nutritionPrefs),
                  );
                }
                return _AdviceBody(advice: advice);
              },
            ),
          ),
        ],
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            StrideTokens.spaceLg,
            0,
            StrideTokens.spaceLg,
            StrideTokens.spaceMd,
          ),
          child: TextButton(
            onPressed: () => context.push(RoutesV2.nutritionMeals),
            child: const Text(
              '记录今日餐食 →',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs14,
                color: StrideTokens.accent,
              ),
            ),
          ),
        ),
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
                lastDate: DateTime.now().add(const Duration(days: 30)),
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

// ── Advice body ───────────────────────────────────────────────────────────────

class _AdviceBody extends StatelessWidget {
  const _AdviceBody({required this.advice});

  final DailyAdvice advice; // DailyAdvice

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      children: [
        // Hero card
        _HeroCard(advice: advice),
        const SizedBox(height: StrideTokens.spaceMd),

        // Macros row
        _MacrosCard(advice: advice),
        const SizedBox(height: StrideTokens.spaceMd),

        // Advice cards
        if (advice.advice.pre != null && advice.advice.pre!.isNotEmpty)
          _AdviceCard(title: '训前', content: advice.advice.pre!),
        if (advice.advice.intra != null && advice.advice.intra!.isNotEmpty) ...[
          const SizedBox(height: StrideTokens.spaceSm),
          _AdviceCard(title: '训中', content: advice.advice.intra!),
        ],
        if (advice.advice.post != null && advice.advice.post!.isNotEmpty) ...[
          const SizedBox(height: StrideTokens.spaceSm),
          _AdviceCard(title: '训后', content: advice.advice.post!),
        ],
        const SizedBox(height: StrideTokens.space3xl),
      ],
    );
  }
}

class _HeroCard extends StatelessWidget {
  const _HeroCard({required this.advice});

  final DailyAdvice advice;

  @override
  Widget build(BuildContext context) {
    final isTraining = advice.isTrainingDay as bool;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(StrideTokens.spaceXl),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Text(
                '目标热量',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs13,
                  color: StrideTokens.muted,
                ),
              ),
              const SizedBox(width: StrideTokens.spaceSm),
              StridePill(
                text: isTraining ? '训练日' : '休息日',
                variant:
                    isTraining ? PillVariant.warn : PillVariant.muted,
              ),
            ],
          ),
          const SizedBox(height: StrideTokens.spaceXs),
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Text(
                '${advice.targetKcal}',
                style: const TextStyle(
                  fontFamily: AppTypography.fontMono,
                  fontSize: StrideTokens.fsDisplay40,
                  fontWeight: FontWeight.w700,
                  color: StrideTokens.fg,
                  height: 1.0,
                ),
              ),
              const SizedBox(width: 4),
              const Text(
                'kcal',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs15,
                  color: StrideTokens.muted,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _MacrosCard extends StatelessWidget {
  const _MacrosCard({required this.advice});

  final DailyAdvice advice;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: StrideStatRow(
        items: [
          StatItem(
            label: '蛋白质',
            value: advice.macros.proteinG.toStringAsFixed(1),
            unit: 'g',
          ),
          StatItem(
            label: '碳水',
            value: advice.macros.carbG.toStringAsFixed(1),
            unit: 'g',
          ),
          StatItem(
            label: '脂肪',
            value: advice.macros.fatG.toStringAsFixed(1),
            unit: 'g',
          ),
        ],
      ),
    );
  }
}

class _AdviceCard extends StatelessWidget {
  const _AdviceCard({required this.title, required this.content});

  final String title;
  final String content;

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
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: const TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs13,
              fontWeight: FontWeight.w600,
              color: StrideTokens.fgSoft,
            ),
          ),
          const SizedBox(height: StrideTokens.spaceXs),
          Text(
            content,
            style: const TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs14,
              color: StrideTokens.fg,
              height: 1.5,
            ),
          ),
        ],
      ),
    );
  }
}

// ── No prefs placeholder ──────────────────────────────────────────────────────

class _NoPrefsPlaceholder extends StatelessWidget {
  const _NoPrefsPlaceholder({required this.onSetupTap});

  final VoidCallback onSetupTap;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(StrideTokens.space3xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.restaurant_outlined,
                size: 48, color: StrideTokens.muted),
            const SizedBox(height: StrideTokens.spaceLg),
            const Text(
              '请先设置营养偏好',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs15,
                color: StrideTokens.fgSoft,
              ),
            ),
            const SizedBox(height: StrideTokens.spaceSm),
            const Text(
              '完成营养偏好配置后，系统将为你生成每日营养目标和饮食建议。',
              textAlign: TextAlign.center,
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs13,
                color: StrideTokens.muted,
                height: 1.5,
              ),
            ),
            const SizedBox(height: StrideTokens.spaceXl),
            ElevatedButton(
              onPressed: onSetupTap,
              style: ElevatedButton.styleFrom(
                backgroundColor: StrideTokens.accent,
                foregroundColor: StrideTokens.surface,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
                ),
              ),
              child: const Text(
                '去设置营养偏好',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs14,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
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
