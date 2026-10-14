/// 赛事详情 /races/:id —— #420 决议：三宫格 / 报名时间轴（按当日推算；
/// 无 timeline 隐藏）/ 概要·项目·出行三 tab / 报名 sheet（五态；
/// PUT 勿清 hotel/transit）/ 复制渠道 URL / 策略卡。
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/router/routes.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../../data/api/stride_api.dart';
import '../../shared/utils/shanghai_date.dart';
import '../_shared/widgets/top_bar.dart';
import '../coach/providers/coach_chat_provider.dart'
    show pendingCoachMessageProvider;
import 'models/race_models.dart';
import 'providers/race_providers.dart';
import 'utils/race_rows.dart';
import 'utils/race_share.dart';

class RaceDetailScreen extends ConsumerStatefulWidget {
  const RaceDetailScreen({super.key, required this.raceId});

  final int raceId;

  @override
  ConsumerState<RaceDetailScreen> createState() => _RaceDetailScreenState();
}

class _RaceDetailScreenState extends ConsumerState<RaceDetailScreen> {
  int _tab = 0; // 0=概要 1=项目 2=出行
  int? _pendingStar;

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), duration: const Duration(seconds: 2)),
    );
  }

  Future<void> _toggleStar(RaceDetail detail) async {
    if (_pendingStar != null) return; // 防连点
    setState(() => _pendingStar = detail.id);
    try {
      // 详情页自持 favorited：重拉详情；密表侧静默刷新同步星标
      // （不 invalidate 整个 provider —— 重建后无人触发 refresh 会永久 loading）。
      final api = ref.read(strideApiProvider);
      await api.toggleRaceFavorite(detail.id);
      ref.invalidate(raceDetailProvider(widget.raceId));
      ref.read(raceCenterProvider.notifier).refresh();
    } catch (_) {
      _toast('收藏操作失败');
    } finally {
      if (mounted) setState(() => _pendingStar = null);
    }
  }

  Future<void> _openSignupSheet(RaceDetail detail) async {
    final plans = ref.read(racePlansProvider.notifier);
    await plans.load();
    if (!mounted) return;
    final plan = ref.read(racePlansProvider.notifier).planFor(detail.id);
    final chips = raceItemChips(detail.items);
    if (chips.isEmpty) {
      _toast('该赛事暂无可报名的项目信息');
      return;
    }
    var selected =
        plan != null && chips.any((c) => c.token == plan.itemType)
            ? plan.itemType
            : chips.first.token;
    final current = plan?.state;

    final picked = await showModalBottomSheet<(String, String)>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheet) => SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(StrideTokens.spaceLg),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('选择项目',
                    style: TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs14,
                        fontWeight: FontWeight.w600)),
                const SizedBox(height: StrideTokens.spaceSm),
                Wrap(
                  spacing: StrideTokens.spaceSm,
                  children: [
                    for (final c in chips)
                      ChoiceChip(
                        key: Key('signup-chip-${c.token}'),
                        label: Text(c.label),
                        selected: selected == c.token,
                        selectedColor: const Color(0xFFE7F6EE),
                        labelStyle: TextStyle(
                            fontFamily: AppTypography.fontSans,
                            fontSize: StrideTokens.fs12,
                            color: selected == c.token
                                ? StrideTokens.accent
                                : StrideTokens.fgSoft),
                        side: BorderSide(
                            color: selected == c.token
                                ? StrideTokens.accent
                                : StrideTokens.border),
                        showCheckmark: false,
                        onSelected: (_) => setSheet(() => selected = c.token),
                      ),
                  ],
                ),
                const SizedBox(height: StrideTokens.spaceMd),
                const Text('报名状态',
                    style: TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs14,
                        fontWeight: FontWeight.w600)),
                for (final (value, label) in planStateOptions)
                  InkWell(
                    key: Key('signup-state-$value'),
                    onTap: () => Navigator.of(ctx).pop((value, selected)),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      child: Row(
                        children: [
                          Expanded(
                            child: Text(label,
                                style: const TextStyle(
                                    fontFamily: AppTypography.fontSans,
                                    fontSize: StrideTokens.fs14,
                                    color: StrideTokens.fg)),
                          ),
                          if (plan != null &&
                              plan.itemType == selected &&
                              plan.state == value)
                            const Icon(Icons.check,
                                size: 18, color: StrideTokens.accent),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
    if (picked == null) return;
    final (option, itemType) = picked;
    if (option == current && plan != null && plan.itemType == itemType) return;
    try {
      await plans.submitSignup(
          raceId: detail.id, option: option, itemType: itemType);
      _toast(option == 'none' ? '已取消追踪' : '已更新报名状态');
    } catch (_) {
      _toast('操作失败，请稍后重试');
    }
  }

  void _copyUrl(String url) {
    // 一键复制 = 仅复制渠道 URL 原文（无拼接、成功不 toast）。
    Clipboard.setData(ClipboardData(text: url));
  }

  /// #424 决议 v1：详情页分享 = 文本模板（赛事名/日期/城市/认证 + slogan
  /// + Landing 链接）经系统分享面板外发。详情未加载完时按钮为 no-op。
  Future<void> _shareDetail() async {
    final detail = ref.read(raceDetailProvider(widget.raceId)).valueOrNull;
    if (detail == null) return;
    try {
      await SharePlus.instance.share(ShareParams(text: raceShareText(detail)));
    } catch (_) {
      _toast('分享失败，请稍后重试');
    }
  }

  void _talkToCoach(RaceDetail detail, {String? kickoff}) {
    ref.read(pendingCoachMessageProvider.notifier).state = kickoff ??
        '我想聊聊「${detail.displayName}」的比赛策略。';
    context.go(Routes.coach);
  }

  @override
  Widget build(BuildContext context) {
    final detailAsync = ref.watch(raceDetailProvider(widget.raceId));
    final plansState = ref.watch(racePlansProvider);
    final plan = plansState.plans.isEmpty
        ? null
        : plansState.plans.where((p) => p.raceId == widget.raceId).firstOrNull;

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        title: '赛事详情',
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new, size: 18),
          onPressed: () => context.pop(),
        ),
        actions: [
          IconButton(
            key: const Key('race-detail-share'),
            icon: const Icon(Icons.ios_share, size: 20),
            onPressed: _shareDetail,
          ),
        ],
      ),
      body: detailAsync.when(
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
                onPressed: () =>
                    ref.invalidate(raceDetailProvider(widget.raceId)),
                child: const Text('重试'),
              ),
            ],
          ),
        ),
        data: (detail) {
          final today = shanghaiToday();
          final grid = raceHeadGrid(detail, today);
          final steps = raceTimelineSteps(detail, today);
          return ListView(
            padding: const EdgeInsets.only(bottom: StrideTokens.space2xl),
            children: [
              _header(detail),
              _grid(grid),
              if (steps.isNotEmpty) _timeline(steps),
              if (detail.strategyAvailable) _strategyCard(detail),
              _signupButton(detail, plan),
              _tabs(),
              if (_tab == 0)
                _summaryTab(detail)
              else if (_tab == 1)
                _itemsTab(detail)
              else
                _tripTab(detail),
            ],
          );
        },
      ),
    );
  }

  // ── 头区 ────────────────────────────────────────────────────────────────

  Widget _header(RaceDetail detail) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(StrideTokens.spaceLg, 14, StrideTokens.spaceLg, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(detail.displayName,
              style: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: 17,
                  fontWeight: FontWeight.w700,
                  color: StrideTokens.fg)),
          const SizedBox(height: 4),
          Row(
            children: [
              if (cnBadgeOf(detail.label).isNotEmpty)
                _badgePill(cnBadgeOf(detail.label)),
              if (waBadgeOf(detail.waLabel).isNotEmpty)
                _badgePill(waBadgeOf(detail.waLabel)),
              const Spacer(),
              InkWell(
                key: const Key('race-detail-star'),
                onTap: _pendingStar != null ? null : () => _toggleStar(detail),
                child: Icon(
                  (detail.favorited)
                      ? Icons.star_rounded
                      : Icons.star_outline_rounded,
                  size: 24,
                  color: detail.favorited
                      ? const Color(0xFFD74331)
                      : StrideTokens.muted2,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _badgePill(String text) => Container(
        margin: const EdgeInsets.only(right: 4),
        padding: const EdgeInsets.symmetric(horizontal: 5),
        decoration: BoxDecoration(
          color: text.startsWith('世界田联')
              ? const Color(0xFFEBF3FC)
              : const Color(0xFFFBF3E4),
          borderRadius: BorderRadius.circular(3),
        ),
        child: Text(
          text,
          style: TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: 9,
            height: 14 / 9,
            color: text.startsWith('世界田联')
                ? const Color(0xFF3E6FA8)
                : const Color(0xFF9A7830),
          ),
        ),
      );

  // ── 三宫格 ──────────────────────────────────────────────────────────────

  Widget _grid(List<RaceHeadCell> cells) {
    return Padding(
      padding: const EdgeInsets.symmetric(
          horizontal: StrideTokens.spaceLg, vertical: StrideTokens.spaceSm),
      child: Row(
        children: [
          for (final c in cells) ...[
            Expanded(
              child: Container(
                padding: const EdgeInsets.symmetric(vertical: 10),
                decoration: BoxDecoration(
                  color: StrideTokens.surface,
                  borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
                  border: Border.all(color: StrideTokens.border2),
                ),
                child: Column(
                  children: [
                    Text(c.value,
                        style: TextStyle(
                            fontFamily: AppTypography.fontMono,
                            fontSize: 16,
                            fontWeight: FontWeight.w700,
                            color: c.lead ? const Color(0xFFD74331) : StrideTokens.fg)),
                    if (c.label.isNotEmpty) ...[
                      const SizedBox(height: 2),
                      Text(c.label,
                          style: const TextStyle(
                              fontFamily: AppTypography.fontSans,
                              fontSize: StrideTokens.fs10,
                              color: StrideTokens.muted2)),
                    ],
                  ],
                ),
              ),
            ),
            if (c != cells.last) const SizedBox(width: StrideTokens.spaceSm),
          ],
        ],
      ),
    );
  }

  // ── 报名时间轴 ──────────────────────────────────────────────────────────

  Widget _timeline(List<RaceTimelineStep> steps) {
    return Padding(
      padding: const EdgeInsets.symmetric(
          horizontal: StrideTokens.spaceLg, vertical: StrideTokens.spaceSm),
      child: Column(
        children: [
          Stack(
            alignment: Alignment.center,
            children: [
              Positioned(
                left: 24,
                right: 24,
                child: Container(height: 2, color: StrideTokens.border2),
              ),
              FractionallySizedBox(
                widthFactor: (steps.where((s) => s.done).length / steps.length),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Container(height: 2, color: StrideTokens.accent),
                ),
              ),
              Row(
                children: [
                  for (final s in steps)
                    Expanded(
                      child: Column(
                        children: [
                          Container(
                            width: 8,
                            height: 8,
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              color: s.done
                                  ? StrideTokens.accent
                                  : StrideTokens.border,
                            ),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              for (final s in steps)
                Expanded(
                  child: Column(
                    children: [
                      Text(s.label,
                          textAlign: TextAlign.center,
                          style: TextStyle(
                              fontFamily: AppTypography.fontSans,
                              fontSize: StrideTokens.fs10,
                              color: s.done
                                  ? StrideTokens.fg
                                  : StrideTokens.muted)),
                      Text(s.date,
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                              fontFamily: AppTypography.fontMono,
                              fontSize: 9,
                              color: StrideTokens.muted2)),
                    ],
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }

  // ── 策略卡 ──────────────────────────────────────────────────────────────

  Widget _strategyCard(RaceDetail detail) {
    final strategiesAsync = ref.watch(raceStrategiesProvider(detail.id));
    return strategiesAsync.when(
      loading: () => const SizedBox.shrink(),
      error: (_, _) => const SizedBox.shrink(),
      data: (versions) {
        if (versions.isEmpty) {
          return _card(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('比赛策略',
                    style: TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs13,
                        fontWeight: FontWeight.w600)),
                const SizedBox(height: 6),
                InkWell(
                  key: const Key('strategy-cta'),
                  onTap: () => _talkToCoach(detail),
                  child: const Text('和教练聊一聊，制定比赛策略 ›',
                      style: TextStyle(
                          fontFamily: AppTypography.fontSans,
                          fontSize: StrideTokens.fs12,
                          color: StrideTokens.accent,
                          fontWeight: FontWeight.w600)),
                ),
              ],
            ),
          );
        }
        final versionsSorted = [...versions]
          ..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
        final shown = versionsSorted.first;
        return InkWell(
          key: const Key('strategy-card'),
          onTap: () =>
              context.push(Routes.raceStrategy('${detail.id}')),
          child: Container(
            margin: const EdgeInsets.symmetric(
                horizontal: StrideTokens.spaceLg, vertical: StrideTokens.spaceSm),
            padding: const EdgeInsets.all(StrideTokens.spaceMd),
            decoration: BoxDecoration(
              color: StrideTokens.surface,
              borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
              border: Border.all(color: StrideTokens.accent),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Text('比赛策略',
                        style: TextStyle(
                            fontFamily: AppTypography.fontSans,
                            fontSize: StrideTokens.fs13,
                            fontWeight: FontWeight.w600)),
                    const SizedBox(width: 6),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 4),
                      decoration: BoxDecoration(
                        border: Border.all(color: StrideTokens.accent),
                        borderRadius: BorderRadius.circular(3),
                      ),
                      child: const Text('已生成',
                          style: TextStyle(
                              fontFamily: AppTypography.fontSans,
                              fontSize: 9,
                              color: StrideTokens.accent)),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  '目标 ${shown.targetFinishTime} · 共 ${versions.length} 版 · '
                  '最新 ${_dateLabel(shown.updatedAt)}',
                  style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs10,
                      color: StrideTokens.muted),
                ),
                const SizedBox(height: 6),
                const Text('查看完整报告（配速表 · 补给 · 提示，可编辑）›',
                    style: TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs12,
                        color: StrideTokens.accent,
                        fontWeight: FontWeight.w600)),
              ],
            ),
          ),
        );
      },
    );
  }

  static String _dateLabel(String rfc3339) {
    final d = DateTime.tryParse(rfc3339)?.toLocal();
    if (d == null) return '';
    return '${d.month}/${d.day}';
  }

  // ── 报名按钮 ────────────────────────────────────────────────────────────

  Widget _signupButton(RaceDetail detail, RacePlan? plan) {
    return Padding(
      padding: const EdgeInsets.symmetric(
          horizontal: StrideTokens.spaceLg, vertical: StrideTokens.spaceSm),
      child: SizedBox(
        width: double.infinity,
        child: OutlinedButton(
          key: const Key('signup-open'),
          style: OutlinedButton.styleFrom(
            foregroundColor: StrideTokens.accent,
            side: const BorderSide(color: StrideTokens.accent),
            shape: const StadiumBorder(),
            padding: const EdgeInsets.symmetric(vertical: 12),
          ),
          onPressed: () => _openSignupSheet(detail),
          child: Text(
            plan == null
                ? '报名：未报名 ▾'
                : planButtonLabel(plan.itemType, plan.state),
            style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs13,
                fontWeight: FontWeight.w600),
          ),
        ),
      ),
    );
  }

  // ── 三 tab ──────────────────────────────────────────────────────────────

  Widget _tabs() {
    const names = ['概要', '项目', '出行'];
    return Container(
      margin: const EdgeInsets.symmetric(
          horizontal: StrideTokens.spaceLg, vertical: StrideTokens.spaceSm),
      decoration: const BoxDecoration(
          border: Border(bottom: BorderSide(color: StrideTokens.border2))),
      child: Row(
        children: [
          for (var i = 0; i < names.length; i++)
            Expanded(
              child: InkWell(
                key: Key('race-detail-tab-$i'),
                onTap: () => setState(() => _tab = i),
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 10),
                  decoration: BoxDecoration(
                    border: Border(
                      bottom: BorderSide(
                        width: 2,
                        color: _tab == i
                            ? StrideTokens.accent
                            : Colors.transparent,
                      ),
                    ),
                  ),
                  child: Text(names[i],
                      textAlign: TextAlign.center,
                      style: TextStyle(
                          fontFamily: AppTypography.fontSans,
                          fontSize: StrideTokens.fs13,
                          fontWeight:
                              _tab == i ? FontWeight.w600 : FontWeight.w400,
                          color: _tab == i
                              ? StrideTokens.accent
                              : StrideTokens.muted)),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _card({required Widget child}) => Container(
        width: double.infinity,
        margin: const EdgeInsets.symmetric(
            horizontal: StrideTokens.spaceLg, vertical: StrideTokens.spaceSm),
        padding: const EdgeInsets.all(StrideTokens.spaceMd),
        decoration: BoxDecoration(
          color: StrideTokens.surface,
          borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
          border: Border.all(color: StrideTokens.border2),
        ),
        child: child,
      );

  Widget _kv(RaceKvRow row, {bool dim = false}) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 64,
              child: Text(row.k,
                  style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs12,
                      color: StrideTokens.muted)),
            ),
            const SizedBox(width: StrideTokens.spaceMd),
            Expanded(
              child: Text(row.v,
                  textAlign: TextAlign.right,
                  style: TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs12,
                      color: dim ? StrideTokens.muted : StrideTokens.fg)),
            ),
          ],
        ),
      );

  Widget _summaryTab(RaceDetail detail) {
    final channels = raceChannelRows(detail.signupChannels);
    return Column(
      children: [
        _card(
            child: Column(
          children: [for (final row in raceSummaryRows(detail)) _kv(row)],
        )),
        if (channels.isNotEmpty)
          _card(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('报名渠道',
                    style: TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs13,
                        fontWeight: FontWeight.w600)),
                const SizedBox(height: 4),
                for (final c in channels)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text('${c.name} · ${c.type}',
                              style: const TextStyle(
                                  fontFamily: AppTypography.fontSans,
                                  fontSize: StrideTokens.fs12,
                                  color: StrideTokens.fgSoft)),
                        ),
                        const SizedBox(width: StrideTokens.spaceMd),
                        if (c.copyUrl.isNotEmpty)
                          InkWell(
                            key: Key('channel-copy-${c.key}'),
                            onTap: () => _copyUrl(c.copyUrl),
                            child: const Text('复制链接',
                                style: TextStyle(
                                    fontFamily: AppTypography.fontSans,
                                    fontSize: StrideTokens.fs12,
                                    color: Color(0xFF3E6FA8))),
                          )
                        else
                          const Text('站内渠道',
                              style: TextStyle(
                                  fontFamily: AppTypography.fontSans,
                                  fontSize: StrideTokens.fs12,
                                  color: StrideTokens.muted2)),
                      ],
                    ),
                  ),
              ],
            ),
          ),
      ],
    );
  }

  Widget _itemsTab(RaceDetail detail) {
    final sections = raceItemSections(detail.items);
    return Column(
      children: [
        for (final s in sections)
          _card(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(s.title,
                    style: const TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs13,
                        fontWeight: FontWeight.w600)),
                for (final row in s.rows) _kv(row),
                _kv(RaceKvRow('赛道', s.route.isEmpty ? '待补' : s.route), dim: s.route.isEmpty),
              ],
            ),
          ),
        if (sections.isEmpty)
          _card(
            child: const Text('暂无项目信息',
                style: TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs12,
                    color: StrideTokens.muted)),
          ),
      ],
    );
  }

  Widget _tripTab(RaceDetail detail) {
    final city = detail.cityContent;
    final paragraphs = city == null || city.intro == null
        ? const <RaceKvRow>[]
        : [
            if (city.intro!.overview.isNotEmpty) RaceKvRow('概览', city.intro!.overview),
            if (city.intro!.culture.isNotEmpty) RaceKvRow('人文', city.intro!.culture),
            if (city.intro!.food.isNotEmpty) RaceKvRow('美食', city.intro!.food),
            if (city.intro!.history.isNotEmpty) RaceKvRow('历史', city.intro!.history),
          ];
    return Column(
      children: [
        _card(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('领物',
                  style: TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs13,
                      fontWeight: FontWeight.w600)),
              const SizedBox(height: 4),
              if (detail.packetPickup.isEmpty)
                const Text('待发布',
                    style: TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs12,
                        color: StrideTokens.muted))
              else
                for (final p in detail.packetPickup)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Text('${p.time} · ${p.location}',
                        style: const TextStyle(
                            fontFamily: AppTypography.fontSans,
                            fontSize: StrideTokens.fs12,
                            color: StrideTokens.fgSoft)),
                  ),
            ],
          ),
        ),
        _card(
          child: city == null
              ? const Text('城市攻略待发布',
                  style: TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs12,
                      color: StrideTokens.muted))
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('城市 · ${city.city}',
                        style: const TextStyle(
                            fontFamily: AppTypography.fontSans,
                            fontSize: StrideTokens.fs13,
                            fontWeight: FontWeight.w600)),
                    const SizedBox(height: 4),
                    for (final p in paragraphs)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 4),
                        child: Text('${p.k}：${p.v}',
                            style: const TextStyle(
                                fontFamily: AppTypography.fontSans,
                                fontSize: StrideTokens.fs12,
                                color: StrideTokens.fgSoft)),
                      ),
                    for (final a in city.attractions)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 4),
                        child: Text('景点 · ${a.name}：${a.description}',
                            style: const TextStyle(
                                fontFamily: AppTypography.fontSans,
                                fontSize: StrideTokens.fs12,
                                color: StrideTokens.fgSoft)),
                      ),
                  ],
                ),
        ),
      ],
    );
  }
}
