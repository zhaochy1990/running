// 手表域（#462）生产 API 走查 — integration test，本机 iOS 模拟器
// （iPhone 17 Pro）真实驱动：真实 tap、真实网络。
//
// 场景：测试账号 zhaochy_2015@hotmail.com 在生产已绑 COROS 表。
// 走查点（票内验收点的生产可验证子集）：
//   1. 邮箱密码登录 → 我 tab
//   2. 手动同步行：POST sync incremental + run 轮询 → toast + 上次同步（相对时间）
//   3. 手表管理：绑定态卡片（provider/email/设备/最后同步/capabilities、已连接）
//   4. 解绑内联确认卡片出现（**不点确认解除**——无 COROS 凭据无法重绑）
//
// 走查范围说明：绑定表单（品牌网格/region 仅 Garmin/MFA 提示/占位差异）
// 仅在未绑定态可见；测试账号已绑表且无凭据可重绑，故该部分由
// test/features_v2/watch/watch_screen_test.dart 的 widget 测试覆盖。
// 凭据经 --dart-define 注入（TEST_EMAIL/TEST_PASSWORD），不落仓库。
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

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('手表域走查：登录→我页手动同步→手表管理绑定态→解绑确认卡片',
      (tester) async {
    tester0 = tester;
    app.main();
    await tester.pumpAndSettle(const Duration(seconds: 5));

    // 未登录则走邮箱密码登录（与 login_walkthrough 相同路径）。
    final needLogin = find.text('本周训练').evaluate().isEmpty;
    if (needLogin) {
      await tester.tap(find.text('登录'));
      await tester.pumpAndSettle(const Duration(seconds: 2));
      await tester.tap(find.text('邮箱密码登录'));
      await tester.pumpAndSettle(const Duration(milliseconds: 500));
      await tester.enterText(find.byKey(const Key('login-email')), _email);
      await tester.enterText(
        find.byKey(const Key('login-password')),
        _password,
      );
      await tester.pumpAndSettle(const Duration(milliseconds: 300));
      await tester.tap(find.byKey(const Key('login-agree')));
      await tester.pumpAndSettle(const Duration(milliseconds: 300));
      await tester.tap(find.widgetWithText(FilledButton, '登录'));
      await tester.pumpAndSettle(const Duration(seconds: 12));
    }
    await _dwell(6, 'home');

    // 1) 我 tab：手动同步行（last_sync 来自 GET /watch）。
    await tester.tap(find.text('我').last);
    await tester.pumpAndSettle(const Duration(seconds: 2));
    await _dwell(5, 'me-tab');
    // 绑定态账号应有「上次同步 …」（服务端 sync_meta 回读）。
    expect(
      find.textContaining('上次同步'),
      findsOneWidget,
      reason: '我页手动同步行应展示 GET /watch 的 last_sync_at 相对时间',
    );

    // 2) 手动同步：incremental + run 轮询（2s/60min）→ toast。
    await tester.tap(find.text('手动同步'));
    await _dwell(3, 'sync-started');
    var synced = false;
    for (var i = 0; i < 90; i++) {
      await tester.pumpAndSettle(const Duration(seconds: 2));
      if (find.text('同步成功').evaluate().isNotEmpty) {
        synced = true;
        break;
      }
      if (find.text('同步失败').evaluate().isNotEmpty) break;
    }
    debugPrint('WALKTHROUGH-MARK: sync-result synced=$synced');
    await _dwell(6, 'sync-done');
    expect(synced, isTrue, reason: '生产 incremental 同步应轮询到 done 并 toast 同步成功');
    expect(
      find.textContaining('上次同步'),
      findsOneWidget,
      reason: '同步成功后 last_sync 应刷新',
    );

    // 3) 手表管理：绑定态卡片。
    await tester.tap(find.text('手表管理'));
    await tester.pumpAndSettle(const Duration(seconds: 3));
    await _dwell(6, 'watch-page');
    expect(find.text('当前绑定'), findsOneWidget);
    expect(
      find.text('已连接'),
      findsOneWidget,
      reason: '测试账号生产已绑表，应展示绑定态',
    );
    expect(find.text('最后同步'), findsOneWidget);
    expect(find.text('支持功能'), findsOneWidget);

    // 4) 解绑内联确认卡片（非模态）——只展开确认，不点「确认解除」。
    // find.text 是全串匹配；卡片描述是整句，用 textContaining 断言。
    expect(find.textContaining('已同步的训练数据不会被删除'), findsOneWidget);
    await tester.tap(find.widgetWithText(OutlinedButton, '解除绑定'));
    await tester.pumpAndSettle(const Duration(seconds: 1));
    expect(find.text('确认解除'), findsOneWidget);
    expect(
      find.byType(AlertDialog),
      findsNothing,
      reason: '解绑确认是内联卡片，不是模态对话框',
    );
    await _dwell(6, 'unbind-confirm-card');
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle(const Duration(seconds: 1));
    await _dwell(3, 'done');
    debugPrint('WALKTHROUGH-MARK: done');
  });
}
