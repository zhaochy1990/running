/// E1 — 健康概览 (Health Overview).
///
/// Displays 3 metric cards (RHR, HRV — universal sensor data — and a STRIDE
/// training-load card) and a static AI-interpretation card. No
/// vendor-proprietary fatigue / load-state scores.
///
/// Data from `GET /api/{user}/health?days=14` + `/pmc` via
/// [healthOverviewProvider].
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/router/routes_v2.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/pill_colors.dart';
import '../../core/theme/tokens.dart';
import '../_shared/shell/main_shell.dart';
import '../_shared/widgets/pill.dart';
import '../_shared/widgets/refreshable.dart';
import '../_shared/widgets/top_bar.dart';
import '../../shared/utils/format.dart';
import 'models/health_overview.dart';
import 'providers/health_overview_provider.dart';
import 'widgets/metric_card.dart';

class HealthOverviewScreen extends ConsumerWidget {
  const HealthOverviewScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(healthOverviewProvider);

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        leading: IconButton(
          icon: const Icon(Icons.menu),
          tooltip: '菜单',
          onPressed: () => shellScaffoldKey.currentState?.openDrawer(),
        ),
        title: '数据',
        actions: [
          Text(
            todayLabel(),
            style: const TextStyle(
              fontFamily: AppTypography.fontMono,
              fontSize: StrideTokens.fs11,
              color: StrideTokens.muted,
              letterSpacing: 0.4,
            ),
          ),
        ],
      ),
      body: async.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => _ErrorView(message: e.toString()),
        data: (overview) => _OverviewBody(overview: overview),
      ),
    );
  }
}

// ── Body ──────────────────────────────────────────────────────────────────────

class _OverviewBody extends StatelessWidget {
  const _OverviewBody({required this.overview});

  final HealthOverview overview;

  @override
  Widget build(BuildContext context) {
    return StrideRefreshable<HealthOverview>(
      provider: healthOverviewProvider.future,
      child: ListView(
        padding: const EdgeInsets.all(StrideTokens.spaceLg),
        children: [
          _MetricGrid(overview: overview),
          const SizedBox(height: StrideTokens.spaceLg),
          _AiInterpretCard(overview: overview),
          const SizedBox(height: StrideTokens.spaceXl),
          const _DetailEntries(),
          const SizedBox(height: StrideTokens.spaceXl),
        ],
      ),
    );
  }
}

// ── 2×2 metric grid ───────────────────────────────────────────────────────────

class _MetricGrid extends StatelessWidget {
  const _MetricGrid({required this.overview});

  final HealthOverview overview;

