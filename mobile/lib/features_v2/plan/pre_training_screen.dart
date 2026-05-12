/// D6 — 训练前屏幕 (PreTrainingScreen).
///
/// 路由：/v2/plan/:date/:sessionIndex/pre
/// 参数：path `date` (YYYY-MM-DD) + `sessionIndex` (int)
///
/// 内容：
///   1. StrideTopBar：返回 + "训练前准备" 标题
///   2. 课时摘要卡：课名 + 强度 pill + stat-row（距离/时长/配速区间）+ 心率区间
///   3. 热身清单：可勾选条目（本地状态，不持久化）
///   4. 训前营养卡：文字提示
///   5. "启动训练" 底部按钮 → SnackBar 提示
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/app_typography.dart';
import '../../core/theme/pill_colors.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/pill.dart';
import '../_shared/widgets/stat_row.dart';
import '../_shared/widgets/top_bar.dart';
import 'models/day_plan.dart';
import 'providers/plan_day_provider.dart';

// ── Default content when API fields are absent ────────────────────────────

const List<String> _defaultWarmup = [
  '慢跑 5 分钟',
  '动态拉伸 5 分钟',
  '高抬腿 + 后踢腿各 20 个',
];

const String _defaultNutritionPre =
    '训前 1-2 小时补充适量碳水（如 1 根香蕉 + 半杯黑咖啡），'
    '训前 30 分钟避免高蛋白高脂。';

// ── Screen ────────────────────────────────────────────────────────────────

class PreTrainingScreen extends ConsumerWidget {
  const PreTrainingScreen({
    super.key,
    required this.date,
    required this.sessionIndex,
  });

  final String date;
  final int sessionIndex;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(
      planDayProvider((date: date, sessionIndex: sessionIndex)),
    );

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        title: '训练前准备',
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => Navigator.of(context).pop(),
        ),
      ),
      body: async.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => const Center(
          child: Text(
            '加载失败',
            style: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs15,
              color: StrideTokens.danger,
            ),
          ),
        ),
        data: (plan) => _Body(plan: plan),
      ),
    );
  }
}

// ── Body (stateful for checkbox state) ───────────────────────────────────

class _Body extends StatefulWidget {
  const _Body({required this.plan});

  final DayPlan plan;

  @override
  State<_Body> createState() => _BodyState();
}

class _BodyState extends State<_Body> {
  late List<bool> _checked;

  @override
  void initState() {
    super.initState();
    final items = widget.plan.warmupBlocks ?? _defaultWarmup;
    _checked = List.filled(items.length, false);
  }

  void _toggle(int i) => setState(() => _checked[i] = !_checked[i]);

  void _onStart() {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('请在手表上启动训练')),
    );
  }

  @override
  Widget build(BuildContext context) {
    final plan = widget.plan;
    final warmup = plan.warmupBlocks ?? _defaultWarmup;
    final nutritionText = (plan.nutritionPre?.isNotEmpty == true)
        ? plan.nutritionPre!
        : _defaultNutritionPre;

    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.all(StrideTokens.spaceLg),
            children: [
              _SessionSummaryCard(plan: plan),
              const SizedBox(height: StrideTokens.spaceLg),
              const _SectionTitle(title: '热身'),
              const SizedBox(height: StrideTokens.spaceSm),
              _WarmupChecklist(
                items: warmup,
                checked: _checked,
                onToggle: _toggle,
              ),
              const SizedBox(height: StrideTokens.spaceLg),
              const _SectionTitle(title: '训前营养'),
              const SizedBox(height: StrideTokens.spaceSm),
              _NutritionCard(text: nutritionText),
              // Extra bottom padding so the last card isn't hidden behind button
              const SizedBox(height: 80),
            ],
          ),
        ),
        _StartButton(onPressed: _onStart),
      ],
    );
  }
}

// ── Session summary card ──────────────────────────────────────────────────

class _SessionSummaryCard extends StatelessWidget {
  const _SessionSummaryCard({required this.plan});

  final DayPlan plan;

  @override
  Widget build(BuildContext context) {
    final distanceStr = plan.distanceM != null
        ? (plan.distanceM! / 1000).toStringAsFixed(1)
        : '—';
    final durationStr = plan.durationSec != null
        ? _fmtMinutes(plan.durationSec!.toInt())
        : '—';
    final paceStr = _fmtPaceRange(
      plan.targetPaceLowSecPerKm,
      plan.targetPaceHighSecPerKm,
    );

    return Container(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Course name + intensity pill
          Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Expanded(
                child: Text(
                  plan.name,
                  style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs18,
                    fontWeight: FontWeight.w700,
                    color: StrideTokens.fg,
                    height: 1.2,
                  ),
                ),
              ),
              const SizedBox(width: StrideTokens.spaceSm),
              StridePill(
                text: plan.kind.toUpperCase(),
                variant: _kindToPillVariant(plan.kind),
              ),
            ],
          ),
          const SizedBox(height: StrideTokens.spaceMd),
          // Primary stats: distance / duration / pace range
          StrideStatRow(
            items: [
              StatItem(label: '距离', value: distanceStr, unit: 'km'),
              StatItem(label: '时长', value: durationStr, unit: 'min'),
              StatItem(label: '配速区间', value: paceStr, unit: 'min/km'),
            ],
          ),
          // HR range row (only shown when at least one bound is non-null)
          if (plan.targetHrLow != null || plan.targetHrHigh != null) ...[
            const SizedBox(height: StrideTokens.spaceMd),
            _HrRow(low: plan.targetHrLow, high: plan.targetHrHigh),
          ],
        ],
      ),
    );
  }

  static String _fmtMinutes(int totalSec) {
    final m = totalSec ~/ 60;
    return '$m';
  }

  static String _fmtPaceRange(int? low, int? high) {
    if (low == null && high == null) return '—';
    final lo = low != null ? _secToMmss(low) : '?';
    final hi = high != null ? _secToMmss(high) : '?';
    return '$lo–$hi';
  }

  static String _secToMmss(int sec) {
    final m = sec ~/ 60;
    final s = sec % 60;
    return "$m:${s.toString().padLeft(2, '0')}";
  }

  static PillVariant _kindToPillVariant(String kind) {
    return switch (kind.toUpperCase()) {
      'E' => PillVariant.green,
      'REST' => PillVariant.muted,
      'R' => PillVariant.danger,
      _ => PillVariant.warn, // M / T / I
    };
  }
}

