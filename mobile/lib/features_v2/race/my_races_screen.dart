/// 我的比赛 /my-races —— #420 决议：双 tab（我的赛事/我的成绩）。
/// 计划卡状态机（lost 旁路）/ 行程勾选（PUT 显式覆盖不清另一项）/ 倒计时 /
/// offboarded 灰卡 / 成绩 + PB 徽章（全马半马各最短同成绩记首场）/
/// 点成绩进活动详情。数据经 racePlansProvider / raceResultsProvider。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/router/routes.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../../shared/utils/shanghai_date.dart';
import '../_shared/widgets/seg_control.dart';
import '../_shared/widgets/top_bar.dart';
import 'models/race_models.dart';
import 'providers/race_providers.dart';
import 'utils/race_rows.dart';

class MyRacesScreen extends ConsumerStatefulWidget {
  const MyRacesScreen({super.key});

  @override
  ConsumerState<MyRacesScreen> createState() => _MyRacesScreenState();
}

class _MyRacesScreenState extends ConsumerState<MyRacesScreen> {
  final _scroll = ScrollController();
  int _tab = 0; // 0=我的赛事 1=我的成绩

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      ref.read(racePlansProvider.notifier).load();
    });
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _switchTab(int i) {
    setState(() => _tab = i);
    // 切换回顶。
    if (_scroll.hasClients) {
      _scroll.jumpTo(0);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        title: '我的比赛',
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new, size: 18),
          onPressed: () => context.pop(),
        ),
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(StrideTokens.spaceLg),
            child: StrideSegControl(
              key: const Key('my-races-tabs'),
              options: const ['我的赛事', '我的成绩'],
              selectedIndex: _tab,
              onChanged: _switchTab,
            ),
          ),
          Expanded(
            child: _tab == 0
                ? _PlansTab(scrollController: _scroll)
                : _ResultsTab(scrollController: _scroll),
          ),
        ],
      ),
    );
  }
}

// ── 我的赛事 tab ─────────────────────────────────────────────────────────────

class _PlansTab extends ConsumerWidget {
  const _PlansTab({required this.scrollController});

  final ScrollController scrollController;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(racePlansProvider);
    final notifier = ref.read(racePlansProvider.notifier);

    if (state.loading && state.plans.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (state.error != null && state.plans.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(state.error!,
                style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs13,
                    color: StrideTokens.muted)),
            const SizedBox(height: StrideTokens.spaceMd),
            TextButton(onPressed: notifier.load, child: const Text('重试')),
          ],
        ),
      );
    }

    final plans = state.plans;
    return ListView(
      controller: scrollController,
      padding: const EdgeInsets.only(bottom: StrideTokens.space2xl),
      children: [
        for (final plan in plans)
          plan.offboarded
              ? _OffboardedCard(plan: plan)
              : _PlanCard(plan: plan),
        if (plans.isEmpty)
          Padding(
            padding: const EdgeInsets.all(StrideTokens.space2xl),
            child: Text(
              '还没有参赛计划 · 去赛事中心逛逛',
              textAlign: TextAlign.center,
              style: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs13,
                  color: StrideTokens.muted),
            ),
          ),
        const Padding(
          padding: EdgeInsets.all(StrideTokens.spaceLg),
          child: Text(
            '收藏 ≠ 参赛计划：收藏只是关注，参赛计划用于报名追踪与行程',
            textAlign: TextAlign.center,
            style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs11,
                color: StrideTokens.muted2),
          ),
        ),
      ],
    );
  }
}

Color _stateColor(String state) => switch (state) {
      'registered' => const Color(0xFF3E6FA8), // 蓝
      'won' => const Color(0xFF9A7830), // 金
      'lost' => StrideTokens.muted, // 灰
      'confirmed' => const Color(0xFF2E8B57), // 绿
      _ => StrideTokens.accent, // want
    };

Color _stateBg(String state) => switch (state) {
      'registered' => const Color(0xFFEBF3FC),
      'won' => const Color(0xFFFBF3E4),
      'lost' => const Color(0xFFF1F2F4),
      'confirmed' => const Color(0xFFE7F6EE),
      _ => const Color(0xFFE7F6EE),
    };

abstract class _PlanCardBase extends ConsumerWidget {
  const _PlanCardBase({required this.plan});

  final RacePlan plan;

  Widget card({required Widget child, Color color = StrideTokens.surface}) =>
      Container(
        margin: const EdgeInsets.symmetric(
            horizontal: StrideTokens.spaceLg, vertical: StrideTokens.spaceSm),
        padding: const EdgeInsets.all(StrideTokens.spaceMd),
        decoration: BoxDecoration(
          color: color,
          borderRadius: BorderRadius.circular(13),
          border: Border.all(color: StrideTokens.border2),
        ),
        child: child,
      );