  @override
  Widget build(BuildContext context) {
    final rhrValue = overview.rhr != null ? '${overview.rhr}' : '—';
    final rhrUnit = overview.rhr != null ? 'bpm' : null;
    final rhrPillVariant = _rhrPillVariant(overview.rhrBaselineDiff);
    final rhrPillText = _rhrPillText(overview.rhrBaselineDiff);

    final hrvValue = overview.hrv != null
        ? overview.hrv!.toStringAsFixed(0)
        : '—';
    final hrvUnit = overview.hrv != null ? 'ms' : null;
    final String? hrvSubtitle;
    if (overview.hrvLow != null && overview.hrvHigh != null) {
      hrvSubtitle =
          '区间 ${overview.hrvLow!.toStringAsFixed(0)}–${overview.hrvHigh!.toStringAsFixed(0)}';
    } else {
      hrvSubtitle = null;
    }

    // STRIDE training load — acute/chronic ratio (ACWR), with form pill and
    // ATL/CTL subtitle. All values computed by STRIDE, not COROS.
    final loadValue = overview.loadRatio != null
        ? overview.loadRatio!.toStringAsFixed(2)
        : '—';
    final loadPillText = _loadRatioPillText(overview.loadRatio);
    final loadPillVariant = _loadRatioPillVariant(overview.loadRatio);
    final String? loadSubtitle = _loadSubtitle(
      overview.acuteLoad,
      overview.chronicLoad,
      overview.form,
    );

    return GridView(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 2,
        mainAxisSpacing: StrideTokens.spaceMd,
        crossAxisSpacing: StrideTokens.spaceMd,
        childAspectRatio: 1.1,
      ),
      children: [
        // Card 1 — RHR (universal sensor)
        MetricCard(
          title: '静息心率',
          value: rhrValue,
          unit: rhrUnit,
          pill: rhrPillText,
          pillVariant: rhrPillVariant,
          delta: overview.rhrBaselineDiff,
          deltaPositiveIsBad: true,
        ),
        // Card 2 — HRV (universal sensor)
        MetricCard(
          title: '睡眠 HRV',
          value: hrvValue,
          unit: hrvUnit,
          subtitle: hrvSubtitle,
          pill: _hrvPillText(overview.hrv, overview.hrvLow, overview.hrvHigh),
          pillVariant: _hrvPillVariant(
            overview.hrv,
            overview.hrvLow,
            overview.hrvHigh,
          ),
        ),
        // Card 3 — Training load (STRIDE-computed)
        MetricCard(
          title: '训练负荷',
          value: loadValue,
          unit: 'ACWR',
          subtitle: loadSubtitle,
          pill: loadPillText,
          pillVariant: loadPillVariant,
        ),
      ],
    );
  }

  static String? _loadSubtitle(double? acute, double? chronic, double? form) {
    if (acute != null && chronic != null) {
      final parts =
          'ATL ${acute.toStringAsFixed(0)} · CTL ${chronic.toStringAsFixed(0)}';
      if (form != null) {
        final sign = form >= 0 ? '+' : '';
        return '$parts · Form $sign${form.toStringAsFixed(0)}';
      }
      return parts;
    }
    if (form != null) {
      final sign = form >= 0 ? '+' : '';
      return 'Form $sign${form.toStringAsFixed(0)}';
    }
    return null;
  }

  // ACWR (STRIDE acute/chronic) → display band. Sweet spot 0.8–1.3.
  static String? _loadRatioPillText(double? ratio) {
    if (ratio == null) return null;
    if (ratio < 0.8) return '减量';
    if (ratio <= 1.3) return '适宜';
    return '偏高';
  }

  static PillVariant _loadRatioPillVariant(double? ratio) {
    if (ratio == null) return PillVariant.muted;
    if (ratio < 0.8) return PillVariant.warn;
    if (ratio <= 1.3) return PillVariant.green;
    return PillVariant.danger;
  }

  static PillVariant _rhrPillVariant(int? diff) {
    if (diff == null) return PillVariant.muted;
    if (diff <= 2) return PillVariant.green;
    if (diff <= 5) return PillVariant.warn;
    return PillVariant.danger;
  }

  static String? _rhrPillText(int? diff) {
    if (diff == null) return null;
    if (diff <= 2) return '正常';
    if (diff <= 5) return '略高';
    return '偏高';
  }

  static String? _hrvPillText(double? hrv, double? low, double? high) {
    if (hrv == null) return null;
    if (low != null && hrv < low) return '偏低';
    if (high != null && hrv > high) return '偏高';
    return '区间内';
  }

  static PillVariant _hrvPillVariant(double? hrv, double? low, double? high) {
    if (hrv == null) return PillVariant.muted;
    if (low != null && hrv < low) return PillVariant.warn;
    if (high != null && hrv > high) return PillVariant.warn;
    return PillVariant.green;
  }
}

// ── AI interpret card ────────────────────────────────────────────────────────

class _AiInterpretCard extends StatelessWidget {
  const _AiInterpretCard({required this.overview});

  final HealthOverview overview;

