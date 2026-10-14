// Onboarding（#461 单页三步重做）生产 API 走查 — integration test，
// 由本机 iOS 模拟器（iPhone 17 Pro）真实驱动：真实 tap、真实网络。
//
// 场景：测试账号 zhaochy_2015@hotmail.com 在生产已完成 onboarding 且已绑表，
// 有 4 个 done 的 onboarding run（可被认领，不会误触发新 pipeline）。走查点：
//   1. 邮箱密码登录 → 路由守卫放行进首页（无 blocked 死路）
//   2. 深链 /onboarding → refresh() 重算落点 → ready 视图 → 进入首页
// 关键页截图由宿主机 simctl 在运行期间定时抓取（见 PR 评论说明）。
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:integration_test/integration_test.dart';

import 'package:stride/main.dart' as app;
import 'package:stride/core/router/routes.dart';

// 凭据经 --dart-define 注入（TEST_EMAIL/TEST_PASSWORD），不落仓库。
const _email = String.fromEnvironment('TEST_EMAIL');
const _password = String.fromEnvironment('TEST_PASSWORD');

/// 真实时间驻留：给宿主机 simctl 截图循环留窗口，也让网络请求自然完成。
Future<void> _dwell(int seconds, String milestone) async {
  debugPrint('WALKTHROUGH-MARK: $milestone');
  await Future<void>.delayed(Duration(seconds: seconds));
  await tester0.pumpAndSettle(const Duration(milliseconds: 200));
}

late WidgetTester tester0;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('生产 API onboarding 走查：登录→首页→/onboarding ready→首页',
      (tester) async {
    tester0 = tester;
    app.main();
    await tester.pumpAndSettle(const Duration(seconds: 3));
    await _dwell(8, 'auth-start');

    // 1) 登录入口（Keychain 里已有会话时守卫直接放行进首页，跳过登录）
    final startScreen = find.text('STRIDE');
    if (startScreen.evaluate().isNotEmpty) {
      await tester.tap(find.text('登录'));
      await tester.pumpAndSettle(const Duration(seconds: 1));

      // 2) 双 tab 登录页 → 邮箱密码 tab
      await tester.tap(find.text('邮箱密码登录'));
      await tester.pumpAndSettle(const Duration(milliseconds: 500));
      await tester.enterText(find.byKey(const Key('login-email')), _email);
      await tester.enterText(find.byKey(const Key('login-password')), _password);
      await tester.pumpAndSettle(const Duration(milliseconds: 300));
      // 协议必须主动勾选（不允许默示同意）
      await tester.tap(find.byKey(const Key('login-agree')));
      await tester.pumpAndSettle(const Duration(milliseconds: 300));
      await _dwell(6, 'login-filled');

      // 3) 提交（AppBar 标题也是「登录」，用按钮类型消歧）
      final submit = find.widgetWithText(FilledButton, '登录');
      expect(submit, findsOneWidget);
      await tester.tap(submit);
    } else {
      debugPrint('WALKTHROUGH-MARK: already-authed-skip-login');
    }
    // 登录 + profile 拉取 + 首页首帧
    await tester.pumpAndSettle(const Duration(seconds: 12));
    await _dwell(10, 'home-after-login');

    // 守卫放行：不应落在 onboarding（账号已完成），更不应有 blocked 死路
    expect(find.text('需要先绑定一款手表'), findsNothing);
    expect(find.textContaining('home-stub'), findsNothing);

    // 4) 「我」tab → 手表管理（watchReady 展示）
    await tester.tap(find.text('我'));
    await tester.pumpAndSettle(const Duration(seconds: 2));
    await _dwell(6, 'me-tab');
    final watchRow = find.text('手表管理');
    if (watchRow.evaluate().isNotEmpty) {
      await tester.tap(watchRow);
      await tester.pumpAndSettle(const Duration(seconds: 2));
      await _dwell(6, 'me-watch');
      // StrideTopBar 无返回按钮（二级页靠手势返回），直接路由回首页。
      final watchCtx = tester.element(find.byType(Scaffold).first);
      GoRouter.of(watchCtx).go(Routes.training);
      await tester.pumpAndSettle(const Duration(seconds: 2));
    }

    // 5) 深链 /onboarding：refresh() 重算落点 → ready（已完成 + 已绑表 +
    //    done run 可认领）
    final anyCtx = tester.element(find.byType(Scaffold).first);
    GoRouter.of(anyCtx).push(Routes.onboarding);
    await tester.pumpAndSettle(const Duration(seconds: 8));
    await _dwell(10, 'onboarding-recomputed');
    expect(find.text('准备就绪'), findsOneWidget);

    // 6) 进入首页
    await tester.tap(find.text('进入首页'));
    await tester.pumpAndSettle(const Duration(seconds: 3));
    await _dwell(8, 'back-home');

    debugPrint('WALKTHROUGH-MARK: done');
  });
}
