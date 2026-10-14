/// Issue 463 走查驱动 —— /records 列表页 + 活动详情（轨迹地图/曲线/圈表）。
///
/// 真实 tap 驱动，直连生产 API（App 默认 Env）。凭据经 --dart-define 注入，
/// 不入库；未注入时整组用例 skip。截图由外部 `xcrun simctl io booted
/// screenshot` 定时捕获（测试在关键点打印 CHECKPOINT 并停留）。
///
/// 已有会话（含过期 token）：先从「我」页退出登录再走完整登录，避免
/// Keychain 残留的旧会话把列表打回 401。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:stride/app.dart';

const _email = String.fromEnvironment('WALKTHROUGH_EMAIL');
const _password = String.fromEnvironment('WALKTHROUGH_PASSWORD');

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets('463 走查：登录 → 记录列表 → 活动详情（地图/曲线/圈表）', (tester) async {
    debugPrint('[463] CHECKPOINT: app-start');
    await tester.pumpWidget(const ProviderScope(child: StrideApp()));
    await tester.pumpAndSettle(const Duration(seconds: 3));
    _shot('app-start');

    // 已有会话：先验证列表能否加载；加载失败才退出重登（避免频登触发
    // auth-service 限流）。
    var needLogin = !_hasShell(tester);
    if (!needLogin) {
      await tester.tap(find.text('记录').last);
      final loaded = await _waitRecordsLoaded(tester, const Duration(seconds: 12));
      needLogin = !loaded;
    }
    if (needLogin) {
      if (_hasShell(tester)) {
        await _logout(tester);
      }
      await _login(tester);
      await tester.pumpAndSettle(const Duration(seconds: 3));
      expect(_hasShell(tester), isTrue, reason: '登录后应进入 4-tab shell');
    }

    // 关掉可能出现的「发现新版本」弹层。
    await _dismissUpdateSheet(tester);

    // ── /records 列表页 ──────────────────────────────────────────────
    debugPrint('[463] CHECKPOINT: records-list');
    await tester.tap(find.text('记录').last);
    final ok = await _waitRecordsLoaded(tester, const Duration(seconds: 25));
    _shot('records-list');
    expect(ok, isTrue, reason: '月份汇总头应渲染（25s 内）');
    // 本月展开：应能看到活动行（日期 · km · 时长）。月份头也含「km · 」，
    // 用谓词排除（头含「次 · 」）。
    final rows = find.byWidgetPredicate(
      (w) =>
          w is Text &&
          w.data != null &&
          w.data!.contains('km · ') &&
          !w.data!.contains('次 · '),
    );
    expect(rows, findsWidgets, reason: '本月（默认展开）应直接可见活动行');

    // 展开一个历史月份（若有；9 月次之，数据量适中）。
    final headers = find.byWidgetPredicate(
      (w) =>
          w is Text &&
          RegExp(r'^\d{4}年\d+月$').hasMatch(w.data ?? ''),
    );
    if (headers.evaluate().length > 1) {
      await tester.tap(headers.at(1));
      await _settleFor(tester, const Duration(seconds: 1));
      debugPrint('[463] CHECKPOINT: month-expanded');
      _shot('records-month-expanded');
    }

    // 下拉刷新。
    await tester.drag(find.byType(Scrollable).first, const Offset(0, 400));
    await _settleFor(tester, const Duration(seconds: 4));
    debugPrint('[463] CHECKPOINT: records-refreshed');
    _shot('records-refreshed');

    // ── 活动详情 ─────────────────────────────────────────────────────
    debugPrint('[463] CHECKPOINT: activity-detail');
    final detailOk = await _openFirstDetail(tester, rows);
    expect(detailOk, isTrue, reason: '点击活动行应进入详情页');

    // 轨迹地图卡：着色切换条在位（<20 GPS 点时为「暂无轨迹数据」占位）。
    final hasMapCard = find.text('配速').evaluate().isNotEmpty ||
        find.text('暂无轨迹数据').evaluate().isNotEmpty;
    expect(hasMapCard, isTrue, reason: '详情页应有轨迹地图卡或占位');
    await _settleFor(tester, const Duration(seconds: 5));
    _shot('detail-map-pace');

    // 三色模式切换（真实 tap）：无色 → 心率 → 配速。
    if (find.text('无色').evaluate().isNotEmpty) {
      await tester.tap(find.text('无色'));
      await _settleFor(tester, const Duration(seconds: 3));
      _shot('detail-map-none');
      await tester.tap(find.text('心率').last);
      await _settleFor(tester, const Duration(seconds: 3));
      _shot('detail-map-hr');
      await tester.tap(find.text('配速').first);
      await _settleFor(tester, const Duration(seconds: 3));
    }

    // 曲线卡（配速/心率）滚动到可视区。
    await _scrollUntil(tester, find.text('最快').first);
    _shot('detail-charts');

    // 圈速表（或力量分组）滚到可视区。
    await _scrollUntil(tester, find.text('圈'));
    _shot('detail-laps');
    // 留给外部截图循环的收尾停留。
    await _settleFor(tester, const Duration(seconds: 12));
    _shot('detail-laps-end');
  }, skip: _email.isEmpty || _password.isEmpty);
}

