/// Issue 463 走查驱动 —— /records 列表页 + 活动详情（轨迹地图/曲线/圈表）。
///
/// 真实 tap 驱动，直连生产 API（App 默认 Env）。凭据经 --dart-define 注入，
/// 不入库；未注入时整组用例 skip。截图由外部 `xcrun simctl io booted
/// screenshot` 定时捕获（测试在关键点打印 CHECKPOINT 并停留）。
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

    // 已有会话则直接进 shell；否则走邮箱密码登录。
    if (!_hasShell(tester)) {
      await _login(tester);
    }
    await tester.pumpAndSettle(const Duration(seconds: 3));
    expect(_hasShell(tester), isTrue, reason: '登录后应进入 4-tab shell');

    // 关掉可能出现的「发现新版本」弹层。
    await _dismissUpdateSheet(tester);

    // ── /records 列表页 ──────────────────────────────────────────────
    debugPrint('[463] CHECKPOINT: records-list');
    await tester.tap(find.text('记录').last);
    await _settleFor(tester, const Duration(seconds: 6));
    _shot('records-list');

    // 月份折叠分组存在（「N次 · Xkm · Ymin」汇总行）。
    expect(find.textContaining('次 · '), findsWidgets,
        reason: '月份汇总头应渲染');
    // 本月展开：应能看到活动行（距离 · 时长）。
    final rows = find.textContaining('km · ');
    expect(rows, findsWidgets, reason: '本月（默认展开）应直接可见活动行');

    // 展开一个历史月份（若有）。
    final headers = find.byWidgetPredicate(
      (w) =>
          w is Text &&
          RegExp(r'^\d{4}年\d+月$').hasMatch(w.data ?? ''),
    );
    if (headers.evaluate().length > 1) {
      await tester.tap(headers.last);
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
    await tester.tap(rows.first);
    await _settleFor(tester, const Duration(seconds: 8));
    _shot('detail-top');

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
  }, skip: _email.isEmpty || _password.isEmpty);
}

bool _hasShell(WidgetTester tester) =>
    find.text('训练').evaluate().isNotEmpty &&
    find.text('记录').evaluate().isNotEmpty;

Future<void> _login(WidgetTester tester) async {
  await tester.tap(find.text('登录').first);
  await _settleFor(tester, const Duration(seconds: 2));

  await tester.tap(find.byKey(const Key('login-tab-1')));
  await tester.pumpAndSettle();
  await tester.enterText(find.byKey(const Key('login-email')), _email);
  await tester.enterText(find.byKey(const Key('login-password')), _password);
  await tester.tap(find.byKey(const Key('login-agree')));
  await tester.pumpAndSettle();
  debugPrint('[463] CHECKPOINT: login-filled');
  await tester.tap(find.text('登录').last);
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
