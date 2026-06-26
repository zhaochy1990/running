/// 发现 (Discover) tab — community surface, v1 centers on the user's groups.
///
/// Mirrors `spec/stitch/mobile/tab-discover.html`: my groups list + a
/// create/join row + a footnote. Leaderboard preview is deferred until the
/// team-detail flow lands in V2.
///
/// Data: `GET /api/users/me/teams` via [myTeamsProvider].
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../../data/models/team.dart';
import '../_shared/shell/main_shell.dart';
import '../_shared/widgets/section_header.dart';
import '../_shared/widgets/top_bar.dart';
import 'providers/discover_provider.dart';

class DiscoverScreen extends ConsumerWidget {
  const DiscoverScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final teamsAsync = ref.watch(myTeamsProvider);

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        title: '发现',
        leading: IconButton(
          icon: const Icon(Icons.menu),
          onPressed: () => shellScaffoldKey.currentState?.openDrawer(),
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.search),
            onPressed: () => _comingSoon(context, '搜索群组'),
          ),
        ],
      ),
      body: teamsAsync.when(
        loading: () => const Center(
          child: CircularProgressIndicator(color: StrideTokens.accent),
        ),
        error: (e, _) => _ErrorBody(
          message: e.toString(),
          onRetry: () => ref.invalidate(myTeamsProvider),
        ),
        data: (resp) => _Body(teams: resp.teams),
      ),
    );
  }

  static void _comingSoon(BuildContext context, String feature) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('$feature — v1.x 即将支持')),
    );
  }
}

class _Body extends StatelessWidget {
  const _Body({required this.teams});
  final List<MyTeam> teams;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.only(bottom: StrideTokens.space3xl),
      children: [
        const WfSectionHeader(title: '我的群组'),
        if (teams.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(
              horizontal: StrideTokens.spaceLg,
              vertical: StrideTokens.spaceXl,
            ),
            child: Text(
              '还没有加入任何群组',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs14,
                color: StrideTokens.muted,
              ),
            ),
          )
        else
          ...teams.map((t) => Padding(
                padding: const EdgeInsets.fromLTRB(
                  StrideTokens.spaceLg,
                  0,
                  StrideTokens.spaceLg,
                  StrideTokens.spaceSm,
                ),
                child: _GroupCard(team: t),
              )),
        const SizedBox(height: StrideTokens.spaceSm),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: StrideTokens.spaceLg),
          child: _CreateJoinRow(
            onTap: () => DiscoverScreen._comingSoon(context, '创建 / 加入群组'),
          ),
        ),
        const SizedBox(height: StrideTokens.spaceXl),
        const Center(
          child: Text(
            '更多社区功能即将上线',
            style: TextStyle(
              fontFamily: AppTypography.fontMono,
              fontSize: StrideTokens.fs10,
              color: StrideTokens.muted2,
              letterSpacing: 0.8,
            ),
          ),
        ),
      ],
    );
  }
}

class _GroupCard extends StatelessWidget {
  const _GroupCard({required this.team});
  final MyTeam team;

  bool get _isCaptain => team.role == 'owner' || team.role == 'captain';

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () => ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('群组详情 — v1.x 即将支持')),
      ),
      child: Container(
        padding: const EdgeInsets.all(StrideTokens.spaceMd),
        decoration: BoxDecoration(
          color: StrideTokens.surface,
          border: Border.all(color: StrideTokens.border2),
          borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        ),
        child: Row(
          children: [
            Container(
              width: 44,
              height: 44,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: StrideTokens.accentFg,
                borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
              ),
              child: const Icon(Icons.groups_outlined,
                  size: 22, color: StrideTokens.accent),
            ),
            const SizedBox(width: StrideTokens.spaceMd),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    team.name,
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs15,
                      fontWeight: FontWeight.w600,
                      color: StrideTokens.fg,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 2),
                  Text(
                    _isCaptain ? '我是队长' : '成员',
                    style: const TextStyle(
                      fontFamily: AppTypography.fontMono,
                      fontSize: StrideTokens.fs11,
                      color: StrideTokens.muted,
                      letterSpacing: 0.4,
                    ),
                  ),
                ],
              ),
            ),
            if (_isCaptain)
              Container(
                margin: const EdgeInsets.only(right: StrideTokens.spaceSm),
                padding:
                    const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: StrideTokens.accentFg,
                  borderRadius: BorderRadius.circular(StrideTokens.radiusPill),
                ),
                child: const Text(
                  '队长',
                  style: TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs11,
                    fontWeight: FontWeight.w600,
                    color: StrideTokens.accent,
                  ),
                ),
              ),
            const Icon(Icons.chevron_right,
                size: 20, color: StrideTokens.muted2),
          ],
        ),
      ),
    );
  }
}

class _CreateJoinRow extends StatelessWidget {
  const _CreateJoinRow({required this.onTap});
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: StrideTokens.spaceLg),
        decoration: BoxDecoration(
          color: StrideTokens.surface,
          borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
          border: Border.all(
            color: StrideTokens.accent.withValues(alpha: 0.5),
            width: 1,
          ),
        ),
        child: const Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.add, size: 18, color: StrideTokens.accent),
            SizedBox(width: 6),
            Text(
              '创建 / 加入群组',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs14,
                fontWeight: FontWeight.w600,
                color: StrideTokens.accent,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ErrorBody extends StatelessWidget {
  const _ErrorBody({required this.message, required this.onRetry});
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(StrideTokens.space2xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 40, color: StrideTokens.danger),
            const SizedBox(height: StrideTokens.spaceMd),
            Text(
              message,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs12,
                color: StrideTokens.muted,
              ),
            ),
            const SizedBox(height: StrideTokens.spaceMd),
            TextButton(onPressed: onRetry, child: const Text('重试')),
          ],
        ),
      ),
    );
  }
}