/// 点开列表第一行并等详情标题/指标出现（最多 15s）。
Future<bool> _openFirstDetail(WidgetTester tester, Finder rows) async {
  final metric = find.text('距离 / KM');
  for (var attempt = 0; attempt < 2; attempt++) {
    if (rows.evaluate().isEmpty) return false;
    await tester.tap(rows.first);
    final deadline = DateTime.now().add(const Duration(seconds: 12));
    while (DateTime.now().isBefore(deadline)) {
      await tester.pump(const Duration(milliseconds: 300));
      await Future<void>.delayed(const Duration(milliseconds: 200));
      if (metric.evaluate().isNotEmpty) return true;
    }
    // 没进详情（行可点区域被折叠切换吃掉）→ 回列表重试一次。
    if (find.text('活动记录').evaluate().isEmpty) return false;
  }
  return false;
}

Future<bool> _waitRecordsLoaded(WidgetTester tester, Duration timeout) async {
  final summaryHead = find.textContaining('次 · ');
  final failed = find.text('加载失败');
  final deadline = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(deadline)) {
    await tester.pump(const Duration(milliseconds: 300));
    await Future<void>.delayed(const Duration(milliseconds: 200));
    if (summaryHead.evaluate().isNotEmpty) return true;
    if (failed.evaluate().isNotEmpty) return false;
  }
  return summaryHead.evaluate().isNotEmpty;
}

bool _hasShell(WidgetTester tester) =>
    find.text('训练').evaluate().isNotEmpty &&
    find.text('记录').evaluate().isNotEmpty;

Future<void> _logout(WidgetTester tester) async {
  await tester.tap(find.text('我'));
  await _settleFor(tester, const Duration(seconds: 2));
  final logout = find.text('退出登录');
  for (var i = 0; i < 20 && logout.evaluate().isEmpty; i++) {
    await tester.drag(find.byType(Scrollable).first, const Offset(0, -300));
    await tester.pump(const Duration(milliseconds: 200));
  }
  if (logout.evaluate().isEmpty) return;
  await tester.tap(logout.last);
  await _settleFor(tester, const Duration(seconds: 2));
  // 确认弹层（AlertDialog：取消 / 退出）。
  final confirm = find.text('退出');
  if (confirm.evaluate().isNotEmpty) {
    await tester.tap(confirm.last);
    await _settleFor(tester, const Duration(seconds: 3));
  }
}

Future<void> _login(WidgetTester tester) async {
  await tester.tap(find.text('登录').first);
  await _settleFor(tester, const Duration(seconds: 2));

  await tester.tap(find.byKey(const Key('login-tab-1')));
  await tester.pumpAndSettle();
  await tester.enterText(find.byKey(const Key('login-email')), _email);
  await tester.enterText(find.byKey(const Key('login-password')), _password);
  await tester.tap(find.byKey(const Key('login-agree')));
  await tester.pumpAndSettle();
  // 收起键盘，避免系统键盘遮住提交按钮的命中区域。
  tester.testTextInput.closeConnection();
  await tester.pumpAndSettle();
  debugPrint('[463] CHECKPOINT: login-filled');
  final submit = find.widgetWithText(FilledButton, '登录');
  expect(submit, findsOneWidget, reason: '登录提交按钮应唯一且在树上');
  await tester.tap(submit);
  debugPrint('[463] CHECKPOINT: login-submitting');
  // 登录走真实生产 API，轮询等待 shell（最多 40s）。
  final deadline = DateTime.now().add(const Duration(seconds: 40));
  while (DateTime.now().isBefore(deadline)) {
    await tester.pump(const Duration(seconds: 1));
    if (_hasShell(tester)) return;
  }
}

Future<void> _dismissUpdateSheet(WidgetTester tester) async {
  if (find.text('发现新版本').evaluate().isNotEmpty) {
    await tester.tap(find.text('稍后'));
    await tester.pumpAndSettle();
  }
}

/// integration 测试里 pumpAndSettle 会被持续动画/平台视图卡住，
/// 用「真实时间轮询 + 短 pump」等待网络与渲染落地。
Future<void> _settleFor(WidgetTester tester, Duration d) async {
  final deadline = DateTime.now().add(d);
  while (DateTime.now().isBefore(deadline)) {
    await tester.pump(const Duration(milliseconds: 200));
    await Future<void>.delayed(const Duration(milliseconds: 100));
  }
  await tester.pump();
}

Future<void> _scrollUntil(WidgetTester tester, Finder finder) async {
  for (var i = 0; i < 30; i++) {
    if (finder.evaluate().isNotEmpty) return;
    await tester.drag(find.byType(Scrollable).first, const Offset(0, -300));
    await tester.pump(const Duration(milliseconds: 300));
  }
}

void _shot(String name) => debugPrint('[463] SCREENSHOT: $name');
