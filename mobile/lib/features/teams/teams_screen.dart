import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme/app_colors.dart';
import '../../data/models/team.dart';
import '../../data/repos/teams_repository.dart';

final _myTeamsProvider = FutureProvider<MyTeamsResponse>((ref) {
  return ref.watch(teamsRepositoryProvider).getMyTeams();
});

class TeamsScreen extends ConsumerWidget {
  const TeamsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final teams = ref.watch(_myTeamsProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('战队')),
      body: RefreshIndicator(
        onRefresh: () async => ref.invalidate(_myTeamsProvider),
        child: teams.when(
          loading: () => const Center(child: CircularProgressIndicator(strokeWidth: 2)),
          error: (e, _) => _ErrorState(message: '$e'),
          data: (resp) {
            if (resp.teams.isEmpty) {
              return ListView(
                padding: const EdgeInsets.all(32),
                children: [
                  Center(
                    child: Text(
                      '还没有加入任何战队',
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                  ),
                ],
              );
            }
            return ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: resp.teams.length,
              separatorBuilder: (_, _) => const SizedBox(height: 12),
              itemBuilder: (_, i) => _TeamRow(team: resp.teams[i]),
            );
          },
        ),
      ),
    );
  }
}

class _TeamRow extends StatelessWidget {
  const _TeamRow({required this.team});
  final MyTeam team;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: ListTile(
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        leading: const CircleAvatar(
          backgroundColor: AppColors.accent,
          child: Icon(Icons.directions_run, color: AppColors.foreground),
        ),
        title: Text(team.name, style: theme.textTheme.titleMedium),
        subtitle: Text(_roleLabel(team.role), style: theme.textTheme.bodySmall),
        trailing: const Icon(Icons.arrow_forward_ios,
            size: 14, color: AppColors.foregroundMuted),
        onTap: () => context.push('/teams/${team.id}'),
      ),
    );
  }

  static String _roleLabel(String role) {
    switch (role) {
      case 'owner':
        return '队长';
      case 'admin':
        return '管理员';
      default:
        return '成员';
    }
  }
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.message});
  final String message;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.cloud_off, size: 32, color: AppColors.foregroundMuted),
            const SizedBox(height: 12),
            Text('无法加载战队', style: theme.textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(message,
                style: theme.textTheme.bodySmall, textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }
}
