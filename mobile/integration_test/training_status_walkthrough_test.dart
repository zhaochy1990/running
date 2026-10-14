// 训练状态页（#465）生产 API 走查 — integration test，本机 iOS 模拟器
// （iPhone 17 Pro）真实驱动：真实 tap、真实网络、直连生产
// https://api.stride-running.cn。
//
// 场景：测试账号 zhaochy_2015@hotmail.com（凭据 --dart-define 注入，不落仓库）。
// 走查点（票内验收点的生产可验证子集，按滚动顺序逐屏断言——ListView 懒加载，
// 滚出视口的分区会从树里销毁，必须在可见时断言）：
//   1. 邮箱密码登录 → 我 tab → 训练状态入口
//   2. 核心指标 4 卡（RHR/HRV/阈值配速/阈值心率）
//   3. 趋势窗口 toggle 切换 + RHR/HRV 图卡
//   4. 负荷 6 指标 + readiness 徽章（中文 gate）+ reasons 中文映射
//   5. 每日 Dose / 双线 / Form+CTL 注 / 8 周周剂量 / 16 周热力图（点格日详情）
//   6. STRIDE 区间两表 + footer
//   7. 页尾三 tile（能力分析/成绩预测/个人最佳，E4 路由跳转）
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:stride/features_v2/health/ability_radar_screen.dart';
import 'package:stride/features_v2/health/training_status_screen.dart';
import 'package:stride/main.dart' as app;
import 'package:stride/shared/utils/shanghai_date.dart';

late WidgetTester tester0;

/// 真实等待 + 显式 pump 交替推进帧（integration binding 下 frame 只在 pump
/// 时绘制，纯 Future.delayed 会让 push 过渡动画冻结在半程）。
Future<void> _dwell(int seconds, String milestone) async {
  debugPrint('WALKTHROUGH-MARK: $milestone');
  final end = DateTime.now().add(Duration(seconds: seconds));
  while (DateTime.now().isBefore(end)) {
    await tester0.pump(const Duration(milliseconds: 300));
    await Future<void>.delayed(const Duration(milliseconds: 300));
  }
}

Future<void> _scrollTo(String text) async {
  await tester0.dragUntilVisible(
    find.text(text),
    find.byType(ListView).last,
    const Offset(0, -240),
  );
  await _dwell(1, 'scroll:$text');
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
    for (var i = 0; i < 60; i++) {
      await tester0.pump(const Duration(seconds: 2));
      await Future<void>.delayed(const Duration(seconds: 1));
      if (find.text('核心指标').evaluate().isNotEmpty) {
        statusLoaded = true;
        break;
      }
      if (find.text('加载失败').evaluate().isNotEmpty) break;
    }
    debugPrint(
        'WALKTHROUGH-MARK: pushed=${find.byType(TrainingStatusScreen).evaluate().length} '
        'errorPage=${find.text('加载失败').evaluate().length}');
    debugPrint('WALKTHROUGH-MARK: training-status-loaded=$statusLoaded');
    expect(statusLoaded, isTrue, reason: '训练状态页应在 90s 内完成生产 API 加载');
    await _dwell(4, 'training-status-data');

    // 2) 核心指标 4 卡（指标值在 RichText 内）。
    expect(find.text('静息心率'), findsWidgets);
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

    // 4) 训练负荷卡：6 指标 + readiness 门控。
    await _scrollTo('竞技状态');
    await _dwell(3, 'load-card');
    expect(find.text('急性负荷'), findsOneWidget);
    expect(find.text('慢性负荷'), findsOneWidget);
    expect(find.text('负荷比'), findsOneWidget);
    // 今日 coverage=rest_assumed 时后端 gate 为 null，徽章按小程序口径渲染 '—'。
    final gateFound = ['绿灯', '黄灯', '红灯']
            .any((g) => find.textContaining(g).evaluate().isNotEmpty) ||
        find.text('—').evaluate().isNotEmpty;
    expect(gateFound, isTrue, reason: 'readiness 门控徽章应渲染 gate 三色或 —（rest_assumed 日）');
    for (final token in ['low_hrv', 'rhr_elevated', 'sleep_debt']) {
      expect(
        find.textContaining(token).evaluate().isEmpty,
        isTrue,
        reason: 'readiness reasons 不应出现英文 token $token 直显',
      );
    }
    await _dwell(4, 'readiness-badge');

    // 5) 每日 Dose 柱图（unknown 缺口）。
    await _scrollTo('每日训练负荷（Dose）');
    await _dwell(4, 'dose-chart');

    // 6) Form 五档 + 当前 CTL 注。
    await _scrollTo('竞技状态 Form（慢性负荷 − 急性负荷）');
    await _dwell(4, 'form-chart');
    expect(find.textContaining('当前 CTL ≈'), findsOneWidget);

    // 7) 8 周周剂量。
    await _scrollTo('8 周负荷趋势');
    await _dwell(4, 'week-chart');

    // 8) 16 周热力图 + 点格日详情（昨天格子，必为过去日）。
    await _scrollTo('16 周训练热力图');
    await _dwell(4, 'heatmap');
    final nowMs = DateTime.now().millisecondsSinceEpoch;
    final yesterday = epochToShanghaiYmd(nowMs - 24 * 60 * 60 * 1000);
    final cellFinder = find.byKey(Key('heat-cell-$yesterday'));
    if (cellFinder.evaluate().isNotEmpty) {
      await tester0.tap(cellFinder);
      await _dwell(2, 'heat-detail');
      final detailVisible = find.textContaining('· 周').evaluate().isNotEmpty;
      debugPrint('WALKTHROUGH-MARK: heat-detail=$detailVisible');
      expect(detailVisible, isTrue, reason: '点格应弹出日详情（日期+星期）');
      await tester0.tap(cellFinder);
      await _dwell(2, 'heat-detail-collapse');
    }

    // 9) STRIDE 区间两表 + footer。
    await _scrollTo('STRIDE 区间');
    await _dwell(3, 'zones-section');
    expect(find.text('配速区间'), findsOneWidget);
    expect(find.text('心率区间'), findsOneWidget);
    await _scrollTo('RHR / HRV: 来自手表原始读数（COROS / Garmin）');
    expect(find.textContaining('Calibration:'), findsOneWidget);
    await _dwell(3, 'footer');

    // 10) 页尾三 tile（E4-E6 迁路由）。
    await _scrollTo('个人最佳');
    await _dwell(3, 'footer-tiles');
    expect(find.text('能力分析'), findsOneWidget);
    expect(find.text('成绩预测'), findsOneWidget);
    expect(find.text('个人最佳'), findsOneWidget);

    // 能力雷达 tile 可跳转（E4 路由存活；雷达页顶栏无返回键，不回退）。
    await tester0.tap(find.text('能力分析'));
    await _dwell(6, 'ability-page');
    expect(find.byType(AbilityRadarScreen), findsOneWidget);

    debugPrint('WALKTHROUGH-MARK: done');
  });
}
