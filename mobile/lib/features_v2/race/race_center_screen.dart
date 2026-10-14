/// 赛事中心密表 /races —— #420 决议：
/// 月份粘性分组 / 三筛选+收藏开关 / 即将开跑 / 乐观更新+防连点+请求序号 /
/// 分页拉整年 / 静默刷新 / 空态四文案。数据经 raceCenterProvider。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/router/routes.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/top_bar.dart';
import 'providers/race_providers.dart';
import 'utils/race_rows.dart';

/// 密表行徽章底色（田协金 / 世界田联蓝的浅底映射到亮色主题）。
Color _badgeBg(String badge) =>
    badge.startsWith('世界田联') ? const Color(0xFFEBF3FC) : const Color(0xFFFBF3E4);
Color _badgeFg(String badge) =>
    badge.startsWith('世界田联') ? const Color(0xFF3E6FA8) : const Color(0xFF9A7830);

class RaceCenterScreen extends ConsumerStatefulWidget {
  const RaceCenterScreen({super.key});

  @override
  ConsumerState<RaceCenterScreen> createState() => _RaceCenterScreenState();
}

class _RaceCenterScreenState extends ConsumerState<RaceCenterScreen> {
  @override
  void initState() {
    super.initState();
    // 每次进入都重拉服务端真值（同键已有数据时静默刷新）。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) ref.read(raceCenterProvider.notifier).refresh();
    });
  }

  Future<void> _pick({
    required String title,
    required List<String> options,
    required String current,
    required ValueChanged<String> onPicked,
  }) async {
    final picked = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.all(StrideTokens.spaceMd),
              child: Text(title,
                  style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs14,
                      fontWeight: FontWeight.w600)),
            ),
            for (final opt in options)
              ListTile(
                dense: true,
                title: Text(opt,
                    style: TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs14,
                        color: opt == current ? StrideTokens.accent : StrideTokens.fg)),
                trailing:
                    opt == current ? const Icon(Icons.check, size: 18, color: StrideTokens.accent) : null,
                onTap: () => Navigator.of(ctx).pop(opt),
              ),
          ],
        ),
      ),
    );
    if (picked != null) onPicked(picked);
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(raceCenterProvider);
    final notifier = ref.read(raceCenterProvider.notifier);

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        title: '赛事中心',
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new, size: 18),
          onPressed: () => context.pop(),
        ),
      ),
      body: Column(
        children: [
          _FilterBar(state: state, notifier: notifier, onPick: _pick),
          if (state.error != null)
            Material(
              color: const Color(0xFFFDEEEE),
              child: SizedBox(
                width: double.infinity,
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                      horizontal: StrideTokens.spaceLg, vertical: 6),
                  child: Text(state.error!,
                      style: const TextStyle(
                          fontFamily: AppTypography.fontSans,
                          fontSize: StrideTokens.fs12,
                          color: StrideTokens.danger)),
                ),
              ),
            ),
          Expanded(
            child: state.loading
                ? const Center(child: CircularProgressIndicator())
                : RefreshIndicator(
                    color: StrideTokens.accent,
                    onRefresh: notifier.refresh,
                    child: CustomScrollView(
                      physics: const AlwaysScrollableScrollPhysics(),
                      slivers: [
                        for (final g in state.groups) ...[
                          SliverMainAxisGroup(
                            slivers: [
                              SliverPersistentHeader(
                                pinned: true,
                                delegate: _MonthHeaderDelegate(label: g.label),
                              ),
                              SliverList(
                                delegate: SliverChildBuilderDelegate(
                                  (ctx, i) => _RaceRow(row: g.rows[i]),
                                  childCount: g.rows.length,
                                ),
                              ),
                            ],
                          ),
                        ],
                        if (state.groups.isEmpty)
                          SliverFillRemaining(
                            hasScrollBody: false,
                            child: _EmptyView(text: state.emptyText),
                          )
                        else ...[
                          SliverToBoxAdapter(
                            child: Padding(
                              padding: const EdgeInsets.all(StrideTokens.spaceLg),
                              child: Text(
                                '共 ${state.viewCount} 场 · 下拉刷新（整年真值重拉）',
                                textAlign: TextAlign.center,
                                style: const TextStyle(
                                    fontFamily: AppTypography.fontSans,
                                    fontSize: StrideTokens.fs11,
                                    color: StrideTokens.muted2),
                              ),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}

// ── 筛选栏 ───────────────────────────────────────────────────────────────────

class _FilterBar extends StatelessWidget {
  const _FilterBar({
    required this.state,
    required this.notifier,
    required this.onPick,
  });

  final RaceCenterState state;
  final RaceCenterNotifier notifier;
  final void Function({
    required String title,
    required List<String> options,
    required String current,
    required ValueChanged<String> onPicked,
  })
      onPick;

  @override
  Widget build(BuildContext context) {
    final typeLabel =
        raceTypeOptions.firstWhere((o) => o.$2 == state.type, orElse: () => raceTypeOptions.first).$1;
    final provinceLabel = state.province.isEmpty ? '省份' : state.province;

    Widget cell(String label,
        {bool on = false, VoidCallback? onTap, Widget? trailing, String? cellKey}) {
      return Expanded(
        child: InkWell(
          key: Key(cellKey ?? 'race-filter-$label'),
          onTap: onTap,
          borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
          child: Container(
            height: 34,
            padding: const EdgeInsets.symmetric(horizontal: 6),
            decoration: BoxDecoration(
              color: on ? const Color(0xFFE7F6EE) : StrideTokens.surface,
              borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
              border: Border.all(
                  color: on ? StrideTokens.accent : StrideTokens.border2),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Flexible(
                  child: Text(
                    label,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs12,
                      fontWeight: on ? FontWeight.w600 : FontWeight.w400,
                      color: on ? StrideTokens.accent : StrideTokens.muted,
                    ),
                  ),
                ),
                if (trailing != null) trailing,
              ],
            ),
          ),
        ),
      );
    }

    return Container(
      color: StrideTokens.surface,
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      child: Row(
        children: [
          cell('${state.year}年',
              onTap: () => onPick(
                    title: '年份',
                    options: raceYearOptions(),
                    current: state.year,
                    onPicked: notifier.setYear,
                  )),
          const SizedBox(width: 6),
          cell(typeLabel,
              cellKey: 'race-filter-type',
              onTap: () => onPick(
                    title: '项目',
                    options: [for (final o in raceTypeOptions) o.$1],
                    current: typeLabel,
                    onPicked: (label) => notifier.setType(
                        raceTypeOptions.firstWhere((o) => o.$1 == label).$2),
                  )),
          const SizedBox(width: 6),
          cell(provinceLabel,
              cellKey: 'race-filter-province',
              onTap: () => onPick(
                    title: '省份',
                    options: ['全部', ...provinces],
                    current: state.province.isEmpty ? '全部' : state.province,
                    onPicked: (p) =>
                        notifier.setProvince(p == '全部' ? '' : p),
                  )),
          const SizedBox(width: 6),
          cell(state.favOnly ? '★ 收藏' : '☆ 收藏',
              cellKey: 'race-filter-fav',
              on: state.favOnly,
              onTap: () => notifier.setFavOnly(!state.favOnly)),
          const SizedBox(width: 6),
          Expanded(
            child: InkWell(
              key: const Key('race-filter-myraces'),
              onTap: () => context.push(Routes.myRaces),
              borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
              child: Container(
                height: 34,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: StrideTokens.surface,
                  borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
                  border: Border.all(color: StrideTokens.border2),
                ),
                child: const Text(
                  '我的赛事›',
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs12,
                      color: StrideTokens.accent,
                      fontWeight: FontWeight.w600),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ── 月份粘性头 ───────────────────────────────────────────────────────────────

class _MonthHeaderDelegate extends SliverPersistentHeaderDelegate {
  const _MonthHeaderDelegate({required this.label});

  final String label;

  @override
  double get minExtent => 30;

  @override
  double get maxExtent => 30;

  @override
  Widget build(BuildContext context, double shrinkOffset, bool overlapsContent) {
    return Container(
      color: StrideTokens.surface,
      padding: const EdgeInsets.fromLTRB(
          StrideTokens.spaceLg, 10, StrideTokens.spaceLg, 6),
      alignment: Alignment.centerLeft,
      child: Text(
        label,
        style: const TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: StrideTokens.fs14,
          fontWeight: FontWeight.w600,
          letterSpacing: 2,
          color: StrideTokens.muted,
        ),
      ),
    );
  }

  @override
  bool shouldRebuild(covariant _MonthHeaderDelegate old) => old.label != label;
}

// ── 密表行 ───────────────────────────────────────────────────────────────────

class _RaceRow extends ConsumerWidget {
  const _RaceRow({required this.row});

  final RaceRowView row;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final pending = ref.watch(raceCenterProvider
        .select((s) => s.pendingStars.contains(row.id)));

    return InkWell(
      key: Key('race-row-${row.id}'),
      onTap: () => context.push(Routes.raceDetail('${row.id}')),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: const BoxDecoration(
          color: StrideTokens.surface,
          border: Border(bottom: BorderSide(color: StrideTokens.border2)),
        ),
        child: Row(
          children: [
            SizedBox(
              width: 46,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(row.dateLabel,
                      style: const TextStyle(
                          fontFamily: AppTypography.fontMono,
                          fontSize: StrideTokens.fs13,
                          fontWeight: FontWeight.w600,
                          color: StrideTokens.fg)),
                  Text(row.weekday,
                      style: const TextStyle(
                          fontFamily: AppTypography.fontSans,
                          fontSize: 9,
                          color: StrideTokens.muted2)),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(row.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          fontFamily: AppTypography.fontSans,
                          fontSize: StrideTokens.fs13,
                          fontWeight: FontWeight.w600,
                          color: StrideTokens.fg)),
                  const SizedBox(height: 2),
                  Row(
                    children: [
                      if (row.cnBadge.isNotEmpty) _Badge(text: row.cnBadge),
                      if (row.waBadge.isNotEmpty) _Badge(text: row.waBadge),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 56),
              child: Text(row.typesLabel.isEmpty ? '—' : row.typesLabel,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs10,
                      color: StrideTokens.muted)),
            ),
            const SizedBox(width: 8),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 60),
              child: Text(row.city,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.right,
                  style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs10,
                      color: StrideTokens.muted)),
            ),
            const SizedBox(width: 4),
            // 星标不冒泡进详情：独立 InkWell。
            SizedBox(
              width: 32,
              height: 32,
              child: InkWell(
                key: Key('race-star-${row.id}'),
                onTap: pending
                    ? null
                    : () async {
                        try {
                          await ref
                              .read(raceCenterProvider.notifier)
                              .toggleStar(row.id);
                        } catch (_) {
                          if (context.mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              const SnackBar(
                                  content: Text('收藏操作失败'),
                                  duration: Duration(seconds: 2)),
                            );
                          }
                        }
                      },
                child: Icon(
                  row.starred ? Icons.star_rounded : Icons.star_outline_rounded,
                  size: 22,
                  color: row.starred ? const Color(0xFFD74331) : StrideTokens.muted2,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(right: 4),
      padding: const EdgeInsets.symmetric(horizontal: 5),
      decoration: BoxDecoration(
        color: _badgeBg(text),
        borderRadius: BorderRadius.circular(3),
      ),
      child: Text(
        text,
        style: TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: 9,
          height: 14 / 9,
          color: _badgeFg(text),
        ),
      ),
    );
  }
}

// ── 空态 ─────────────────────────────────────────────────────────────────────

class _EmptyView extends StatelessWidget {
  const _EmptyView({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(StrideTokens.space2xl),
        child: Text(
          text.isEmpty ? '当前筛选下没有赛事 · 换个条件试试' : text,
          textAlign: TextAlign.center,
          style: const TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs13,
              color: StrideTokens.muted),
        ),
      ),
    );
  }
}