  // Interpretation driven by STRIDE's acute/chronic load ratio (ACWR),
  // not vendor fatigue scores.
  String get _interpretation {
    final ratio = overview.loadRatio;
    if (ratio == null) {
      return '完成更多训练后，将根据近期训练负荷给出个性化解读。注意保持睡眠质量与恢复。';
    }
    if (ratio < 0.8) {
      return '近期负荷低于慢性基线，处于减量/恢复区间。状态回升，可按计划逐步恢复训练量。';
    }
    if (ratio <= 1.3) {
      return '急性与慢性负荷比处于适宜区间，训练压力可控、体能正在积累。确保每晚充足睡眠与蛋白质摄入。';
    }
    return '急性负荷明显高于慢性基线，负荷偏高有受伤风险。建议适当降低本周训练量（10-20%），增加恢复与睡眠。';
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Row(
            children: [
              Icon(Icons.auto_awesome, size: 16, color: StrideTokens.accent),
              SizedBox(width: StrideTokens.spaceXs),
              Text(
                'AI 解读',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs14,
                  fontWeight: FontWeight.w500,
                  color: StrideTokens.fg,
                ),
              ),
              SizedBox(width: StrideTokens.spaceSm),
              StridePill(
                text: 'v1 静态',
                variant: PillVariant.muted,
                dense: true,
              ),
            ],
          ),
          const SizedBox(height: StrideTokens.spaceMd),
          Text(
            _interpretation,
            style: const TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs13,
              color: StrideTokens.fgSoft,
              height: 1.6,
            ),
          ),
        ],
      ),
    );
  }
}

// ── Error view ────────────────────────────────────────────────────────────────

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(StrideTokens.space2xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(
              Icons.error_outline,
              size: 40,
              color: StrideTokens.muted,
            ),
            const SizedBox(height: StrideTokens.spaceMd),
            const Text(
              '加载失败',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs15,
                fontWeight: FontWeight.w500,
                color: StrideTokens.fg,
              ),
            ),
            const SizedBox(height: StrideTokens.spaceXs),
            Text(
              message,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs12,
                color: StrideTokens.muted,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ── Detail entries (E2-E6) ───────────────────────────────────────────────────

class _DetailEntries extends StatelessWidget {
  const _DetailEntries();

  @override
  Widget build(BuildContext context) {
    final entries = <_EntryItem>[
      const _EntryItem(
        icon: Icons.show_chart,
        title: '训练负荷',
        subtitle: 'ATL / CTL / TSB 曲线',
        route: RoutesV2.dataPmc,
      ),
      const _EntryItem(
        icon: Icons.ssid_chart,
        title: '趋势详情',
        subtitle: 'HRV / RHR / 睡眠 / 负荷',
        route: RoutesV2.dataTrends,
      ),
      const _EntryItem(
        icon: Icons.radar,
        title: '能力分析',
        subtitle: '6 维 ability radar',
        route: RoutesV2.abilityRadar,
      ),
      const _EntryItem(
        icon: Icons.flag_outlined,
        title: '成绩预测',
        subtitle: '5K / 10K / HM / FM + 目标差距',
        route: RoutesV2.predictions,
      ),
      const _EntryItem(
        icon: Icons.emoji_events_outlined,
        title: '个人最佳',
        subtitle: '4 距离自动检测',
        route: RoutesV2.pbRecords,
      ),
    ];

    return Container(
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusLg),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Column(
        children: [
          for (var i = 0; i < entries.length; i++) ...[
            if (i > 0)
              const Divider(
                height: 1,
                thickness: 1,
                color: StrideTokens.border2,
                indent: StrideTokens.spaceLg,
                endIndent: StrideTokens.spaceLg,
              ),
            _EntryTile(item: entries[i]),
          ],
        ],
      ),
    );
  }
}

class _EntryItem {
  const _EntryItem({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.route,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final String route;
}

class _EntryTile extends StatelessWidget {
  const _EntryTile({required this.item});

  final _EntryItem item;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      key: Key('detail-entry-${item.route}'),
      onTap: () => context.push(item.route),
      borderRadius: BorderRadius.circular(StrideTokens.radiusLg),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: StrideTokens.spaceLg,
          vertical: StrideTokens.spaceMd,
        ),
        child: Row(
          children: [
            Icon(item.icon, size: 22, color: StrideTokens.accent),
            const SizedBox(width: StrideTokens.spaceMd),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    item.title,
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs14,
                      fontWeight: FontWeight.w500,
                      color: StrideTokens.fg,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    item.subtitle,
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs12,
                      color: StrideTokens.muted,
                    ),
                  ),
                ],
              ),
            ),
            const Icon(
              Icons.chevron_right,
              size: 18,
              color: StrideTokens.muted,
            ),
          ],
        ),
      ),
    );
  }
}
