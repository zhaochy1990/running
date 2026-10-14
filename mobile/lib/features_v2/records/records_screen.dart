/// 记录 tab（/records）—— 活动列表：月份折叠分组（本月展开）、月度汇总、
/// 分页加载（100/页）、下拉刷新；行点击进 /records/activity/:id。
/// 对齐小程序 pages/activities 的信息结构（视觉按 App 亮色 tokens）。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/current_user.dart';
import '../../core/router/routes.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../../data/api/stride_api.dart';
import '../../data/models/activity.dart';
import '../../shared/utils/format.dart';
import '../../shared/utils/shanghai_date.dart';
import '../_shared/widgets/top_bar.dart';

const _pageSize = 100;

class RecordsScreen extends ConsumerStatefulWidget {
  const RecordsScreen({super.key});

  @override
  ConsumerState<RecordsScreen> createState() => _RecordsScreenState();
}

class _RecordsScreenState extends ConsumerState<RecordsScreen> {
  final _scroll = ScrollController();
  final _activities = <Activity>[];
  final _summaries = <String, MonthlySummary>{};
  bool _loading = false;
  bool _loadingMore = false;
  bool _exhausted = false;
  Object? _error;

  /// 折叠的月份集合（对齐小程序：默认只展开本月，历史月折叠）。
  final _collapsedMonths = <String>{};
  final _seenMonths = <String>{};

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
    _load();
  }

  @override
  void dispose() {
    _scroll.removeListener(_onScroll);
    _scroll.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (_scroll.position.pixels >=
        _scroll.position.maxScrollExtent - 400) {
      _loadMore();
    }
  }

  Future<void> _load() async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final api = ref.read(strideApiProvider);
      final userId = ref.read(currentUserIdProvider);
      if (userId == null) throw Exception('用户未登录');
      final page =
          await api.listActivitiesPage(userId, limit: _pageSize, offset: 0);
      if (!mounted) return;
      setState(() {
        _activities
          ..clear()
          ..addAll(page.activities);
        _summaries
          ..clear()
          ..addAll(page.monthlySummaries);
        _exhausted = page.activities.length < _pageSize;
        _applyDefaultCollapse();
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e;
      });
    }
  }

  /// 首屏默认只展开本月（上海）；历史月全部折叠。刷新时保留用户的展开状态。
  void _applyDefaultCollapse() {
    final currentMonth = shanghaiToday().substring(0, 7);
    for (final a in _activities) {
      final date = shanghaiDateFromIso(a.date);
      final month = date.isEmpty ? '未知' : date.substring(0, 7);
      if (_seenMonths.add(month) && month != currentMonth) {
        _collapsedMonths.add(month);
      }
    }
  }

  Future<void> _loadMore() async {
    if (_loadingMore || _loading || _exhausted || _error != null) return;
    setState(() => _loadingMore = true);
    try {
      final api = ref.read(strideApiProvider);
      final userId = ref.read(currentUserIdProvider);
      final page = await api.listActivitiesPage(
        userId!,
        limit: _pageSize,
        offset: _activities.length,
      );
      if (!mounted) return;
      setState(() {
        _activities.addAll(page.activities);
        _summaries.addAll(page.monthlySummaries);
        _exhausted = page.activities.length < _pageSize;
        _applyDefaultCollapse();
        _loadingMore = false;
      });
    } catch (_) {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: const StrideTopBar(title: '活动记录'),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_loading && _activities.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null && _activities.isEmpty) {
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
            TextButton(onPressed: _load, child: const Text('重试')),
          ],
        ),
      );
    }
    if (_activities.isEmpty) {
      return RefreshIndicator(
        color: StrideTokens.accent,
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: const [
            SizedBox(height: 160),
            Center(
              child: Text(
                '还没有活动记录\n完成第一次跑步后同步手表数据',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs14,
                  color: StrideTokens.muted,
                  height: 1.6,
                ),
              ),
            ),
          ],
        ),
      );
    }

    final sections = _group();
    return RefreshIndicator(
      color: StrideTokens.accent,
      onRefresh: _load,
      child: ListView.builder(
        controller: _scroll,
        physics: const AlwaysScrollableScrollPhysics(),
        itemCount: sections.length + (_loadingMore ? 1 : 0),
        itemBuilder: (context, i) {
          if (i >= sections.length) {
            return const Padding(
              padding: EdgeInsets.all(StrideTokens.spaceLg),
              child: Center(
                child: SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              ),
            );
          }
          return _MonthSection(
            section: sections[i],
            collapsed: _collapsedMonths.contains(sections[i].month),
            onToggle: () => setState(() {
              final m = sections[i].month;
              if (!_collapsedMonths.remove(m)) _collapsedMonths.add(m);
            }),
            onTapActivity: (id) =>
                context.push(Routes.activityDetail(id)),
          );
        },
      ),
    );
  }

  // ── 月份分组（API 返回按时间倒序，分组保持该顺序）──────────────────────────

  List<_MonthGroup> _group() {
    final groups = <String, List<Activity>>{};
    final order = <String>[];
    for (final a in _activities) {
      final date = shanghaiDateFromIso(a.date);
      final month = date.isEmpty ? '未知' : date.substring(0, 7);
      if (!groups.containsKey(month)) {
        groups[month] = [];
        order.add(month);
      }
      groups[month]!.add(a);
    }
    return [
      for (final month in order)
        _MonthGroup(
          month: month,
          activities: groups[month]!,
          summary: _summaries[month],
        ),
    ];
  }
}

class _MonthGroup {
  const _MonthGroup({
    required this.month,
    required this.activities,
    this.summary,
  });

  final String month; // YYYY-MM
  final List<Activity> activities;

  /// 后端整月聚合（monthly_summaries，不只本页）；缺失时回退本页行求和。
  final MonthlySummary? summary;

