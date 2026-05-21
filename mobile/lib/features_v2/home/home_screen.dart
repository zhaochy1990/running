/// D5 — Home Screen
///
/// Entry point for logged-in users. Shows status rings, recent activities,
/// weekly + lifetime stats, and an optional "generate plan" CTA.
///
/// Data: single `GET /api/{user}/home?recent_days=7` call via [homeProvider].
/// Pull-to-refresh: POST /api/{user}/sync → invalidate homeProvider.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/current_user.dart';
import '../../core/router/routes_v2.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../../data/api/stride_api.dart';
import '../_shared/widgets/screen_hero.dart';
import '../_shared/widgets/section_header.dart';
import '../_shared/widgets/stat_row.dart';
import 'models/home_data.dart';
import 'providers/home_provider.dart';
import 'widgets/status_ring_card.dart';

class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final homeAsync = ref.watch(homeProvider);

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      body: homeAsync.when(
        loading: () => const Center(
          child: CircularProgressIndicator(color: StrideTokens.accent),
        ),
        error: (err, _) => _ErrorBody(
          message: err.toString(),
          onRetry: () => ref.invalidate(homeProvider),
        ),
        data: (data) => _HomeBody(
          data: data,
          onRefresh: () async {
            await _doSync(context, ref);
          },
        ),
      ),
    );
  }

  Future<void> _doSync(BuildContext context, WidgetRef ref) async {
    final userId = ref.read(currentUserIdProvider);
    if (userId == null) return;
    final api = ref.read(strideApiProvider);
    try {
      await api.triggerSync(userId);
    } catch (_) {
      // Best-effort: sync errors are non-fatal
    }
    ref.invalidate(homeProvider);
  }
}

