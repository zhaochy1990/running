/// 赛事域 providers —— 密表（年份×省份整年拉取 + 请求序号 + 收藏三防）、
/// 详情、参赛计划（乐观 patch 同源不漂移 + 失败回滚）、策略版本、成绩。
/// 交互语义逐条对应 #420 决议 / 小程序 race-center.ts。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../../../shared/utils/shanghai_date.dart';
import '../models/race_models.dart';
import '../utils/race_rows.dart';

final _apiProvider = Provider<StrideApi>((ref) => ref.watch(strideApiProvider));

// ── 密表 ─────────────────────────────────────────────────────────────────────

/// 筛选栏的项目类型选项：''=全部。
const List<(String, String)> raceTypeOptions = [
  ('全部', ''),
  ('全马', 'Marathon'),
  ('半马', 'HalfMarathon'),
  ('10K', '10Km'),
];

const int _perPage = 100;

/// 翻页兜底：50 页 × 100 场，防 total 异常死循环。
const int _maxPages = 50;

class RaceCenterState {
  const RaceCenterState({
    this.loading = true,
    this.error,
    this.groups = const [],
    this.viewCount = 0,
    this.emptyText = '',
    required this.year,
    this.type = '',
    this.province = '',
    this.favOnly = false,
    this.pendingStars = const {},
  });

  final bool loading;
  /// 静默刷新失败时保留旧列表，banner 提示；首拉失败为整页错误。
  final String? error;
  final List<RaceMonthGroup> groups;
  final int viewCount;
  final String emptyText;
  final String year;
  final String type;
  final String province;
  final bool favOnly;
  final Set<int> pendingStars;

  RaceCenterState copyWith({
    bool? loading,
    String? error,
    bool clearError = false,
    List<RaceMonthGroup>? groups,
    int? viewCount,
    String? emptyText,
    String? year,
    String? type,
    String? province,
    bool? favOnly,
    Set<int>? pendingStars,
  }) =>
      RaceCenterState(
        loading: loading ?? this.loading,
        error: clearError ? null : (error ?? this.error),
        groups: groups ?? this.groups,
        viewCount: viewCount ?? this.viewCount,
        emptyText: emptyText ?? this.emptyText,
        year: year ?? this.year,
        type: type ?? this.type,
        province: province ?? this.province,
        favOnly: favOnly ?? this.favOnly,
        pendingStars: pendingStars ?? this.pendingStars,
      );
}

class RaceCenterNotifier extends StateNotifier<RaceCenterState> {
  RaceCenterNotifier(this._api) : super(RaceCenterState(year: shanghaiToday().substring(0, 4)));

  final StrideApi _api;

  /// 当前视图（年份×省份）已拉到的整年数据；provider 销毁即弃，不跨页缓存
  /// （每次进入重拉服务端真值，收藏星标跨页同步的前提）。
  List<RaceSummary> _rows = const [];
  String _rowsKey = '';
  String _fetchingKey = '';
  int _fetchSeq = 0;

  /// 拉取（或静默重拉）当前 年份×省份 的整年数据。同键在途只发一次；
  /// 已有同键数据时旧列表先行（silent），不闪屏。
  Future<void> refresh() async {
    final year = state.year;
    final province = state.province;
    final key = '$year|${province.isEmpty ? 'all' : province}';
    if (_fetchingKey == key) return;
    _fetchingKey = key;
    final seq = ++_fetchSeq;

    final silent = _rowsKey == key && _rows.isNotEmpty;
    if (!silent) state = state.copyWith(loading: true, clearError: true);
    try {
      final rows = await _fetchYear(year, province);
      if (seq != _fetchSeq) return; // 已被更新的请求取代：本响应作废
      _fetchingKey = '';
      _rows = rows;
      _rowsKey = key;
      state = state.copyWith(loading: false, clearError: true);
      _applyView();
    } catch (e) {
      if (seq != _fetchSeq) return;
      _fetchingKey = '';
      const msg = '加载失败，请稍后重试';
      if (silent) {
        state = state.copyWith(loading: false, error: msg);
      } else {
        state = state.copyWith(
          loading: false,
          error: msg,
          groups: const [],
          viewCount: 0,
          emptyText: '',
        );
      }
    }
  }

