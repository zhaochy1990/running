/// 比赛策略报告 /races/:id/strategy —— #420 决议：版本 pills + dirty 确认 /
/// 配速编辑 recomputePaceTimes / 补给增删 / 保存·删除版本 / 海报 /
/// 回教练（pendingCoachMessage 交接）。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/router/routes.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../../data/api/stride_api.dart';
import '../_shared/widgets/top_bar.dart';
import '../coach/providers/coach_chat_provider.dart' show pendingCoachMessageProvider;
import 'models/race_models.dart';
import 'providers/race_providers.dart';
import 'utils/race_rows.dart';
import 'widgets/strategy_poster.dart';

class RaceStrategyScreen extends ConsumerStatefulWidget {
  const RaceStrategyScreen({super.key, required this.raceId});

  final int raceId;

  @override
  ConsumerState<RaceStrategyScreen> createState() => _RaceStrategyScreenState();
}

class _RaceStrategyScreenState extends ConsumerState<RaceStrategyScreen> {
  final _posterKey = GlobalKey();

  int _sel = 0;
  bool _dirty = false;
  bool _saving = false;
  String? _justSavedAt;
  /// 已装载草稿的版本键（target）。
  String? _loadedTarget;
  int _fuelSeq = 0;

  Map<String, dynamic> _baseContent = {};
  List<PaceRow> _paceRows = [];
  List<FuelingRow> _fueling = [];

  /// 控制器池：key 含版本键 + 行稳定标识（index / 补给 seq）。
  /// 版本切换时旧版本条目随 State 存活（数十个小对象，可忽略），
  /// State 卸载统一释放 —— 不做中途延迟释放，杜绝 use-after-dispose。
  final _ctrlPool = <String, TextEditingController>{};

  TextEditingController _ctrl(String key, String init) =>
      _ctrlPool.putIfAbsent(key, () => TextEditingController(text: init));

  @override
  void dispose() {
    for (final c in _ctrlPool.values) {
      c.dispose();
    }
    _ctrlPool.clear();
    super.dispose();
  }

  /// 从版本 content 装载可编辑草稿（同版本重复调用不重建控制器，
  /// 保持用户输入与光标）。
  void _loadDraft(RaceStrategyVersion v) {
    final target = v.targetFinishTime;
    _baseContent = Map<String, dynamic>.of(v.content);
    _paceRows = paceRowsFromContent(v.content);
    _fueling = fuelingRowsFromContent(v.content);
    _fuelSeq = _fueling.fold(0, (m, r) => r.seq > m ? r.seq : m) + 1;
    for (var i = 0; i < _paceRows.length; i++) {
      _ctrl('$target|pace|$i', _paceRows[i].pace);
      _ctrl('$target|note|$i', _paceRows[i].note);
    }
    for (final f in _fueling) {
      _ctrl('$target|fuel-t|${f.seq}', f.timePoint);
      _ctrl('$target|fuel-c|${f.seq}', f.content);
    }
    _loadedTarget = target;
    _dirty = false;
  }

