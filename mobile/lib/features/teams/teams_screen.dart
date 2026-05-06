import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/app_typography.dart';

class TeamsScreen extends StatelessWidget {
  const TeamsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(title: const Text('战队')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: ListTile(
              contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              leading: const CircleAvatar(
                backgroundColor: AppColors.accent,
                child: Icon(Icons.directions_run, color: AppColors.foreground),
              ),
              title: Text('STRIDE 朋友圈', style: theme.textTheme.titleMedium),
              subtitle: Row(
                children: [
                  Text('5 成员 · ', style: theme.textTheme.bodySmall),
                  const Text('108.4 km', style: AppTypography.monoCaption),
                  Text(' 本周', style: theme.textTheme.bodySmall),
                ],
              ),
              trailing: const Icon(Icons.arrow_forward_ios, size: 14, color: AppColors.foregroundMuted),
              onTap: () => context.go('/teams/demo'),
            ),
          ),
          const SizedBox(height: 16),
          Center(
            child: Text(
              'S9 实装：战队 feed + 点赞 + 月榜',
              style: theme.textTheme.bodySmall,
            ),
          ),
        ],
      ),
    );
  }
}