  Future<List<RaceSummary>> _fetchYear(String year, String province) async {
    final out = <RaceSummary>[];
    for (var page = 1; page <= _maxPages; page++) {
      final res = await _api.getRaceCalendar(
        year: year,
        province: province.isEmpty ? null : province,
        scope: 'all',
        page: page,
        perPage: _perPage,
      );
      out.addAll(res.races);
      if (res.races.isEmpty || out.length >= res.total) break;
    }
    return out;
  }

  /// 用当前筛选重算 分组/计数/空态（数据在 _rows，纯同步）。
  void _applyView() {
    final year = state.year;
    final favOnly = state.favOnly;
    // 默认视图只看即将开跑；收藏视图与往年看整年（往年 upcoming 恒空）。
    final today = shanghaiToday();
    final floor = !favOnly && year.compareTo(today.substring(0, 4)) >= 0 ? today : '';
    var rows = floor.isNotEmpty
        ? _rows.where((r) => r.raceDate.compareTo(floor) >= 0).toList()
        : _rows;
    rows = rows
        .where((r) =>
            matchesRaceFilter(r, type: state.type, favoritesOnly: favOnly))
        .toList();
    final groups = groupRacesByMonth(rows);

    var emptyText = '';
    if (groups.isEmpty) {
      if (_rows.isEmpty) {
        emptyText = state.province.isNotEmpty
            ? '${state.province}暂无已发布赛事 · 换个省份或下拉刷新'
            : '$year 年暂无已发布赛事 · 下拉刷新';
      } else if (favOnly && state.type.isEmpty && state.province.isEmpty) {
        emptyText = '还没有收藏的赛事 · 退出收藏筛选后点 ☆ 收藏';
      } else {
        emptyText = '当前筛选下没有赛事 · 换个条件试试';
      }
    }
    state = state.copyWith(groups: groups, viewCount: rows.length, emptyText: emptyText);
  }

  void setYear(String year) {
    if (year == state.year) return;
    state = state.copyWith(year: year);
    refresh();
  }

  void setType(String type) {
    state = state.copyWith(type: type);
    _applyView();
  }

  void setProvince(String province) {
    if (province == state.province) return;
    state = state.copyWith(province: province);
    refresh();
  }

  void setFavOnly(bool v) {
    state = state.copyWith(favOnly: v);
    _applyView();
  }

  /// 行尾星标：乐观更新，服务端结果为准，失败回滚（_pendingStars 防连点）。
  Future<void> toggleStar(int id) async {
    if (state.pendingStars.contains(id)) return;
    final idx = _rows.indexWhere((r) => r.id == id);
    if (idx < 0) return;
    final row = _rows[idx];
    final next = !row.favorited;

    state = state.copyWith(pendingStars: {...state.pendingStars, id});
    _rows[idx] = row.copyWith(favorited: next);
    _applyView();

    try {
      final favorited = await _api.toggleRaceFavorite(id);
      _rows[idx] = _rows[idx].copyWith(favorited: favorited);
      _applyView();
    } catch (_) {
      _rows[idx] = _rows[idx].copyWith(favorited: !next);
      _applyView();
      state = state.copyWith(error: '收藏操作失败');
      rethrow;
    } finally {
      final stars = {...state.pendingStars}..remove(id);
      state = state.copyWith(pendingStars: stars);
    }
  }
}

final raceCenterProvider =
    StateNotifierProvider.autoDispose<RaceCenterNotifier, RaceCenterState>(
  (ref) => RaceCenterNotifier(ref.watch(_apiProvider)),
);

// ── 详情 ─────────────────────────────────────────────────────────────────────

final raceDetailProvider =
    FutureProvider.autoDispose.family<RaceDetail, int>((ref, raceId) async {
  return ref.watch(_apiProvider).getRaceDetail(raceId);
});

/// 详情页/报告页的策略版本列表（最快目标在前）。
final raceStrategiesProvider =
    FutureProvider.autoDispose.family<List<RaceStrategyVersion>, int>(
        (ref, raceId) async {
  return ref.watch(_apiProvider).getRaceStrategies(raceId);
});

// ── 参赛计划（乐观更新）─────────────────────────────────────────────────────

class RacePlansState {
  const RacePlansState({
    this.loading = true,
    this.error,
    this.plans = const [],
  });

  final bool loading;
  final String? error;
  final List<RacePlan> plans;