  Widget headerRow(BuildContext context, WidgetRef ref) {
    return Row(
      children: [
        Expanded(
          child: InkWell(
            onTap: () => context.push(Routes.raceDetail('${plan.raceId}')),
            child: Text(plan.race?.displayName ?? '已下架赛事',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs14,
                    fontWeight: FontWeight.w700,
                    color: StrideTokens.fg)),
          ),
        ),
        const SizedBox(width: StrideTokens.spaceSm),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
          decoration: BoxDecoration(
            color: _stateBg(plan.state),
            borderRadius: BorderRadius.circular(4),
          ),
          child: Text(planStateBadgeLabel(plan.state),
              style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs10,
                  color: _stateColor(plan.state))),
        ),
      ],
    );
  }
}

class _PlanCard extends _PlanCardBase {
  const _PlanCard({required super.plan});

  Future<void> _guard(BuildContext context, WidgetRef ref, Future<void> f) async {
    try {
      await f;
    } catch (_) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
              content: Text('操作失败，已还原'), duration: Duration(seconds: 2)),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final notifier = ref.read(racePlansProvider.notifier);
    final race = plan.race;
    final days = race != null && RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(race.raceDate)
        ? daysUntil(race.raceDate, shanghaiToday())
        : null;
    final countdown = countdownLabel(days);
    final meta = [
      if (race != null && race.raceDate.isNotEmpty) planDateLabel(race.raceDate),
      if (typeAbbr(plan.itemType).isNotEmpty) typeAbbr(plan.itemType),
      if (race?.city != null && race!.city!.isNotEmpty) race.city!,
    ].join(' · ');

    return card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          headerRow(context, ref),
          if (meta.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(meta,
                style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs10,
                    color: StrideTokens.muted)),
          ],
          if (countdown.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(countdown,
                style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs10,
                    color: Color(0xFFD74331))),
          ],
          const SizedBox(height: 8),
          // 状态流转 chips（want→registered→won→confirmed；lost 旁路只从详情页进）。
          Wrap(
            spacing: 6,
            children: [
              for (final step in planFlowSteps(plan.state))
                InkWell(
                  key: Key('plan-flow-${plan.raceId}-${step.state}'),
                  borderRadius: BorderRadius.circular(12),
                  onTap: step.on
                      ? null
                      : () => _guard(
                          context,
                          ref,
                          notifier.changeState(plan.raceId, step.state)),
                  child: Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
                    decoration: BoxDecoration(
                      color: step.on
                          ? StrideTokens.accent
                          : const Color(0xFFF1F2F4),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Text(step.label,
                        style: TextStyle(
                            fontFamily: AppTypography.fontSans,
                            fontSize: StrideTokens.fs10,
                            color: step.on ? Colors.white : StrideTokens.muted)),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            children: [
              _tripChip(
                key: Key('plan-hotel-${plan.raceId}'),
                icon: Icons.hotel_outlined,
                label: '酒店 · ${plan.hotel ? '已订' : '未订'}',
                on: plan.hotel,
                onTap: () => _guard(
                  context,
                  ref,
                  notifier.setTrip(plan.raceId,
                      hotel: !plan.hotel, transit: plan.transit),
                ),
              ),
              _tripChip(
                key: Key('plan-transit-${plan.raceId}'),
                icon: Icons.train_outlined,
                label: '火车票·机票 · ${plan.transit ? '已订' : '未订'}',
                on: plan.transit,
                onTap: () => _guard(
                  context,
                  ref,
                  notifier.setTrip(plan.raceId,
                      hotel: plan.hotel, transit: !plan.transit),
                ),
              ),
            ],
          ),
          if (plan.state == 'lost') ...[
            const SizedBox(height: 8),
            InkWell(
              onTap: () => context.push(Routes.races),
              child: const Text('未中签？去找替代赛事 ›',
                  style: TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs11,
                      color: StrideTokens.accent,
                      fontWeight: FontWeight.w600)),
            ),
          ],
        ],
      ),
    );
  }

  Widget _tripChip({
    required Key key,
    required IconData icon,
    required String label,
    required bool on,
    required VoidCallback onTap,
  }) {
    return InkWell(
      key: key,
      borderRadius: BorderRadius.circular(12),
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(
          color: on ? const Color(0xFFE7F6EE) : const Color(0xFFF1F2F4),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 12, color: on ? const Color(0xFF2E8B57) : StrideTokens.muted),
            const SizedBox(width: 4),
            Text(label,
                style: TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs10,
                    color: on ? const Color(0xFF2E8B57) : StrideTokens.muted)),
          ],
        ),
      ),
    );
  }
}

class _OffboardedCard extends _PlanCardBase {
  const _OffboardedCard({required super.plan});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return card(
      color: const Color(0xFFF6F7F8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(plan.race?.displayName ?? '已下架赛事',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs14,
                        fontWeight: FontWeight.w700,
                        color: StrideTokens.muted)),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
                decoration: BoxDecoration(
                  color: const Color(0xFFF1F2F4),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: const Text('已下架',
                    style: TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs10,
                        color: StrideTokens.muted)),
              ),
            ],
          ),
          const SizedBox(height: 4),
          const Text('该赛事已被管理员下架，你的参赛记录保留',
              style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs10,
                  color: StrideTokens.muted2)),
        ],
      ),
    );
  }
}

