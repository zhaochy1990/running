// 周计划页走查截图补充（stride-devops#468 终验 checklist 第 4 页）：
// 训练 tab → 周计划入口 → 周列表（本周/历史 seg）→ 周详情逐日视图。
// 只读走查：不点「推送手表」/「生成计划」，不修改任何数据。直连生产 API
// （App 默认 Env），凭据经 --dart-define 注入（TEST_EMAIL/TEST_PASSWORD）。
//
// 入口说明：训练 tab 唯一周计划入口是空课表卡「好好休息，或查看本周计划」；
// 当日有课时该卡不渲染，此时退化为 router 导航直达（同一目标路由）。
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:integration_test/integration_test.dart';

import 'package:stride/core/router/routes.dart';
import 'package:stride/features_v2/plan/widgets/week_card.dart';
import 'package:stride/main.dart' as app;

late WidgetTester tester0;

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
  await tester0.enterText(
    find.byKey(const Key('login-email')),
    const String.fromEnvironment('TEST_EMAIL'),
  );
  await tester0.enterText(
    find.byKey(const Key('login-password')),
    const String.fromEnvironment('TEST_PASSWORD'),
  );
  await tester0.tap(find.byKey(const Key('login-agree')));
  await tester0.pumpAndSettle(const Duration(milliseconds: 300));
  await tester0.tap(find.widgetWithText(FilledButton, '登录'));
  await tester0.pumpAndSettle(const Duration(seconds: 12));
  await _dwell(4, 'after-login');
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('周计划走查：训练 tab → 周列表 → 周详情', (tester) async {
    tester0 = tester;
    app.main();
    await _loginIfNeeded();

    // ── 训练 tab：周日期条 + 今日课表卡 ──
    expect(find.text('本周训练'), findsWidgets);
    await _dwell(2, 'training-tab');

    // ── 进周计划：空课表卡真实 tap，否则 router 导航同路由 ──
    final emptyCard = find.text('好好休息，或查看本周计划');
    if (emptyCard.evaluate().isNotEmpty) {
      await tester0.tap(emptyCard.first);
    } else {
      final ctx = tester0.element(find.byType(Scaffold).first);
      ctx.push(Routes.planWeeks);
    }
    await tester0.pumpAndSettle(const Duration(seconds: 4));
    await _dwell(3, 'plan-weeks-loaded');
    expect(find.text('本周'), findsWidgets); // seg control（页内另有“本周”文案）

    // ── 历史周 seg（只读切换） ──
    final historySeg = find.text('历史');
    if (historySeg.evaluate().isNotEmpty) {
      await tester0.tap(historySeg.first);
      await _dwell(2, 'plan-weeks-history');
    }

    // ── 打开第一张周卡 → 周详情逐日视图 ──
    final weekCards = find.byType(WeekCard);
    if (weekCards.evaluate().isNotEmpty) {
      await tester0.tap(weekCards.first);
      await tester0.pumpAndSettle(const Duration(seconds: 4));
      await _dwell(3, 'week-detail-loaded');
    }
  });
}
