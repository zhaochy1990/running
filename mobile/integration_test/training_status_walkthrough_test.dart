// 训练状态页（#465）生产 API 走查 — integration test，本机 iOS 模拟器
// （iPhone 17 Pro）真实驱动：真实 tap、真实网络、直连生产
// https://api.stride-running.cn。
//
// 场景：测试账号 zhaochy_2015@hotmail.com（凭据 --dart-define 注入，不落仓库）。
// 走查点（票内验收点的生产可验证子集）：
//   1. 邮箱密码登录 → 我 tab
//   2. 训练状态入口：核心指标 4 卡（RHR/HRV/阈值配速/阈值心率）渲染
//   3. 趋势区：窗口 toggle 切换 + RHR/HRV 图卡
//   4. 训练负荷：6 指标 + readiness 徽章（中文 gate 文案）+ reasons 中文映射
//   5. 每日 Dose / 双线 / Form / 8 周周剂量 / 16 周热力图分区
//   6. STRIDE 区间两表（配速 + 心率）
//   7. 页尾三 tile（能力分析/成绩预测/个人最佳）
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
    // 大页面/图表动画下 pumpAndSettle 超时是走查节奏内的预期情况，吞掉继续。
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('训练状态页走查：登录→我→训练状态全分区→页尾 tile', (tester) async {
    tester0 = tester;
    app.main();
    await _dwell(6, 'app-start');

    // 未登录则走邮箱密码登录（与其他 walkthrough 相同路径）。
    if (find.text('本周训练').evaluate().isEmpty) {
      final startLogin = find.text('登录');
      if (startLogin.evaluate().isNotEmpty) {
        await tester0.tap(startLogin.first);
        await _dwell(2, 'login-page');
      }
      await tester0.tap(find.text('邮箱密码登录'));
      await _dwell(1, 'email-login-form');
      await tester0.enterText(find.byKey(const Key('login-email')),
          const String.fromEnvironment('TEST_EMAIL'));
      await tester0.enterText(find.byKey(const Key('login-password')),
          const String.fromEnvironment('TEST_PASSWORD'));
      await _dwell(1, 'login-filled');
      await tester0.tap(find.byKey(const Key('login-agree')));
      await _dwell(1, 'login-agree');
      await tester0.tap(find.widgetWithText(FilledButton, '登录'));
      await _dwell(12, 'login-done');
    }
    await _dwell(5, 'home');

    // 1) 我 tab → 训练状态入口。
    await tester0.tap(find.text('我').last);
    await _dwell(4, 'me-tab');
    expect(find.text('训练状态'), findsOneWidget);

    await tester0.tap(find.text('训练状态'));
    await _dwell(3, 'training-status-loading');

    // 生产 5 个接口（含 16 周活动分页）加载可能超过 10s，轮询等待。
    var statusLoaded = false;
    for (var i = 0; i < 45; i++) {
      await Future<void>.delayed(const Duration(seconds: 2));
      try {
        await tester0.pumpAndSettle(const Duration(milliseconds: 300));
      } on FlutterError {
        // 加载 spinner / 图表动画下超时是预期情况。
      }
      if (find.text('核心指标').evaluate().isNotEmpty) {
        statusLoaded = true;
        break;
      }
      if (find.text('加载失败').evaluate().isNotEmpty) break;
    }
    debugPrint('WALKTHROUGH-MARK: training-status-loaded=$statusLoaded');
    expect(statusLoaded, isTrue, reason: '训练状态页应在 90s 内完成生产 API 加载');
    await _dwell(4, 'training-status-data');

    // 2) 核心指标 4 卡（生产数据渲染）。
    expect(find.text('静息心率'), findsWidgets);
    expect(find.text('心率变异性'), findsWidgets);
    expect(find.text('阈值配速'), findsOneWidget);
    expect(find.text('阈值心率'), findsOneWidget);
    await _dwell(4, 'metric-cards');

    // 3) 趋势窗口 toggle 全量重渲。
    expect(find.text('趋势'), findsOneWidget);
    expect(find.text('30d'), findsOneWidget);
    await tester0.tap(find.text('90d'));
    await _dwell(4, 'window-90d');
    await tester0.tap(find.text('14d'));
    await _dwell(4, 'window-14d');

    // 4) 训练负荷 6 指标 + readiness 门控。
    await tester0.dragUntilVisible(
      find.text('每日训练负荷（Dose）'),
      find.byType(ListView).last,
      const Offset(0, -300),
    );
    await _dwell(3, 'load-section');
    expect(find.text('急性负荷'), findsOneWidget);
    expect(find.text('慢性负荷'), findsOneWidget);
    expect(find.text('负荷比'), findsOneWidget);
    // readiness gate 徽章（green/yellow/red 中文三选一）。
    final gateTexts = ['绿灯', '黄灯', '红灯'];
    final gateFound =
        gateTexts.any((g) => find.textContaining(g).evaluate().isNotEmpty);
    expect(gateFound, isTrue, reason: 'readiness 门控徽章应渲染绿灯/黄灯/红灯之一');

    // reasons 中文映射（不出现英文 token 直显）。
    for (final token in ['low_hrv', 'rhr_elevated', 'sleep_debt']) {
      expect(
        find.text(token).evaluate().isEmpty &&
            find.textContaining(' $token').evaluate().isEmpty,
        isTrue,
        reason: 'readiness reasons 不应出现英文 token $token 直显',
      );
    }
    await _dwell(4, 'readiness-badge');

    // 5) 图表分区（Dose/双线/Form/8 周/16 周热力图）。
    await tester0.dragUntilVisible(
      find.text('16 周训练热力图'),
      find.byType(ListView).last,
      const Offset(0, -300),
    );
    await _dwell(4, 'charts-section');
    expect(find.text('竞技状态 Form（慢性负荷 − 急性负荷）'), findsOneWidget);
    expect(find.text('8 周负荷趋势'), findsOneWidget);
    expect(find.text('16 周训练热力图'), findsOneWidget);

    // 6) STRIDE 区间两表。
    final zonesVisible = find.text('STRIDE 区间').evaluate().isNotEmpty;
    if (!zonesVisible) {
      await tester0.dragUntilVisible(
        find.text('STRIDE 区间'),
        find.byType(ListView).last,
        const Offset(0, -300),
      );
    }
    await _dwell(3, 'zones-section');
    expect(find.text('配速区间'), findsOneWidget);
    expect(find.text('心率区间'), findsOneWidget);
    expect(find.textContaining('Calibration:'), findsOneWidget);

    // 7) 页尾三 tile（E4-E6 迁路由）。
    await tester0.dragUntilVisible(
      find.text('个人最佳'),
      find.byType(ListView).last,
      const Offset(0, -300),
    );
    await _dwell(3, 'footer-tiles');
    expect(find.text('能力分析'), findsOneWidget);
    expect(find.text('成绩预测'), findsOneWidget);
    expect(find.text('个人最佳'), findsOneWidget);

    // 能力雷达 tile 可跳转（E4 路由存活）。
    await tester0.tap(find.text('能力分析'));
    await _dwell(6, 'ability-page');
    await tester0.tap(find.byType(BackButton).first);
    await _dwell(3, 'back-to-status');

    debugPrint('WALKTHROUGH-MARK: done');
  });
}
