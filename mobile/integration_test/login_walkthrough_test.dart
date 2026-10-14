// 登录路径走查截图补充（配合宿主机 simctl 截图循环）：
// 若已有会话则先从「我」页退出登录，再走邮箱密码 tab 登录回首页。
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:stride/main.dart' as app;

// 凭据经 --dart-define 注入（TEST_EMAIL/TEST_PASSWORD），不落仓库。
const _email = String.fromEnvironment('TEST_EMAIL');
const _password = String.fromEnvironment('TEST_PASSWORD');

Future<void> _dwell(int seconds, String milestone) async {
  debugPrint('WALKTHROUGH-MARK: $milestone');
  await Future<void>.delayed(Duration(seconds: seconds));
  await tester0.pumpAndSettle(const Duration(milliseconds: 200));
}

late WidgetTester tester0;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('登录路径走查（邮箱密码 tab）', (tester) async {
    tester0 = tester;
    app.main();
    await tester.pumpAndSettle(const Duration(seconds: 3));

    // 已有会话：先进「我」页退出登录，回到登录页再走完整流程。
    final alreadyIn = find.text('本周训练');
    if (alreadyIn.evaluate().isNotEmpty) {
      await tester.tap(find.text('我'));
      await tester.pumpAndSettle(const Duration(seconds: 2));
      final logout = find.text('退出登录');
      if (logout.evaluate().isNotEmpty) {
        await tester.scrollUntilVisible(
          logout,
          200,
          scrollable: find.byType(Scrollable).first,
        );
        await tester.tap(logout);
        await tester.pumpAndSettle(const Duration(seconds: 3));
        // 可能有确认弹窗
        final confirm = find.text('退出');
        if (confirm.evaluate().isNotEmpty) {
          await tester.tap(confirm.last);
          await tester.pumpAndSettle(const Duration(seconds: 2));
        }
      }
      await tester.pumpAndSettle(const Duration(seconds: 3));
    }

    await _dwell(8, 'login-page');
    // 退出后落在 /auth/start：先点「登录」进登录页。
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
    await _dwell(8, 'login-filled');

    final submit = find.widgetWithText(FilledButton, '登录');
    expect(submit, findsOneWidget);
    await tester.tap(submit);
    await tester.pumpAndSettle(const Duration(seconds: 12));
    await _dwell(8, 'home-after-login');
    debugPrint('WALKTHROUGH-MARK: done');
  });
}
