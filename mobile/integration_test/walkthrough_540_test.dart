// #540 真机走查（配合宿主机 simctl 截图循环）：
//   1. 登录页 SMS tab 未勾选协议点发送 → UI 拦截 + 提示文案（不触发 sms/send）。
//   2. 邮箱密码 tab 登录（凭据 --dart-define 注入，不落仓库）。
//   3. 训练 tab「今日无训练安排」卡片宽度（应占满可用宽）。
//   4. 我 tab 头像（有 avatarUrl → foregroundImage 网络图，否则首字母回退）。
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:stride/main.dart' as app;

const _email = String.fromEnvironment('TEST_EMAIL');
const _password = String.fromEnvironment('TEST_PASSWORD');

late WidgetTester tester0;

Future<void> _dwell(int seconds, String milestone) async {
  debugPrint('WALKTHROUGH-MARK: $milestone');
  await Future<void>.delayed(Duration(seconds: seconds));
  await tester0.pumpAndSettle(const Duration(milliseconds: 200));
}

const _weekDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/// 周日期条上找一天没有课的：逐天点 Mon..Sun，遇到空态即停。
Future<bool> _findEmptyDay(WidgetTester tester) async {
  for (final day in _weekDays) {
    if (find.text('今日无训练安排').evaluate().isNotEmpty) return true;
    final dayFinder = find.text(day);
    if (dayFinder.evaluate().isEmpty) break;
    await tester.tap(dayFinder.first);
    await tester.pumpAndSettle(const Duration(seconds: 1));
  }
  return find.text('今日无训练安排').evaluate().isNotEmpty;
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('#540 walkthrough: SMS gate / empty card / me avatar',
      (tester) async {
    tester0 = tester;
    app.main();
    await tester.pumpAndSettle(const Duration(seconds: 3));

    final inApp = find.text('本周训练').evaluate().isNotEmpty;

    // ── 1. SMS 协议门槛（未勾选 → 拦截，绝不真发短信）──
    if (inApp) {
      // 已有会话：先退出登录到登录页。
      await tester.tap(find.text('我'));
      await tester.pumpAndSettle(const Duration(seconds: 2));
      final logout = find.text('退出登录');
      await tester.scrollUntilVisible(
        logout,
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(logout);
      await tester.pumpAndSettle(const Duration(seconds: 3));
      final confirm = find.text('退出');
      if (confirm.evaluate().isNotEmpty) {
        await tester.tap(confirm.last);
        await tester.pumpAndSettle(const Duration(seconds: 2));
      }
      await tester.pumpAndSettle(const Duration(seconds: 2));
      await tester.tap(find.text('登录').first);
      await tester.pumpAndSettle(const Duration(seconds: 2));
    } else {
      final startLogin = find.text('登录');
      if (startLogin.evaluate().isNotEmpty) {
        await tester.tap(startLogin.first);
        await tester.pumpAndSettle(const Duration(seconds: 2));
      }
    }

    // 默认就是验证码 tab。填合法手机号，不勾选协议，点「发送验证码」。
    await tester.enterText(
      find.byKey(const Key('login-phone')),
      '13800138000',
    );
    await tester.pumpAndSettle(const Duration(milliseconds: 300));
    await tester.tap(find.byKey(const Key('login-send-code')));
    await tester.pumpAndSettle(const Duration(milliseconds: 500));
    expect(
      find.text('请先阅读并勾选同意《用户协议》和《隐私政策》'),
      findsOneWidget,
    );
    debugPrint('WALKTHROUGH-MARK: sms-gate-blocked');
    await _dwell(8, 'sms-gate-hold');

    // ── 2. 邮箱密码 tab 登录 ──
    await tester.tap(find.text('邮箱密码登录'));
    await tester.pumpAndSettle(const Duration(milliseconds: 500));
    await tester.enterText(find.byKey(const Key('login-email')), _email);
    await tester.enterText(find.byKey(const Key('login-password')), _password);
    await tester.pumpAndSettle(const Duration(milliseconds: 300));
    await tester.tap(find.byKey(const Key('login-agree')));
    await tester.pumpAndSettle(const Duration(milliseconds: 300));
    await tester.tap(find.widgetWithText(FilledButton, '登录'));
    await tester.pumpAndSettle(const Duration(seconds: 12));
    await _dwell(8, 'home-after-login');

    // ── 3. 训练 tab：空态卡片全宽 ──
    final hasEmpty = await _findEmptyDay(tester);
    debugPrint('WALKTHROUGH-MARK: training-empty=$hasEmpty');
    await _dwell(8, 'training-hold');

    // ── 4. 我 tab：头像 ──
    await tester.tap(find.text('我'));
    await tester.pumpAndSettle(const Duration(seconds: 2));
    final avatar = tester.widget<CircleAvatar>(find.byType(CircleAvatar));
    debugPrint(
      'WALKTHROUGH-MARK: avatar-foreground-image=${avatar.foregroundImage}',
    );
    await _dwell(8, 'me-hold');
    debugPrint('WALKTHROUGH-MARK: done');
  });
}