// ── 我的成绩 tab ─────────────────────────────────────────────────────────────

class _ResultsTab extends ConsumerWidget {
  const _ResultsTab({required this.scrollController});

  final ScrollController scrollController;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(raceResultsProvider);
    return async.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('加载失败：$e',
                style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs13,
                    color: StrideTokens.muted)),
            const SizedBox(height: StrideTokens.spaceMd),
            TextButton(
              onPressed: () => ref.invalidate(raceResultsProvider),
              child: const Text('重试'),
            ),
          ],
        ),
      ),
      data: (races) {
        final pbIds = pbLabelIds(races);
        final marathon = races.where((r) => r.distanceBand == 'marathon').length;
        final half = races.where((r) => r.distanceBand == 'half_marathon').length;
        return ListView(
          controller: scrollController,
          padding: const EdgeInsets.only(bottom: StrideTokens.space2xl),
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(vertical: StrideTokens.spaceSm),
              child: Text(
                '共 ${races.length} 场 · 全马 $marathon · 半马 $half',
                textAlign: TextAlign.center,
                style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs11,
                    color: StrideTokens.muted),
              ),
            ),
            for (final r in races)
              _ResultRow(race: r, isPb: pbIds.contains(r.labelId)),
            if (races.isEmpty)
              const Padding(
                padding: EdgeInsets.all(StrideTokens.space2xl),
                child: Text(
                  '还没有被识别的比赛成绩 · 同步后自动检测',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs13,
                      color: StrideTokens.muted),
                ),
              ),
          ],
        );
      },
    );
  }
}

class _ResultRow extends StatelessWidget {
  const _ResultRow({required this.race, required this.isPb});

  final UserRace race;
  final bool isPb;

  @override
  Widget build(BuildContext context) {
    final dateLabel = shanghaiDateFromIso(race.date);
    final meta = [
      if (dateLabel.isNotEmpty) dateLabel.replaceAll('-', '/'),
      '${race.distanceKm.toStringAsFixed(1)}km',
      if (race.paceFmt.isNotEmpty && race.paceFmt != '—') race.paceFmt,
      if (race.avgHr != null) '${race.avgHr}bpm',
    ].join(' · ');

    return InkWell(
      onTap: () => context.push(Routes.activityDetail(race.labelId)),
      child: Container(
        margin: const EdgeInsets.symmetric(
            horizontal: StrideTokens.spaceLg, vertical: 4),
        padding: const EdgeInsets.all(StrideTokens.spaceMd),
        decoration: BoxDecoration(
          color: StrideTokens.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: StrideTokens.border2),
        ),
        child: Row(
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
              decoration: BoxDecoration(
                color: race.distanceBand == 'marathon'
                    ? const Color(0xFFFDEEEE)
                    : const Color(0xFFE9F5EF),
                borderRadius: BorderRadius.circular(4),
              ),
              child: Text(
                bandLabel(race.distanceBand),
                style: TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs10,
                    color: race.distanceBand == 'marathon'
                        ? const Color(0xFFC24A3F)
                        : const Color(0xFF2E8B57)),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    race.name ?? bandLabel(race.distanceBand),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs12,
                        fontWeight: FontWeight.w600,
                        color: StrideTokens.fg),
                  ),
                  Text(meta,
                      style: const TextStyle(
                          fontFamily: AppTypography.fontSans,
                          fontSize: StrideTokens.fs10,
                          color: StrideTokens.muted)),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(race.durationFmt,
                        style: const TextStyle(
                            fontFamily: AppTypography.fontMono,
                            fontSize: 16,
                            fontWeight: FontWeight.w700,
                            color: Color(0xFFD74331))),
                    const Text(' 净成绩',
                        style: TextStyle(
                            fontFamily: AppTypography.fontSans,
                            fontSize: 9,
                            color: StrideTokens.muted)),
                  ],
                ),
                if (isPb) ...[
                  const SizedBox(height: 2),
                  Container(
                    key: const Key('result-pb-badge'),
                    padding: const EdgeInsets.symmetric(horizontal: 5),
                    decoration: BoxDecoration(
                      border: Border.all(color: const Color(0xFFC9A25E)),
                      borderRadius: BorderRadius.circular(4),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.emoji_events_outlined,
                            size: 11, color: const Color(0xFF9A7830)),
                        const SizedBox(width: 2),
                        const Text('PB',
                            style: TextStyle(
                                fontFamily: AppTypography.fontSans,
                                fontSize: StrideTokens.fs10,
                                color: Color(0xFF9A7830))),
                      ],
                    ),
                  ),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }
}
