import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/current_user.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/app_typography.dart';
import '../../data/models/team.dart';
import '../../data/repos/teams_repository.dart';
import '../../shared/utils/format.dart';

final _teamProvider = FutureProvider.family<Team, String>((ref, teamId) {
  return ref.watch(teamsRepositoryProvider).getTeam(teamId);
});

final _mileageProvider =
    FutureProvider.family<MileageLeaderboard, ({String teamId, String period})>(
  (ref, args) {
    return ref
        .watch(teamsRepositoryProvider)
        .getMileage(args.teamId, period: args.period);
  },
);

class TeamDetailScreen extends ConsumerStatefulWidget {
  const TeamDetailScreen({required this.teamId, super.key});

  final String teamId;

  @override
  ConsumerState<TeamDetailScreen> createState() => _TeamDetailScreenState();
}

class _TeamDetailScreenState extends ConsumerState<TeamDetailScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabs = TabController(length: 2, vsync: this);

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final team = ref.watch(_teamProvider(widget.teamId));

    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.pop(),
        ),
        title: team.when(
          loading: () => Text('战队 · ${widget.teamId}'),
          error: (_, _) => Text('战队 · ${widget.teamId}'),
          data: (t) => Text(t.name),
        ),
        bottom: TabBar(
          controller: _tabs,
          tabs: const [
            Tab(text: '动态'),
            Tab(text: '里程榜'),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabs,
        children: [
          _FeedTab(teamId: widget.teamId),
          _MileageTab(teamId: widget.teamId),
        ],
      ),
    );
  }
}

class _FeedTab extends ConsumerStatefulWidget {
  const _FeedTab({required this.teamId});
  final String teamId;

  @override
  ConsumerState<_FeedTab> createState() => _FeedTabState();
}

class _FeedTabState extends ConsumerState<_FeedTab> {
  /// Local optimistic state: maps `userId/labelId` → liked + count overrides.
  final Map<String, ({bool youLiked, int? likeCount})> _overrides = {};

  String _key(String userId, String labelId) => '$userId/$labelId';