// ── HR range row ──────────────────────────────────────────────────────────

class _HrRow extends StatelessWidget {
  const _HrRow({this.low, this.high});

  final int? low;
  final int? high;

  @override
  Widget build(BuildContext context) {
    final hrStr = switch ((low, high)) {
      (final int l, final int h) => '$l–$h',
      (final int l, null) => '>$l',
      (null, final int h) => '<$h',
      _ => '—',
    };

    return Row(
      children: [
        const Icon(
          Icons.favorite_border,
          size: 14,
          color: StrideTokens.muted,
        ),
        const SizedBox(width: StrideTokens.spaceXs),
        Text(
          '心率区间  $hrStr bpm',
          style: const TextStyle(
            fontFamily: AppTypography.fontMono,
            fontSize: StrideTokens.fs13,
            color: StrideTokens.fgSoft,
          ),
        ),
      ],
    );
  }
}

// ── Section title ─────────────────────────────────────────────────────────

class _SectionTitle extends StatelessWidget {
  const _SectionTitle({required this.title});

  final String title;

  @override
  Widget build(BuildContext context) {
    return Text(
      title,
      style: const TextStyle(
        fontFamily: AppTypography.fontSans,
        fontSize: StrideTokens.fs13,
        fontWeight: FontWeight.w600,
        color: StrideTokens.muted,
        letterSpacing: 0.5,
      ),
    );
  }
}

// ── Warmup checklist ──────────────────────────────────────────────────────

class _WarmupChecklist extends StatelessWidget {
  const _WarmupChecklist({
    required this.items,
    required this.checked,
    required this.onToggle,
  });

  final List<String> items;
  final List<bool> checked;
  final ValueChanged<int> onToggle;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Column(
        children: [
          for (int i = 0; i < items.length; i++)
            _ChecklistItem(
              label: items[i],
              checked: checked[i],
              onTap: () => onToggle(i),
              showDivider: i < items.length - 1,
            ),
        ],
      ),
    );
  }
}

class _ChecklistItem extends StatelessWidget {
  const _ChecklistItem({
    required this.label,
    required this.checked,
    required this.onTap,
    required this.showDivider,
  });

  final String label;
  final bool checked;
  final VoidCallback onTap;
  final bool showDivider;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: StrideTokens.spaceLg,
              vertical: StrideTokens.spaceMd,
            ),
            child: Row(
              children: [
                AnimatedContainer(
                  duration: const Duration(milliseconds: 150),
                  width: 20,
                  height: 20,
                  decoration: BoxDecoration(
                    color: checked ? StrideTokens.accent : StrideTokens.surface,
                    borderRadius: BorderRadius.circular(4),
                    border: Border.all(
                      color: checked
                          ? StrideTokens.accent
                          : StrideTokens.border,
                      width: 1.5,
                    ),
                  ),
                  child: checked
                      ? const Icon(
                          Icons.check,
                          size: 14,
                          color: StrideTokens.surface,
                        )
                      : null,
                ),
                const SizedBox(width: StrideTokens.spaceMd),
                Expanded(
                  child: Text(
                    label,
                    style: TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs14,
                      color: checked
                          ? StrideTokens.muted
                          : StrideTokens.fg,
                      decoration: checked
                          ? TextDecoration.lineThrough
                          : TextDecoration.none,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        if (showDivider)
          const Divider(
            height: 1,
            indent: StrideTokens.spaceLg,
            endIndent: StrideTokens.spaceLg,
            color: StrideTokens.border2,
          ),
      ],
    );
  }
}

// ── Nutrition card ────────────────────────────────────────────────────────

class _NutritionCard extends StatelessWidget {
  const _NutritionCard({required this.text});

  final String text;

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
      child: Text(
        text,
        style: const TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: StrideTokens.fs14,
          color: StrideTokens.fgSoft,
          height: 1.6,
        ),
      ),
    );
  }
}

// ── Start button ──────────────────────────────────────────────────────────

class _StartButton extends StatelessWidget {
  const _StartButton({required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(
        StrideTokens.spaceLg,
        StrideTokens.spaceMd,
        StrideTokens.spaceLg,
        StrideTokens.space2xl,
      ),
      decoration: const BoxDecoration(
        color: StrideTokens.surface,
        border: Border(top: BorderSide(color: StrideTokens.border2)),
      ),
      child: FilledButton(
        onPressed: onPressed,
        style: FilledButton.styleFrom(
          backgroundColor: StrideTokens.accent,
          foregroundColor: StrideTokens.surface,
          minimumSize: const Size.fromHeight(48),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
          ),
          textStyle: const TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs15,
            fontWeight: FontWeight.w600,
          ),
        ),
        child: const Text('启动训练'),
      ),
    );
  }
}