  TextEditingController _paceCtrl(int i) =>
      _ctrl('$_loadedTarget|pace|$i', _paceRows[i].pace);
  TextEditingController _noteCtrl(int i) =>
      _ctrl('$_loadedTarget|note|$i', _paceRows[i].note);
  TextEditingController _fuelTimeCtrl(int i) =>
      _ctrl('$_loadedTarget|fuel-t|${_fueling[i].seq}', _fueling[i].timePoint);
  TextEditingController _fuelContentCtrl(int i) =>
      _ctrl('$_loadedTarget|fuel-c|${_fueling[i].seq}', _fueling[i].content);

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), duration: const Duration(seconds: 2)),
    );
  }

  Future<bool> _confirmDiscard() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('丢弃未保存的修改？'),
        content: const Text('当前版本有未保存的修改，切换后将丢弃。'),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('继续编辑')),
          FilledButton(
              key: const Key('strategy-discard-confirm'),
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('丢弃并切换')),
        ],
      ),
    );
    return ok == true;
  }

  Future<void> _switchVersion(int index) async {
    if (index == _sel) return;
    if (_dirty && !await _confirmDiscard()) return;
    final versions = ref.read(raceStrategiesProvider(widget.raceId)).valueOrNull;
    if (versions == null || index >= versions.length) return;
    setState(() {
      _sel = index;
      _justSavedAt = null;
      _loadDraft(versions[index]);
    });
  }

  void _onPaceChanged(int i, String text) {
    final row = _paceRows[i];
    final pace = parsePaceSPerKm(text);
    // 原型口径：解析失败或超出 2:00–20:00/km 视为非法，回退旧值。
    if (pace == null || pace < 120 || pace > 1200) {
      _toast('配速格式 M:SS（如 4:55）');
      _paceCtrl(i).text = row.pace;
      return;
    }
    setState(() {
      row.pace = text;
      recomputePaceTimes(_paceRows);
      _dirty = true;
      _justSavedAt = null;
    });
  }

  Future<void> _save() async {
    if (!_dirty || _saving) return;
    setState(() => _saving = true);
    try {
      final versions =
          ref.read(raceStrategiesProvider(widget.raceId)).valueOrNull ?? const [];
      final target = versions[_sel].targetFinishTime;
      final content = strategyContentForSave(
        base: _baseContent,
        paceRows: _paceRows,
        fuelingRows: _fueling,
      );
      await ref.read(strideApiProvider).putRaceStrategy(
            widget.raceId,
            itemType: versions[_sel].itemType,
            content: content,
          );
      // 服务端真值回读（排序/updated_at 以 GET 为准）。
      final fresh = await ref.read(strideApiProvider).getRaceStrategies(widget.raceId);
      final idx = fresh.indexWhere((v) => v.targetFinishTime == target);
      setState(() {
        _sel = idx >= 0 ? idx : 0;
        _loadDraft(fresh[_sel]);
        _justSavedAt = _shortDate(fresh[_sel].updatedAt);
        _dirty = false;
      });
      _toast('已保存');
    } catch (_) {
      _toast('保存失败，请稍后重试');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _deleteVersion() async {
    final versions =
        ref.read(raceStrategiesProvider(widget.raceId)).valueOrNull ?? const [];
    if (_sel >= versions.length) return;
    final target = versions[_sel].targetFinishTime;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('删除 $target 版？'),
        content: const Text('其它目标版本不受影响。'),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('取消')),
          FilledButton(
              key: const Key('strategy-delete-confirm'),
              style: FilledButton.styleFrom(
                  backgroundColor: StrideTokens.danger),
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('删除')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await ref.read(strideApiProvider).deleteRaceStrategy(
            widget.raceId,
            target: target,
          );
      final fresh =
          await ref.read(strideApiProvider).getRaceStrategies(widget.raceId);
      if (!mounted) return;
      if (fresh.isEmpty) {
        _toast('策略尚未生成：回详情页和教练聊一聊');
        context.pop();
        return;
      }
      setState(() {
        _sel = 0;
        _justSavedAt = null;
        _loadDraft(fresh.first);
      });
    } catch (_) {
      _toast('删除失败，请稍后重试');
    }
  }

  void _backToCoach(String raceName, String target) {
    ref.read(pendingCoachMessageProvider.notifier).state =
        '我已有一份「$raceName」的比赛策略（目标 $target），想聊聊怎么调整。';
    context.go(Routes.coach);
  }

  Future<void> _exportPoster() async {
    try {
      await exportStrategyPoster(
        _posterKey,
        'stride-strategy-${widget.raceId}-$_sel.png',
      );
    } catch (_) {
      _toast('海报生成失败');
    }
  }

  static String _shortDate(String rfc3339) {
    final d = DateTime.tryParse(rfc3339)?.toLocal();
    if (d == null) return '';
    return '${d.month}/${d.day}';
  }

  @override
  Widget build(BuildContext context) {
    final strategiesAsync = ref.watch(raceStrategiesProvider(widget.raceId));

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        title: '比赛策略',
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new, size: 18),
          onPressed: () => context.pop(),
        ),
      ),
      body: strategiesAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(
          child: Text('加载失败：$e',
              style: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs13,
                  color: StrideTokens.muted)),
        ),
        data: (versions) {
          if (versions.isEmpty) {
            return Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text('策略尚未生成：回详情页和教练聊一聊',
                      style: TextStyle(
                          fontFamily: AppTypography.fontSans,
                          fontSize: StrideTokens.fs13,
                          color: StrideTokens.muted)),
                  const SizedBox(height: StrideTokens.spaceMd),
                  OutlinedButton(
                    onPressed: () => context.pop(),
                    child: const Text('返回详情'),
                  ),
                ],
              ),
            );
          }
          if (_sel >= versions.length) _sel = 0;
          final v = versions[_sel];
          if (_loadedTarget != v.targetFinishTime) {
            // 首次装载或版本切换（同版本重建不重置控制器，保留输入态）。
            _loadDraft(v);
          }
          return _body(versions, v);
        },
      ),
    );
  }

  Widget _body(List<RaceStrategyVersion> versions, RaceStrategyVersion v) {
    final detail =
        ref.watch(raceDetailProvider(widget.raceId)).valueOrNull;
    final raceName = (detail?.displayName.isNotEmpty ?? false)
        ? detail!.displayName
        : (v.content['race_name'] as String? ?? '比赛策略');
    final targetPace = targetPaceLabel(v.targetFinishTime, v.itemType);
    final summary = v.content['summary'] as String? ?? '';

    return Stack(
      clipBehavior: Clip.none,
      children: [
        Column(
          children: [
            Expanded(
              child: ListView(
                padding: const EdgeInsets.only(bottom: StrideTokens.space2xl),
                children: [
                  _pills(versions),
                  _hero(raceName, v, targetPace, summary),
                  _paceTable(),
                  _notesSection(),
                  _fuelingSection(),
                ],
              ),
            ),
            _bottomBar(v, raceName),
          ],
        ),
        // 海报离屏渲染（RepaintBoundary 截图源），画在可视区外仍会被绘制。
        Positioned(
          left: -10000,
          top: 0,
          child: RepaintBoundary(
            key: _posterKey,
            child: StrategyPosterCard(
              data: StrategyPosterData(
                dateLabel: detail?.raceDate ?? '',
                itemLabel: typeAbbr(v.itemType).isNotEmpty
                    ? typeAbbr(v.itemType)
                    : v.itemType,
                raceName: raceName,
                target: v.targetFinishTime,
                rows: [
                  for (final r in _paceRows)
                    (r.segment, r.pace, r.cumulativeTime),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _pills(List<RaceStrategyVersion> versions) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(StrideTokens.spaceLg, 8, StrideTokens.spaceLg, 0),
      child: Wrap(
        spacing: StrideTokens.spaceSm,
        runSpacing: StrideTokens.spaceXs,
        children: [
          for (var i = 0; i < versions.length; i++)
            InkWell(
              key: Key('strategy-pill-$i'),
              borderRadius: BorderRadius.circular(999),
              onTap: () => _switchVersion(i),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(999),
                  border: Border.all(
                      color: i == _sel ? StrideTokens.accent : StrideTokens.border),
                  color: i == _sel ? const Color(0xFFE7F6EE) : Colors.transparent,
                ),
                child: Text(versions[i].targetFinishTime,
                    style: TextStyle(
                        fontFamily: AppTypography.fontMono,
                        fontSize: StrideTokens.fs12,
                        color:
                            i == _sel ? StrideTokens.accent : StrideTokens.muted)),
              ),
            ),
        ],
      ),
    );
  }

  Widget _hero(String raceName, RaceStrategyVersion v, String targetPace, String summary) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(StrideTokens.spaceLg, 6, StrideTokens.spaceLg, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('$raceName · ${typeAbbr(v.itemType).isNotEmpty ? typeAbbr(v.itemType) : v.itemType} · 目标配速',
              style: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs11,
                  color: StrideTokens.muted)),
          Text(targetPace.isEmpty ? '—' : targetPace,
              style: const TextStyle(
                  fontFamily: AppTypography.fontMono,
                  fontSize: 34,
                  fontWeight: FontWeight.w700,
                  color: StrideTokens.accent)),
          if (summary.isNotEmpty)
            Text(summary,
                style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs11,
                    color: StrideTokens.muted)),
        ],
      ),
    );
  }

  Widget _paceTable() {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: StrideTokens.spaceLg),
      child: Column(
        children: [
          Row(
            children: [
              _th('分段', flex: 34),
              _th('配速', flex: 22),
              _th('本段', flex: 22),
              _th('累计', flex: 22),
            ],
          ),
          for (var i = 0; i < _paceRows.length; i++) _paceRowTile(i),
        ],
      ),
    );
  }

  Widget _th(String label, {required int flex}) => Expanded(
        flex: flex,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Text(label,
              style: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs11,
                  color: StrideTokens.muted)),
        ),
      );

  Widget _paceRowTile(int i) {
    final r = _paceRows[i];
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 6),
      decoration: const BoxDecoration(
          border: Border(bottom: BorderSide(color: StrideTokens.border2))),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            flex: 34,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(r.distance,
                    style: const TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs11,
                        fontWeight: FontWeight.w600,
                        color: StrideTokens.fg)),
                if (r.desc.isNotEmpty)
                  Text(r.desc,
                      style: const TextStyle(
                          fontFamily: AppTypography.fontSans,
                          fontSize: 9,
                          color: StrideTokens.muted2)),
              ],
            ),
          ),
          Expanded(
            flex: 22,
            child: TextFormField(
              key: Key('strategy-pace-$i'),
              controller: _paceCtrl(i),
              style: const TextStyle(
                  fontFamily: AppTypography.fontMono,
                  fontSize: StrideTokens.fs11,
                  color: StrideTokens.fg),
              decoration: const InputDecoration(
                isDense: true,
                filled: true,
                fillColor: StrideTokens.grid,
                border: OutlineInputBorder(borderSide: BorderSide.none),
                contentPadding: EdgeInsets.symmetric(horizontal: 4, vertical: 6),
              ),
              onChanged: (t) => _onPaceChanged(i, t),
            ),
          ),
          Expanded(
            flex: 22,
            child: Text(r.segmentTime,
                style: const TextStyle(
                    fontFamily: AppTypography.fontMono,
                    fontSize: StrideTokens.fs11,
                    color: StrideTokens.fg)),
          ),
          Expanded(
            flex: 22,
            child: Text(r.cumulativeTime,
                style: const TextStyle(
                    fontFamily: AppTypography.fontMono,
                    fontSize: StrideTokens.fs11,
                    color: StrideTokens.muted)),
          ),
        ],
      ),
    );
  }

  Widget _notesSection() {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: StrideTokens.spaceLg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.only(top: 10, bottom: 4),
            child: Text('说明（可编辑）',
                style: TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs12,
                    color: StrideTokens.muted)),
          ),
          for (var i = 0; i < _paceRows.length; i++)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: TextFormField(
                key: Key('strategy-note-$i'),
                controller: _noteCtrl(i),
                minLines: 1,
                maxLines: 2,
                style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs11,
                    color: StrideTokens.fgSoft),
                decoration: const InputDecoration(
                  isDense: true,
                  filled: true,
                  fillColor: StrideTokens.grid,
                  border: OutlineInputBorder(borderSide: BorderSide.none),
                  contentPadding: EdgeInsets.symmetric(horizontal: 5, vertical: 6),
                  hintText: '说明（稳住/进站/顶坡…）',
                ),
                onChanged: (t) {
                  _paceRows[i].note = t;
                  _dirty = true;
                  _justSavedAt = null;
                },
              ),
            ),
        ],
      ),
    );
  }

  Widget _fuelingSection() {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: StrideTokens.spaceLg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.only(top: 12, bottom: 4),
            child: Text('补给计划',
                style: TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs12,
                    color: StrideTokens.muted)),
          ),
          for (var i = 0; i < _fueling.length; i++)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 84,
                    child: TextFormField(
                      key: Key('strategy-fuel-time-$i'),
                      controller: _fuelTimeCtrl(i),
                      style: const TextStyle(
                          fontFamily: AppTypography.fontMono,
                          fontSize: StrideTokens.fs11,
                          color: StrideTokens.fg),
                      decoration: const InputDecoration(
                        isDense: true,
                        filled: true,
                        fillColor: StrideTokens.grid,
                        border: OutlineInputBorder(borderSide: BorderSide.none),
                        contentPadding:
                            EdgeInsets.symmetric(horizontal: 5, vertical: 6),
                        hintText: '时间点',
                      ),
                      onChanged: (t) {
                        _fueling[i].timePoint = t;
                        _dirty = true;
                        _justSavedAt = null;
                      },
                    ),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: TextFormField(
                      key: Key('strategy-fuel-content-$i'),
                      controller: _fuelContentCtrl(i),
                      minLines: 1,
                      maxLines: 2,
                      style: const TextStyle(
                          fontFamily: AppTypography.fontSans,
                          fontSize: StrideTokens.fs11,
                          color: StrideTokens.fg),
                      decoration: const InputDecoration(
                        isDense: true,
                        filled: true,
                        fillColor: StrideTokens.grid,
                        border: OutlineInputBorder(borderSide: BorderSide.none),
                        contentPadding:
                            EdgeInsets.symmetric(horizontal: 5, vertical: 6),
                        hintText: '内容（能量胶 / 水 / 电解质…）',
                      ),
                      onChanged: (t) {
                        _fueling[i].content = t;
                        _dirty = true;
                        _justSavedAt = null;
                      },
                    ),
                  ),
                  InkWell(
                    key: Key('strategy-fuel-del-$i'),
                    onTap: () => setState(() {
                      _fueling.removeAt(i);
                      _dirty = true;
                      _justSavedAt = null;
                    }),
                    child: const Padding(
                      padding: EdgeInsets.symmetric(horizontal: 6, vertical: 8),
                      child: Text('✕',
                          style: TextStyle(
                              fontSize: StrideTokens.fs13,
                              color: StrideTokens.danger)),
                    ),
                  ),
                ],
              ),
            ),
          InkWell(
            key: const Key('strategy-fuel-add'),
            onTap: () => setState(() {
              _fueling.add(FuelingRow(seq: _fuelSeq++, timePoint: '', content: ''));
              _dirty = true;
              _justSavedAt = null;
            }),
            child: const Padding(
              padding: EdgeInsets.symmetric(vertical: 4),
              child: Text('+ 添加一条补给',
                  style: TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs12,
                      color: StrideTokens.accent,
                      fontWeight: FontWeight.w600)),
            ),
          ),
        ],
      ),
    );
  }

  Widget _bottomBar(RaceStrategyVersion v, String raceName) {
    final saveLabel = _saving
        ? '保存中…'
        : _dirty
            ? '保存修改'
            : _justSavedAt != null
                ? '已保存 · $_justSavedAt'
                : '已保存';
    return SafeArea(
      top: false,
      child: Container(
        color: StrideTokens.surface,
        padding: const EdgeInsets.fromLTRB(
            StrideTokens.spaceLg, 8, StrideTokens.spaceLg, 8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                key: const Key('strategy-save'),
                style: FilledButton.styleFrom(
                  backgroundColor:
                      _dirty && !_saving ? StrideTokens.accent : StrideTokens.muted2,
                  foregroundColor: Colors.white,
                  shape: const StadiumBorder(),
                  padding: const EdgeInsets.symmetric(vertical: 12),
                ),
                onPressed: _dirty && !_saving ? _save : null,
                child: Text(saveLabel,
                    style: const TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs13,
                        fontWeight: FontWeight.w600)),
              ),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    key: const Key('strategy-poster'),
                    style: OutlinedButton.styleFrom(
                      foregroundColor: StrideTokens.fgSoft,
                      side: const BorderSide(color: StrideTokens.border),
                      shape: const StadiumBorder(),
                      padding: const EdgeInsets.symmetric(vertical: 10),
                    ),
                    onPressed: _exportPoster,
                    child: const Text('生成配速卡海报',
                        style: TextStyle(
                            fontFamily: AppTypography.fontSans,
                            fontSize: StrideTokens.fs12)),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: OutlinedButton(
                    key: const Key('strategy-to-coach'),
                    style: OutlinedButton.styleFrom(
                      foregroundColor: StrideTokens.fgSoft,
                      side: const BorderSide(color: StrideTokens.border),
                      shape: const StadiumBorder(),
                      padding: const EdgeInsets.symmetric(vertical: 10),
                    ),
                    onPressed: () =>
                        _backToCoach(raceName, v.targetFinishTime),
                    child: const Text('回教练调整',
                        style: TextStyle(
                            fontFamily: AppTypography.fontSans,
                            fontSize: StrideTokens.fs12)),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: OutlinedButton(
                    key: const Key('strategy-delete'),
                    style: OutlinedButton.styleFrom(
                      foregroundColor: StrideTokens.danger,
                      side: const BorderSide(color: StrideTokens.border),
                      shape: const StadiumBorder(),
                      padding: const EdgeInsets.symmetric(vertical: 10),
                    ),
                    onPressed: _deleteVersion,
                    child: const Text('删除版本',
                        style: TextStyle(
                            fontFamily: AppTypography.fontSans,
                            fontSize: StrideTokens.fs12)),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