  Future<void> _toggleLike({
    required String userId,
    required String labelId,
    required bool wasLiked,
    required int? originalCount,
  }) async {
    final key = _key(userId, labelId);
    final current = _overrides[key] ??
        (youLiked: wasLiked, likeCount: originalCount);

    // Optimistic flip
    setState(() {
      _overrides[key] = (
        youLiked: !current.youLiked,
        likeCount: (current.likeCount ?? 0) + (current.youLiked ? -1 : 1),
      );
    });

    final repo = ref.read(teamsRepositoryProvider);
    try {
      final newCount = current.youLiked
          ? await repo.unlike(widget.teamId, userId, labelId)
          : await repo.like(widget.teamId, userId, labelId);
      if (!mounted) return;
      setState(() {
        _overrides[key] = (
          youLiked: !current.youLiked,
          likeCount: newCount ?? _overrides[key]!.likeCount,
        );
      });
    } catch (e) {
      if (!mounted) return;
      // Roll back
      setState(() {
        _overrides[key] = current;
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('点赞失败：$e')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final repo = ref.watch(teamsRepositoryProvider);
    return RefreshIndicator(
      onRefresh: () async {
        ref.invalidate(teamsRepositoryProvider);
      },
      child: StreamBuilder<TeamFeed>(
        stream: repo.watchTeamFeed(widget.teamId, days: 30),
        builder: (context, snap) {
          if (snap.hasError) return _ErrorState(message: '${snap.error}');
          if (!snap.hasData) {
            return const Center(child: CircularProgressIndicator(strokeWidth: 2));
          }
          final feed = snap.data!;
          if (feed.activities.isEmpty) {
            return ListView(
              padding: const EdgeInsets.all(32),
              children: const [
                Center(child: Text('暂无动态')),
              ],
            );
          }
          return ListView.separated(
            padding: const EdgeInsets.all(16),
            itemCount: feed.activities.length,
            separatorBuilder: (_, _) => const SizedBox(height: 12),
            itemBuilder: (_, i) {
              final entry = feed.activities[i];
              final key = _key(entry.userId, entry.activity.labelId);
              final override = _overrides[key];
              final youLiked = override?.youLiked ?? entry.youLiked ?? false;
              final likeCount = override?.likeCount ?? entry.likeCount ?? 0;
              return _FeedCard(
                entry: entry,
                youLiked: youLiked,
                likeCount: likeCount,
                onTapCard: () => context.push(
                  '/teams/${widget.teamId}/activity/${entry.userId}/${entry.activity.labelId}',
                ),
                onTapLike: () => _toggleLike(
                  userId: entry.userId,
                  labelId: entry.activity.labelId,
                  wasLiked: entry.youLiked ?? false,
                  originalCount: entry.likeCount,
                ),
              );
            },
          );
        },
      ),
    );
  }
}

class _FeedCard extends StatelessWidget {
  const _FeedCard({
    required this.entry,
    required this.youLiked,
    required this.likeCount,
    required this.onTapCard,
    required this.onTapLike,
  });

  final TeamFeedActivity entry;
  final bool youLiked;
  final int likeCount;
  final VoidCallback onTapCard;
  final VoidCallback onTapLike;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final activity = entry.activity;
    final topLikers = entry.topLikers ?? const [];

    return Card(
      child: InkWell(
        onTap: onTapCard,
        borderRadius: BorderRadius.circular(8),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  CircleAvatar(
                    radius: 14,
                    backgroundColor: AppColors.gray200,
                    child: Text(
                      entry.displayName.isNotEmpty ? entry.displayName[0] : '?',
                      style: AppTypography.monoCaption,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(entry.displayName,
                        style: theme.textTheme.titleMedium),
                  ),
                  Text(
                    formatDateShort(activity.date),
                    style: AppTypography.monoCaption,
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                crossAxisAlignment: CrossAxisAlignment.baseline,
                textBaseline: TextBaseline.alphabetic,
                children: [
                  Text(
                    activity.distanceKm.toStringAsFixed(2),
                    style: AppTypography.monoHeadline,
                  ),
                  const SizedBox(width: 4),
                  Text('km', style: theme.textTheme.bodySmall),
                  const Spacer(),
                  Text(activity.paceFmt, style: AppTypography.monoBody),
                  const SizedBox(width: 12),
                  Text(activity.durationFmt, style: AppTypography.monoBody),
                ],
              ),
              if (activity.sportNote != null && activity.sportNote!.trim().isNotEmpty) ...[
                const SizedBox(height: 8),
                Text(
                  activity.sportNote!,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodySmall,
                ),
              ],
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: topLikers.isNotEmpty
                        ? Text(
                            _likersLine(topLikers, likeCount),
                            style: theme.textTheme.bodySmall,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          )
                        : const SizedBox.shrink(),
                  ),
                  InkWell(
                    onTap: onTapLike,
                    borderRadius: BorderRadius.circular(16),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 8, vertical: 4),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            youLiked
                                ? Icons.thumb_up_alt
                                : Icons.thumb_up_off_alt,
                            size: 16,
                            color: youLiked
                                ? AppColors.accentDark
                                : AppColors.foregroundMuted,
                          ),
                          if (likeCount > 0) ...[
                            const SizedBox(width: 4),
                            Text(
                              '$likeCount',
                              style: AppTypography.monoCaption.copyWith(
                                color: youLiked
                                    ? AppColors.accentDark
                                    : AppColors.foregroundMuted,
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  static String _likersLine(List<String> top, int total) {
    if (top.isEmpty) return '';
    final names = top.take(3).join('、');
    if (total > top.length) {
      return '$names 等 $total 人赞过';
    }
    return '$names 赞过';
  }
}

class _MileageTab extends ConsumerStatefulWidget {
  const _MileageTab({required this.teamId});
  final String teamId;

  @override
  ConsumerState<_MileageTab> createState() => _MileageTabState();
}

class _MileageTabState extends ConsumerState<_MileageTab> {
  String _period = 'month';

  @override
  Widget build(BuildContext context) {
    final args = (teamId: widget.teamId, period: _period);
    final mileage = ref.watch(_mileageProvider(args));
    final me = ref.watch(currentUserIdProvider);

    return RefreshIndicator(
      onRefresh: () async => ref.invalidate(_mileageProvider(args)),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          SegmentedButton<String>(
            showSelectedIcon: false,
            segments: const [
              ButtonSegment(value: 'month', label: Text('本月榜')),
              ButtonSegment(value: 'week', label: Text('本周榜')),
            ],
            selected: {_period},
            onSelectionChanged: (s) => setState(() => _period = s.first),
          ),
          const SizedBox(height: 12),
          mileage.when(
            loading: () => const Padding(
              padding: EdgeInsets.symmetric(vertical: 32),
              child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
            ),
            error: (e, _) => _ErrorState(message: '$e'),
            data: (board) {
              if (board.rankings.isEmpty) {
                return const Padding(
                  padding: EdgeInsets.symmetric(vertical: 32),
                  child: Center(child: Text('暂无数据')),
                );
              }
              return Card(
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                      horizontal: 16, vertical: 8),
                  child: Column(
                    children: [
                      for (var i = 0; i < board.rankings.length; i++) ...[
                        _MileageRow(
                          rank: i + 1,
                          entry: board.rankings[i],
                          isMe: board.rankings[i].userId == me,
                        ),
                        if (i < board.rankings.length - 1)
                          const Divider(
                              height: 1, color: AppColors.border),
                      ],
                    ],
                  ),
                ),
              );
            },
          ),
        ],
      ),
    );
  }
}

class _MileageRow extends StatelessWidget {
  const _MileageRow(
      {required this.rank, required this.entry, required this.isMe});

  final int rank;
  final MileageRankingEntry entry;
  final bool isMe;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Row(
        children: [
          SizedBox(
            width: 32,
            child: Text(
              '$rank',
              style: AppTypography.monoTitle.copyWith(
                color: rank <= 3 ? AppColors.accentDark : AppColors.foregroundMuted,
                fontWeight: rank <= 3 ? FontWeight.w700 : FontWeight.w500,
              ),
            ),
          ),
          Expanded(
            child: Text(
              entry.displayName + (isMe ? ' (我)' : ''),
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    fontWeight: isMe ? FontWeight.w600 : FontWeight.w400,
                  ),
            ),
          ),
          Text(
            '${entry.totalKm.toStringAsFixed(1)} km',
            style: AppTypography.monoBody,
          ),
          const SizedBox(width: 12),
          Text(
            '${entry.activityCount}次',
            style: AppTypography.monoCaption,
          ),
        ],
      ),
    );
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
            const Icon(Icons.cloud_off,
                size: 32, color: AppColors.foregroundMuted),
            const SizedBox(height: 12),
            Text('加载失败', style: theme.textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(message,
                style: theme.textTheme.bodySmall,
                textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }
}