  String get title {
    if (month == '未知') return month;
    return '${int.parse(month.substring(0, 4))}年${int.parse(month.substring(5))}月';
  }

  int get count => summary?.activityCount ?? activities.length;

  num get totalDistanceM =>
      summary != null && summary!.totalRunKm > 0
          ? summary!.totalRunKm * 1000
          : activities.fold(0, (sum, a) => sum + a.distanceM);

  int get totalDurationS {
    final s = summary?.durationS;
    if (s != null && s > 0) return s.round();
    return activities.fold(0, (sum, a) => sum + a.durationS);
  }
}

class _MonthSection extends StatelessWidget {
  const _MonthSection({
    required this.section,
    required this.collapsed,
    required this.onToggle,
    required this.onTapActivity,
  });

  final _MonthGroup section;
  final bool collapsed;
  final VoidCallback onToggle;
  final ValueChanged<String> onTapActivity;

  @override
  Widget build(BuildContext context) {
    final km = (section.totalDistanceM / 1000).toStringAsFixed(1);
    final min = (section.totalDurationS / 60).round();
    return Column(
      children: [
        InkWell(
          onTap: onToggle,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(
              StrideTokens.spaceLg,
              StrideTokens.spaceMd,
              StrideTokens.spaceLg,
              StrideTokens.spaceSm,
            ),
            child: Row(
              children: [
                Text(
                  section.title,
                  style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs14,
                    fontWeight: FontWeight.w700,
                    color: StrideTokens.fg,
                  ),
                ),
                const SizedBox(width: StrideTokens.spaceMd),
                Text(
                  '${section.count}次 · ${km}km · ${min}min',
                  style: const TextStyle(
                    fontFamily: AppTypography.fontMono,
                    fontSize: StrideTokens.fs11,
                    color: StrideTokens.muted,
                  ),
                ),
                const Spacer(),
                Icon(
                  collapsed
                      ? Icons.expand_more
                      : Icons.expand_less,
                  size: 18,
                  color: StrideTokens.muted,
                ),
              ],
            ),
          ),
        ),
        if (!collapsed)
          Container(
            margin: const EdgeInsets.fromLTRB(
              StrideTokens.spaceLg,
              0,
              StrideTokens.spaceLg,
              StrideTokens.spaceMd,
            ),
            decoration: BoxDecoration(
              color: StrideTokens.surface,
              borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
              border: Border.all(color: StrideTokens.border2),
            ),
            child: Column(
              children: [
                for (var i = 0; i < section.activities.length; i++) ...[
                  if (i > 0)
                    const Divider(
                      height: 1,
                      indent: StrideTokens.spaceLg,
                      endIndent: StrideTokens.spaceLg,
                      color: StrideTokens.border2,
                    ),
                  _ActivityListRow(
                    activity: section.activities[i],
                    onTap: () => onTapActivity(
                      section.activities[i].labelId,
                    ),
                  ),
                ],
              ],
            ),
          ),
      ],
    );
  }
}

class _ActivityListRow extends StatelessWidget {
  const _ActivityListRow({required this.activity, required this.onTap});

  final Activity activity;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final a = activity;
    final date = shanghaiDateFromIso(a.date);
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: StrideTokens.spaceLg,
          vertical: StrideTokens.spaceMd,
        ),
        child: Row(
          children: [
            // 缩略图（route_thumbnails pipeline 的 COS 公网 URL），
            // 加载失败/缺失回退运动图标（容错）。
            SizedBox(
              width: 36,
              height: 36,
              child: (a.thumbUrl?.isNotEmpty ?? false)
                  ? ClipRRect(
                      borderRadius:
                          BorderRadius.circular(StrideTokens.radiusMd),
                      child: Image.network(
                        a.thumbUrl!,
                        fit: BoxFit.cover,
                        errorBuilder: (_, _, _) => _SportIcon(activity: a),
                      ),
                    )
                  : _SportIcon(activity: a),
            ),
            const SizedBox(width: StrideTokens.spaceMd),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    (a.name?.isNotEmpty ?? false) ? a.name! : (a.sportName ?? ''),
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs14,
                      fontWeight: FontWeight.w600,
                      color: StrideTokens.fg,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '${date.isEmpty ? '' : '${int.parse(date.substring(5, 7))}月${int.parse(date.substring(8))}日 · '}${(a.distanceM / 1000).toStringAsFixed(2)}km · ${durationFmt(a.durationS)}',
                    style: const TextStyle(
                      fontFamily: AppTypography.fontMono,
                      fontSize: StrideTokens.fs12,
                      color: StrideTokens.muted,
                    ),
                  ),
                ],
              ),
            ),
            if (a.avgPaceSKm != null && a.avgPaceSKm! > 0)
              Text(
                paceFmt(a.avgPaceSKm!),
                style: const TextStyle(
                  fontFamily: AppTypography.fontMono,
                  fontSize: StrideTokens.fs13,
                  color: StrideTokens.fgSoft,
                ),
              ),
            const SizedBox(width: StrideTokens.spaceXs),
            const Icon(Icons.chevron_right, size: 16, color: StrideTokens.muted),
          ],
        ),
      ),
    );
  }
}

class _SportIcon extends StatelessWidget {
  const _SportIcon({required this.activity});

  final Activity activity;

  @override
  Widget build(BuildContext context) {
    return Container(
      alignment: Alignment.center,
      decoration: const BoxDecoration(
        color: StrideTokens.accentFg,
        shape: BoxShape.circle,
      ),
      child: Icon(
        (activity.sportName ?? '').toLowerCase().contains('strength')
            ? Icons.fitness_center
            : Icons.directions_run,
        size: 18,
        color: StrideTokens.accent,
      ),
    );
  }
}
