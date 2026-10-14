// 赛事域四屏真机走查（#466 验收点）：直连生产 API，邮箱密码登录后
// 走 赛事中心 → 详情（三 tab/报名 sheet/策略卡）→ 策略报告（版本 pills/
// 配速表/补给/海报按钮）→ 我的比赛（双 tab/成绩/PB）。
// 宿主机配合 `xcrun simctl io booted screenshot` 截图自查。
//
// 只读走查：收藏开关即点即回（客户端过滤），报名 sheet 只打开不提交，
// 不写任何生产数据。
//
// 凭据经 --dart-define 注入（TEST_EMAIL/TEST_PASSWORD），不落仓库。
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:stride/main.dart' as app;

late WidgetTester tester0;

/// 生产库确认该账号有已生成策略的赛事（2026上海马拉松）。
const _strategyRaceRowKey = Key('race-row-632');

Future<void> _dwell(int seconds, String milestone) async {
  debugPrint('WALKTHROUGH-MARK: $milestone');
  await Future<void>.delayed(Duration(seconds: seconds));
  try {
    await tester0.pumpAndSettle(const Duration(milliseconds: 300));
  } on FlutterError {
    // 持续动画（刷新指示器等）不阻塞走查。
  }
}

Future<void> _loginIfNeeded() async {
  await _dwell(6, 'app-start');
  if (find.text('本周训练').evaluate().isNotEmpty) return; // 已有会话

  final startLogin = find.text('登录');
  if (startLogin.evaluate().isNotEmpty) {
    await tester0.tap(startLogin.first);
    await tester0.pumpAndSettle(const Duration(seconds: 2));
  }
  await tester0.tap(find.text('邮箱密码登录'));
  await tester0.pumpAndSettle(const Duration(milliseconds: 500));
  await tester0.enterText(find.byKey(const Key('login-email')),
      const String.fromEnvironment('TEST_EMAIL'));
  await tester0.enterText(find.byKey(const Key('login-password')),
      const String.fromEnvironment('TEST_PASSWORD'));
  await tester0.pumpAndSettle(const Duration(milliseconds: 300));
  await tester0.tap(find.byKey(const Key('login-agree')));
  await tester0.pumpAndSettle(const Duration(milliseconds: 300));
  await tester0.tap(find.widgetWithText(FilledButton, '登录'));
  await tester0.pumpAndSettle(const Duration(seconds: 12));
  await _dwell(6, 'after-login');
}

Future<bool> _tryTap(Key key) async {
  final f = find.byKey(key);
  if (f.evaluate().isEmpty) return false;
  await tester0.tap(f.first);
  await tester0.pumpAndSettle(const Duration(seconds: 2));
  return true;
}

