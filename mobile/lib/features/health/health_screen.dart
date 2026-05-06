import 'package:flutter/material.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/app_typography.dart';

class HealthScreen extends StatelessWidget {
  const HealthScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(title: const Text('体能')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Row(
            children: [
              Expanded(
                child: _MetricCard(
                  label: '疲劳度',
                  value: '38',
                  hint: '已恢复',
                  hintColor: AppColors.success,
                ),
              ),
              SizedBox(width: 12),
              Expanded(
                child: _MetricCard(
                  label: 'TSB',
                  value: '+12',
                  hint: '比赛就绪',
                  hintColor: AppColors.accent,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          const Row(
            children: [
              Expanded(
                child: _MetricCard(
                  label: 'RHR',
                  value: '52',
                  hint: 'baseline 53',
                  hintColor: AppColors.foregroundMuted,
                ),
              ),
              SizedBox(width: 12),
              Expanded(
                child: _MetricCard(
                  label: 'HRV',
                  value: '64',
                  hint: '正常区间',
                  hintColor: AppColors.foregroundMuted,
                ),
              ),
            ],
          ),
          const SizedBox(height: 24),
          Text('训练负荷趋势', style: theme.textTheme.titleLarge),
          const SizedBox(height: 12),
          Container(
            height: 200,
            decoration: BoxDecoration(
              color: AppColors.surface,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: AppColors.border),
            ),
            child: Center(
              child: Text(
                'PMC 图表占位 — fl_chart 实装在 S8',
                style: theme.textTheme.bodySmall,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _MetricCard extends StatelessWidget {
  const _MetricCard({
    required this.label,
    required this.value,
    required this.hint,
    required this.hintColor,
  });

  final String label;
  final String value;
  final String hint;
  final Color hintColor;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: theme.textTheme.titleSmall),
            const SizedBox(height: 8),
            Text(value, style: AppTypography.monoHeadline),
            const SizedBox(height: 4),
            Text(
              hint,
              style: theme.textTheme.bodySmall?.copyWith(color: hintColor),
            ),
          ],
        ),
      ),
    );
  }
}