class _HomeBody extends StatelessWidget {
  const _HomeBody({required this.data, required this.onRefresh});
  final HomeData data;
  final Future<void> Function() onRefresh;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      bottom: false,
      child: RefreshIndicator(
        color: StrideTokens.accent,
        onRefresh: onRefresh,
        child: ListView(
          padding: EdgeInsets.zero,
          children: [
            // Hero — eyebrow + h1 + deck. Wave 1 surfaces what HomeData
            // already exposes; week-phase + race-countdown copy lands in
            // wave 2 when /home returns week_plan fields
            // (spec/app_scope_analysis.md §5 #28).
            StrideScreenHero(
              eyebrow: '主页 · 本周',
              title: _heroTitle(data.planState),
              deck: _heroDeck(data),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(
                StrideTokens.spaceLg,
                StrideTokens.spaceSm,
                StrideTokens.spaceLg,
                StrideTokens.space3xl,
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  StatusRingCard(ring: data.statusRing),
                  const SizedBox(height: StrideTokens.spaceLg),

                  // Plan-state CTA: build master plan (none) or generate
                  // this week's plan (active_no_week). When planState is
                  // "active" the weekly plan already exists and no CTA
                  // is shown. NB: design D5 assumes plan exists — wave 2
                  // will move first-time generation out of the home screen.
                  if (data.planState == 'none') ...[
                    _PlanCta(
                      icon: Icons.auto_awesome,
                      title: '生成个性化训练计划',
                      subtitle: '基于你的训练数据，AI 为你定制专属计划',
                      onTap: () => context.push(RoutesV2.trainingPlanGoal),
                    ),
                    const SizedBox(height: StrideTokens.spaceLg),
                  ] else if (data.planState == 'active_no_week') ...[
                    _PlanCta(
                      icon: Icons.calendar_today,
                      title: '立即生成本周计划',
                      subtitle: '基于训练总纲 + 上周完成情况，秒级生成',
                      onTap: () {
                        final today = DateTime.now();
                        final monday = today.subtract(
                          Duration(days: today.weekday - 1),
                        );
                        final weekStart =
                            '${monday.year.toString().padLeft(4, '0')}-'
                            '${monday.month.toString().padLeft(2, '0')}-'
                            '${monday.day.toString().padLeft(2, '0')}';
                        context.push(RoutesV2.generate(weekStart));
                      },
                    ),
                    const SizedBox(height: StrideTokens.spaceLg),
                  ],

                  const WfSectionHeader(title: '本周统计'),
                  StrideStatRow(items: [
                    StatItem(
                      label: '里程',
                      value:
                          data.weeklyStats.totalDistanceKm.toStringAsFixed(1),
                      unit: 'km',
                    ),
                    StatItem(
                      label: '时长',
                      value: _fmtDuration(data.weeklyStats.totalDurationSec),
                    ),
                    StatItem(
                      label: '课次',
                      value: data.weeklyStats.sessionCount.toString(),
                      unit: '次',
                    ),
                  ]),
                  const SizedBox(height: StrideTokens.spaceLg),

                  const WfSectionHeader(title: '最近活动'),
                  if (data.recentActivities.isEmpty)
                    const Padding(
                      padding: EdgeInsets.symmetric(
                        vertical: StrideTokens.spaceXl,
                      ),
                      child: Center(
                        child: Text(
                          '暂无近期活动',
                          style: TextStyle(
                            fontFamily: AppTypography.fontSans,
                            fontSize: StrideTokens.fs14,
                            color: StrideTokens.muted,
                          ),
                        ),
                      ),
                    )
                  else
                    ...data.recentActivities.map(
                      (a) => Padding(
                        padding: const EdgeInsets.only(
                          bottom: StrideTokens.spaceSm,
                        ),
                        child: _ActivityCard(activity: a),
                      ),
                    ),

                  const SizedBox(height: StrideTokens.spaceLg),
                  const WfSectionHeader(title: '累计数据'),
                  StrideStatRow(items: [
                    StatItem(
                      label: '总里程',
                      value: data.lifetimeStats.totalDistanceKm
                          .toStringAsFixed(0),
                      unit: 'km',
                    ),
                    StatItem(
                      label: '总活动',
                      value: data.lifetimeStats.totalActivities.toString(),
                      unit: '次',
                    ),
                    const StatItem(label: '', value: ''),
                  ]),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _heroTitle(String planState) {
    switch (planState) {
      case 'active':
        return '本周训练 · 进展中';
      case 'active_no_week':
        return '本周计划待生成';
      case 'none':
      default:
        return '欢迎来到 STRIDE';
    }
  }

  String _heroDeck(HomeData data) {
    final now = DateTime.now();
    final monday = now.subtract(Duration(days: now.weekday - 1));
    final sunday = monday.add(const Duration(days: 6));
    final range =
        '${monday.month}/${monday.day.toString().padLeft(2, '0')} — '
        '${sunday.month}/${sunday.day.toString().padLeft(2, '0')}';
    final km = data.weeklyStats.totalDistanceKm.toStringAsFixed(1);
    final sessions = data.weeklyStats.sessionCount;
    return '$range · 本周完成 $km km · $sessions 节';
  }

  String _fmtDuration(int seconds) {
    final h = seconds ~/ 3600;
    final m = (seconds % 3600) ~/ 60;
    if (h > 0) return '${h}h${m.toString().padLeft(2, '0')}m';
    return '$m分钟';
  }
}

class _PlanCta extends StatelessWidget {
  const _PlanCta({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(StrideTokens.spaceLg),
        decoration: BoxDecoration(
          color: StrideTokens.surface,
          border: Border.all(color: StrideTokens.accent, width: 1.5),
          borderRadius: BorderRadius.circular(StrideTokens.radiusLg),
        ),
        child: Row(
          children: [
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: StrideTokens.accentFg,
                borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
              ),
              child: Icon(icon, size: 20, color: StrideTokens.accent),
            ),
            const SizedBox(width: StrideTokens.spaceMd),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs14,
                      fontWeight: FontWeight.w600,
                      color: StrideTokens.fg,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    subtitle,
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs12,
                      color: StrideTokens.muted,
                    ),
                  ),
                ],
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

class _ActivityCard extends StatelessWidget {
  const _ActivityCard({required this.activity});
  final HomeActivity activity;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () => context.push(RoutesV2.activityDetail(activity.labelId)),
      child: Container(
        padding: const EdgeInsets.all(StrideTokens.spaceMd),
        decoration: BoxDecoration(
          color: StrideTokens.surface,
          border: Border.all(color: StrideTokens.border2),
          borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Header row: name + date + sport pill
            Row(
              children: [
                Expanded(
                  child: Text(
                    activity.name.isNotEmpty ? activity.name : activity.sportType,
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs14,
                      fontWeight: FontWeight.w600,
                      color: StrideTokens.fg,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                const SizedBox(width: StrideTokens.spaceSm),
                Text(
                  activity.date,
                  style: const TextStyle(
                    fontFamily: AppTypography.fontMono,
                    fontSize: StrideTokens.fs11,
                    color: StrideTokens.muted,
                  ),
                ),
              ],
            ),
            const SizedBox(height: StrideTokens.spaceSm),
            // Stats row
            Row(
              children: [
                _metric(
                    '${activity.distanceKm.toStringAsFixed(1)} km', Icons.straighten),
                const SizedBox(width: StrideTokens.spaceMd),
                if (activity.avgPaceSecPerKm != null) ...[
                  _metric(_fmtPace(activity.avgPaceSecPerKm!), Icons.speed),
                  const SizedBox(width: StrideTokens.spaceMd),
                ],
                if (activity.avgHr != null)
                  _metric('${activity.avgHr} bpm', Icons.favorite_outline),
              ],
            ),
            // Commentary excerpt
            if (activity.commentaryExcerpt != null &&
                activity.commentaryExcerpt!.isNotEmpty) ...[
              const SizedBox(height: StrideTokens.spaceSm),
              const Divider(height: 1, color: StrideTokens.border2),
              const SizedBox(height: StrideTokens.spaceSm),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.auto_awesome,
                      size: 12, color: StrideTokens.accent),
                  const SizedBox(width: 4),
                  Expanded(
                    child: Text(
                      activity.commentaryExcerpt!,
                      style: const TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs12,
                        color: StrideTokens.fgSoft,
                        height: 1.4,
                      ),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _metric(String text, IconData icon) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 13, color: StrideTokens.muted2),
        const SizedBox(width: 3),
        Text(
          text,
          style: const TextStyle(
            fontFamily: AppTypography.fontMono,
            fontSize: StrideTokens.fs12,
            color: StrideTokens.fgSoft,
          ),
        ),
      ],
    );
  }

  String _fmtPace(int secPerKm) {
    final m = secPerKm ~/ 60;
    final s = secPerKm % 60;
    return '$m:${s.toString().padLeft(2, '0')}/km';
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
            const Icon(Icons.error_outline, size: 48, color: StrideTokens.danger),
            const SizedBox(height: StrideTokens.spaceLg),
            const Text(
              '加载失败',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs15,
                fontWeight: FontWeight.w600,
                color: StrideTokens.fg,
              ),
            ),
            const SizedBox(height: StrideTokens.spaceSm),
            Text(
              message,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs12,
                color: StrideTokens.muted,
              ),
            ),
            const SizedBox(height: StrideTokens.spaceLg),
            TextButton(
              onPressed: onRetry,
              child: const Text('重试'),
            ),
          ],
        ),
      ),
    );
  }
}
