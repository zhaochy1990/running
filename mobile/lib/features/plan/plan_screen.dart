import 'package:flutter/material.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/app_typography.dart';

class PlanScreen extends StatelessWidget {
  const PlanScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    final sessions = [
      ('轻松跑', '8 km', '5:50/km'),
      ('有氧', '10 km', '5:30/km'),
      ('间歇', '6×800m', 'Z4'),
      ('恢复', '5 km', '6:10/km'),
      ('力量', '45 min', '核心+下肢'),
      ('长距离', '20 km', '5:40/km'),
      ('休息', '—', '—'),
    ];

    return Scaffold(
      appBar: AppBar(title: const Text('本周计划')),
      body: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: days.length,
        itemBuilder: (_, i) {
          final s = sessions[i];
          return Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Row(
                  children: [
                    SizedBox(
                      width: 36,
                      child: Text(days[i], style: theme.textTheme.titleSmall),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(s.$1, style: theme.textTheme.titleMedium),
                          const SizedBox(height: 4),
                          Text('${s.$2} · ${s.$3}', style: AppTypography.monoCaption),
                        ],
                      ),
                    ),
                    const Icon(Icons.send_outlined, color: AppColors.foregroundMuted, size: 18),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}
