/// D2a — 周列表屏幕 (WeekListScreen).
///
/// 路由：/training/plan（训练 tab 的周计划列表）
///
/// 内容：
///   1. StrideScreenHero "训练 · 周计划"
///   2. StrideSegControl ['本周', '下周', '历史']（本周 + 历史实现；下周 SnackBar）
///   3. 周卡列表 → 点击进入 D2 周计划预览
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/router/routes.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/refreshable.dart';
import '../_shared/widgets/top_bar.dart';
import '../_shared/widgets/seg_control.dart';
import 'models/week_list_item.dart';
import 'providers/week_list_provider.dart';
import 'widgets/week_card.dart';

class WeekListScreen extends ConsumerStatefulWidget {
  const WeekListScreen({super.key});

  @override
  ConsumerState<WeekListScreen> createState() => _WeekListScreenState();
}

class _WeekListScreenState extends ConsumerState<WeekListScreen> {
  // 0 = 本周, 1 = 下周, 2 = 历史
  int _segIndex = 0;

  @override
  Widget build(BuildContext context) {
    final asyncWeeks = ref.watch(weekListProvider);

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          tooltip: '返回',
          onPressed: () => Navigator.of(context).pop(),
        ),
        title: '训练周',
      ),
      body: Column(
        children: [
          // Segmented control
          Padding(
            padding: const EdgeInsets.fromLTRB(
              StrideTokens.spaceLg,
              StrideTokens.spaceXs,
              StrideTokens.spaceLg,
              StrideTokens.spaceSm,
            ),
            child: StrideSegControl(
              options: const ['本周', '下周', '历史'],
              selectedIndex: _segIndex,
              onChanged: (i) {
                if (i == 1) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('下周计划 v1.x 即将开放')),
                  );
                  return;
                }
                setState(() => _segIndex = i);
              },
            ),
          ),
          // List
          Expanded(
            child: asyncWeeks.when(
              loading: () =>
                  const Center(child: CircularProgressIndicator()),
              error: (e, _) => _ErrorBody(onRetry: () => ref.invalidate(weekListProvider)),
              data: (weeks) => _WeekList(
                weeks: weeks,
                segIndex: _segIndex,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ── List body ─────────────────────────────────────────────────────────────────

class _WeekList extends StatelessWidget {
  const _WeekList({required this.weeks, required this.segIndex});

  final List<WeekListItem> weeks;
  final int segIndex;

  @override
  Widget build(BuildContext context) {
    final filtered = _filterWeeks(weeks, segIndex);

    if (filtered.isEmpty) {
      return const _EmptyState();
    }

    return StrideRefreshable<List<WeekListItem>>(
      provider: weekListProvider.future,
      child: ListView.builder(
        padding: const EdgeInsets.fromLTRB(
          StrideTokens.spaceLg,
          StrideTokens.spaceSm,
          StrideTokens.spaceLg,
          100, // extra bottom padding for FAB
        ),
        itemCount: filtered.length,
        itemBuilder: (context, i) {
          final item = filtered[i];
          return WeekCard(
            item: item,
            onTap: () => context.push(Routes.weekDetail(item.folder)),
          );
        },
      ),
    );
  }

  static List<WeekListItem> _filterWeeks(List<WeekListItem> weeks, int seg) {
    if (seg == 0) {
      // 本周 tab: show current in-progress week, or the most recent week.
      final current = weeks.where((w) => w.status == WeekStatus.inProgress);
      if (current.isNotEmpty) return current.toList();
      // No in-progress week → show the most recent one.
      return weeks.isNotEmpty ? [weeks.first] : [];
    }
    // seg == 2: 历史 — show all weeks sorted newest-first.
    return weeks;
  }
}

// ── Empty state ───────────────────────────────────────────────────────────────

class _EmptyState extends StatelessWidget {
  const _EmptyState();

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.calendar_today_outlined,
              size: 48, color: StrideTokens.muted2),
          SizedBox(height: StrideTokens.spaceMd),
          Text(
            '暂无训练计划',
            style: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs15,
              color: StrideTokens.muted,
            ),
          ),
          SizedBox(height: StrideTokens.spaceSm),
          Text(
            '点击右下角按钮生成本周计划',
            style: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs13,
              color: StrideTokens.muted2,
            ),
          ),
        ],
      ),
    );
  }
}

// ── Error body ────────────────────────────────────────────────────────────────

class _ErrorBody extends StatelessWidget {
  const _ErrorBody({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text(
            '加载失败',
            style: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs15,
              color: StrideTokens.danger,
            ),
          ),
          const SizedBox(height: StrideTokens.spaceMd),
          TextButton(
            onPressed: onRetry,
            child: const Text('重试'),
          ),
        ],
      ),
    );
  }
}
