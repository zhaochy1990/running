// 报名 sheet 专项截图走查：详情 → 打开报名 sheet（五态+项目 chips）长驻。
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:stride/main.dart' as app;

late WidgetTester tester0;

Future<void> _dwell(int seconds, String milestone) async {
  debugPrint('WALKTHROUGH-MARK: $milestone');
  await Future<void>.delayed(Duration(seconds: seconds));
  try {
    await tester0.pumpAndSettle(const Duration(milliseconds: 300));
  } on FlutterError {}
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('报名 sheet 走查', (tester) async {
    tester0 = tester;
    app.main();
    await _dwell(6, 'app-start');
    if (find.text('本周训练').evaluate().isEmpty) {
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
      await tester0.tap(find.byKey(const Key('login-agree')));
      await tester0.pumpAndSettle(const Duration(milliseconds: 300));
      await tester0.tap(find.widgetWithText(FilledButton, '登录'));
      await tester0.pumpAndSettle(const Duration(seconds: 12));
      await _dwell(6, 'after-login');
    }

    await tester0.tap(find.text('我'));
    await _dwell(2, 'me-tab');
    await tester0.scrollUntilVisible(
      find.byKey(const Key('menu-race-center')),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    await tester0.tap(find.byKey(const Key('menu-race-center')));
    await _dwell(8, 'race-center-loaded');

    final rows = find.byElementPredicate(
        (w) => (w.widget.key?.toString() ?? '').contains('race-row-'));
    await tester0.tap(rows.first);
    await _dwell(8, 'race-detail-loaded');

    final signup = find.byKey(const Key('signup-open'));
    if (signup.evaluate().isNotEmpty) {
      await tester0.tap(signup.first);
      // 长 dwell：宿主机截图循环抓 sheet 帧（chips + 五态选项）。
      await _dwell(20, 'signup-sheet-open');
    }
    await _dwell(2, 'done');
    debugPrint('WALKTHROUGH-MARK: done');
  });
}