Future<void> _goBack(String mark) async {
  final back = find.byIcon(Icons.arrow_back_ios_new);
  if (back.evaluate().isNotEmpty) {
    await tester0.tap(back.first);
  } else {
    await tester0.pageBack();
  }
  await _dwell(2, mark);
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('赛事域四屏走查', (tester) async {
    tester0 = tester;
    app.main();
    await _loginIfNeeded();

    // ── 入口：「我」菜单 → 赛事中心 ──
    await tester0.tap(find.text('我'));
    await _dwell(2, 'me-tab');
    await tester0.scrollUntilVisible(
      find.byKey(const Key('menu-race-center')),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    await tester0.tap(find.byKey(const Key('menu-race-center')));
    await _dwell(8, 'race-center-loaded');
    debugPrint(
        'RACE-CENTER rows: ${find.byElementPredicate((w) => (w.widget.key?.toString() ?? '').contains('race-row-')).evaluate().length}');

    // 收藏开关（纯客户端过滤）。
    if (await _tryTap(const Key('race-filter-fav'))) {
      await _dwell(2, 'race-center-fav-on');
      await _tryTap(const Key('race-filter-fav'));
      await _dwell(1, 'race-center-fav-off');
    }

    // ── 详情（有已生成策略的上马）→ 策略报告 ──
    final detailTarget =
        find.byKey(_strategyRaceRowKey).evaluate().isNotEmpty
            ? find.byKey(_strategyRaceRowKey)
            : find.byElementPredicate(
                (w) => (w.widget.key?.toString() ?? '').contains('race-row-'));
    if (detailTarget.evaluate().isNotEmpty) {
      await tester0.tap(detailTarget.first);
      await _dwell(8, 'race-detail-loaded');

      for (var tab = 0; tab < 3; tab++) {
        await _tryTap(Key('race-detail-tab-$tab'));
        await _dwell(2, 'race-detail-tab-$tab');
      }

      // 报名 sheet：打开看五态再点遮罩关闭（不提交）。
      if (await _tryTap(const Key('signup-open'))) {
        await _dwell(6, 'signup-sheet-open');
        await tester0.tapAt(const Offset(20, 120));
        await _dwell(2, 'signup-sheet-closed');
      }

      // 策略卡（已生成）→ 策略报告页。
      if (await _tryTap(const Key('strategy-card'))) {
        await _dwell(8, 'strategy-loaded');
        debugPrint(
            'STRATEGY pills: ${find.byElementPredicate((w) => (w.widget.key?.toString() ?? '').contains('strategy-pill-')).evaluate().length}, '
            'pace rows: ${find.byElementPredicate((w) => (w.widget.key?.toString() ?? '').contains('strategy-pace-')).evaluate().length}, '
            'fuel rows: ${find.byElementPredicate((w) => (w.widget.key?.toString() ?? '').contains('strategy-fuel-time-')).evaluate().length}, '
            'save: ${find.byKey(const Key('strategy-save')).evaluate().length}, '
            'poster: ${find.byKey(const Key('strategy-poster')).evaluate().length}');
        // 配速编辑：改第一行配速（不保存，刷新即弃——不写生产数据）。
        final pace0 = find.byKey(const Key('strategy-pace-0'));
        if (pace0.evaluate().isNotEmpty) {
          await tester0.enterText(pace0.first, '6:30');
          await _dwell(4, 'strategy-pace-edited-dirty');
        }
        // 海报按钮只验存在：点击会拉起系统预览（Flutter 树外，无法自动关闭）；
        // 海报绘制本身由 test/strategy_poster_test.dart 的截图管线测试覆盖。
        debugPrint(
            'STRATEGY poster btn: ${find.byKey(const Key('strategy-poster')).evaluate().length}');
        await _dwell(2, 'strategy-done');
        await _goBack('strategy-back');
      }

      await _goBack('back-to-center');
    }

    // ── 我的比赛：双 tab + 成绩 ──
    await _tryTap(const Key('race-filter-myraces'));
    await _dwell(8, 'my-races-loaded');

    // ── 策略页：点上马卡名进详情 → 策略卡 → 策略报告 ──
    final shCard = find.text('2026上海马拉松');
    if (shCard.evaluate().isNotEmpty) {
      await tester0.tap(shCard.first);
      await _dwell(8, 'sh-detail-loaded');
      if (await _tryTap(const Key('strategy-card'))) {
        await _dwell(8, 'strategy-loaded');
        debugPrint(
            'STRATEGY pills: ${find.byElementPredicate((w) => (w.widget.key?.toString() ?? '').contains('strategy-pill-')).evaluate().length}, '
            'pace rows: ${find.byElementPredicate((w) => (w.widget.key?.toString() ?? '').contains('strategy-pace-')).evaluate().length}, '
            'fuel rows: ${find.byElementPredicate((w) => (w.widget.key?.toString() ?? '').contains('strategy-fuel-time-')).evaluate().length}, '
            'save: ${find.byKey(const Key('strategy-save')).evaluate().length}, '
            'poster: ${find.byKey(const Key('strategy-poster')).evaluate().length}, '
            'coach: ${find.byKey(const Key('strategy-to-coach')).evaluate().length}');
        // 配速编辑：改第一行配速（不保存，退出即弃——不写生产数据）。
        final pace0 = find.byKey(const Key('strategy-pace-0'));
        if (pace0.evaluate().isNotEmpty) {
          await tester0.enterText(pace0.first, '6:30');
          await _dwell(4, 'strategy-pace-edited-dirty');
        }
        // 补给计划在屏外（ListView 懒加载）：手动拖拽滚动到添加按钮。
        for (var k = 0;
            k < 12 &&
                find.byKey(const Key('strategy-fuel-add')).evaluate().isEmpty;
            k++) {
          await tester0.drag(find.byType(ListView).first, const Offset(0, -500));
          await tester0.pump(const Duration(milliseconds: 300));
        }
        debugPrint(
            'STRATEGY fuel rows after scroll: ${find.byElementPredicate((w) => (w.widget.key?.toString() ?? '').contains('strategy-fuel-time-')).evaluate().length}, '
            'add btn: ${find.byKey(const Key('strategy-fuel-add')).evaluate().length}');
        await _dwell(3, 'strategy-fueling-scrolled');
        await _dwell(2, 'strategy-done');
        await _goBack('strategy-back');
      }
      await _goBack('my-races-back');
    }

    if (find.text('我的成绩').evaluate().isNotEmpty) {
      await tester0.tap(find.text('我的成绩').first);
      await _dwell(15, 'my-results-loaded');
      debugPrint(
          'pb badges: ${find.byKey(const Key('result-pb-badge')).evaluate().length}');
    }

    await _dwell(2, 'done');
    debugPrint('WALKTHROUGH-MARK: done');
  });
}
