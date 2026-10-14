// 成绩 tab 专项截图走查：登录 → 我的比赛 → 我的成绩（长 dwell 等慢接口）。
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
  } on FlutterError {
    // pumpAndSettle 超时是走查节奏内的预期情况，吞掉继续
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('我的成绩 tab 走查', (tester) async {
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
      find.byKey(const Key('menu-my-races')),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    await tester0.tap(find.byKey(const Key('menu-my-races')));
    await _dwell(8, 'my-races-loaded');

    if (find.text('我的成绩').evaluate().isNotEmpty) {
      await tester0.tap(find.text('我的成绩').first);
      // 成绩接口慢：长 dwell 等加载完成再让宿主机截到列表帧。
      await _dwell(25, 'my-results-loaded');
      debugPrint(
          'pb badges: ${find.byKey(const Key('result-pb-badge')).evaluate().length}');
    }
    await _dwell(5, 'done');
    debugPrint('WALKTHROUGH-MARK: done');
  });
}