  RacePlansState copyWith({
    bool? loading,
    String? error,
    bool clearError = false,
    List<RacePlan>? plans,
  }) =>
      RacePlansState(
        loading: loading ?? this.loading,
        error: clearError ? null : (error ?? this.error),
        plans: plans ?? this.plans,
      );
}

class RacePlansNotifier extends StateNotifier<RacePlansState> {
  RacePlansNotifier(this._api) : super(const RacePlansState());

  final StrideApi _api;

  Future<void> load() async {
    state = state.copyWith(loading: true, clearError: true);
    try {
      final plans = await _api.getRacePlans();
      state = state.copyWith(loading: false, plans: plans, clearError: true);
    } catch (e) {
      state = state.copyWith(loading: false, error: e.toString());
    }
  }

  RacePlan? planFor(int raceId) {
    for (final p in state.plans) {
      if (p.raceId == raceId) return p;
    }
    return null;
  }

  /// 报名选择器提交：none → DELETE（404 按取消收尾）；其余 → PUT。
  Future<void> submitSignup({
    required int raceId,
    required String option, // planStateOptions 的 value
    required String itemType,
  }) async {
    if (option == 'none') {
      await _patchOptimistic(raceId,
          remove: true, action: () => _api.deleteRacePlan(raceId));
    } else {
      final existing = planFor(raceId);
      // hotel/transit 缺省 = 后端保留存储值（勿误清另一项）。
      await _patchOptimistic(
        raceId,
        transform: existing == null
            ? null
            : (p) => p.copyWith(itemType: itemType, state: option),
        action: () =>
            _api.putRacePlan(raceId, itemType: itemType, state: option),
      );
    }
  }

  /// 状态 chips 流转（want→registered→won→confirmed；lost 旁路也走这里）。
  Future<void> changeState(int raceId, String next) async {
    final plan = planFor(raceId);
    if (plan == null || plan.state == next) return;
    await _patchOptimistic(
      raceId,
      transform: (p) => p.copyWith(state: next),
      action: () => _api.putRacePlan(
        raceId,
        itemType: plan.itemType,
        state: next,
      ),
    );
  }

  /// 酒店/行程勾选：显式覆盖两个布尔（另一项带当前值，不误清）。
  Future<void> setTrip(int raceId, {required bool hotel, required bool transit}) async {
    final plan = planFor(raceId);
    if (plan == null) return;
    await _patchOptimistic(
      raceId,
      transform: (p) => p.copyWith(hotel: hotel, transit: transit),
      action: () => _api.putRacePlan(
        raceId,
        itemType: plan.itemType,
        state: plan.state,
        hotel: hotel,
        transit: transit,
      ),
    );
  }

  /// 乐观 patch：先按 transform 改本地（与视图模型同源不漂移），写服务端成功
  /// 后静默回读真值；失败回滚到快照并 rethrow（调用方 toast）。
  Future<void> _patchOptimistic(
    int raceId, {
    RacePlan Function(RacePlan)? transform,
    required Future<void> Function() action,
    bool remove = false,
  }) async {
    final snapshot = state.plans;
    final List<RacePlan> patched;
    if (remove) {
      patched = snapshot.where((p) => p.raceId != raceId).toList();
    } else {
      patched = [
        for (final p in snapshot)
          if (p.raceId == raceId && transform != null) transform(p) else p,
      ];
    }
    state = state.copyWith(plans: patched, clearError: true);
    try {
      await action();
      final plans = await _api.getRacePlans();
      if (mounted) state = state.copyWith(plans: plans, clearError: true);
    } catch (e) {
      if (mounted) state = state.copyWith(plans: snapshot, error: '操作失败，已还原');
      rethrow;
    }
  }
}

final racePlansProvider =
    StateNotifierProvider.autoDispose<RacePlansNotifier, RacePlansState>(
  (ref) => RacePlansNotifier(ref.watch(_apiProvider)),
);

// ── 我的成绩 ────────────────────────────────────────────────────────────────

final raceResultsProvider = FutureProvider.autoDispose<List<UserRace>>((ref) async {
  final userId = ref.watch(currentUserIdProvider);
  if (userId == null) throw Exception('用户未登录');
  return ref.watch(_apiProvider).getUserRaces(userId);
});
