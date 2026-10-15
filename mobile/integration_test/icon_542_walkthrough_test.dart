// #542 图标接入走查（配合宿主机 simctl 截图循环）：直连生产 API，
// 邮箱密码登录后依次停留四 tab（训练/记录/教练/我），供 simctl 截图取证。
// 桌面图标与应用名（StrideWise）由宿主机在 springboard / Settings 截图验证。
//
// 运行：flutter test integration_test/icon_542_walkthrough_test.dart -d <udid> \
//   --dart-define=TEST_EMAIL=... --dart-define=TEST_PASSWORD=...
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:stride/main.dart' as app;

// 凭据经 --dart-define 注入（TEST_EMAIL/TEST_PASSWORD），不落仓库。
const _email = String.fromEnvironment('TEST_EMAIL');
const _password = String.fromEnvironment('TEST_PASSWORD');

late WidgetTester tester0;

Future<void> _dwell(int seconds, String milestone) async {
  debugPrint('WALKTHROUGH-MARK: $milestone');
  await Future<void>.delayed(Duration(seconds: seconds));
  await tester0.pumpAndSettle(const Duration(milliseconds: 200));
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('#542 walkthrough: 邮箱密码登录 → 四 tab 冒烟', (tester) async {
    tester0 = tester;
    app.main();
    await tester.pumpAndSettle(const Duration(seconds: 3));

    // 无会话 → 走邮箱密码登录（与 login_walkthrough 同一序列）。
    if (find.text('本周训练').evaluate().isEmpty) {
      final startLogin = find.text('登录');
      if (startLogin.evaluate().isNotEmpty) {
        await tester.tap(startLogin.first);
        await tester.pumpAndSettle(const Duration(seconds: 2));
      }
      await tester.tap(find.text('邮箱密码登录'));
      await tester.pumpAndSettle(const Duration(milliseconds: 500));
      await tester.enterText(find.byKey(const Key('login-email')), _email);
      await tester.enterText(find.byKey(const Key('login-password')), _password);
      await tester.pumpAndSettle(const Duration(milliseconds: 300));
      await tester.tap(find.byKey(const Key('login-agree')));
      await tester.pumpAndSettle(const Duration(milliseconds: 300));
      final submit = find.widgetWithText(FilledButton, '登录');
      expect(submit, findsOneWidget);
      await tester.tap(submit);
      await tester.pumpAndSettle(const Duration(seconds: 12));
    }
    expect(find.text('本周训练'), findsOneWidget);
    await _dwell(8, 'tab-training');

    for (final tab in ['记录', '教练', '我']) {
      await tester.tap(find.text(tab));
      await tester.pumpAndSettle(const Duration(seconds: 2));
      await _dwell(6, 'tab-$tab');
    }
    // Settings 条目截图由宿主机单独完成（app-settings 深链会使本测试
    // 因 app 退后台挂起，不放进来）。
    debugPrint('WALKTHROUGH-MARK: done');
  });
}
