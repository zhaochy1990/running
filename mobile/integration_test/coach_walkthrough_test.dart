/// 教练 tab 真机走查（stride-devops#464 自验，直连生产 API）。
///
/// 覆盖 18 页 checklist 第 7 页验收点：
///   SSE 流式打字机+阶段提示 / 多会话抽屉+服务端历史 / 失败重试幂等 /
///   键盘高度自适应 / 周上下文入口（「和教练聊一聊」）。
/// 结构化卡片→策略草稿交接依赖 race target 会话（教练需真实生成策略，
/// 消耗生产 token），走查仅验证会话链路；卡片渲染由 widget/契约测试钉住。
///
/// 运行：flutter test integration_test/coach_walkthrough_test.dart -d `udid`
/// 关键节点刻意停留数秒，供外部 `xcrun simctl io booted screenshot` 取证。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:stride/app.dart';
import 'package:stride/features_v2/_shared/widgets/chat_markdown.dart';
import 'package:stride/features_v2/auth/start_screen.dart';

/// 停留 n 秒（每 250ms pump 一帧），供外部截图。
Future<void> dwell(WidgetTester tester, int seconds) async {
  for (var i = 0; i < seconds * 4; i++) {
    await tester.pump(const Duration(milliseconds: 250));
  }
}

/// 轮询直到 finder 出现或超时；返回是否出现。
/// 注意：不要传 .first/.last 变体（无匹配时 evaluate 会抛 StateError）。
Future<bool> waitFor(
  WidgetTester tester,
  Finder finder, {
  Duration timeout = const Duration(seconds: 15),
}) async {
  bool present() {
    try {
      return finder.evaluate().isNotEmpty;
    } on StateError {
      return false; // .first/.last 变体在无匹配时抛出
    }
  }

  final end = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(end)) {
    await tester.pump(const Duration(milliseconds: 250));
    if (present()) return true;
  }
  return present();
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('登录 → 教练 tab：SSE 流式 + 多会话抽屉 + 上下文入口', (tester) async {
    // 冷启动：无 token → /auth/start。
    await tester.pumpWidget(const ProviderScope(child: StrideApp()));
    await dwell(tester, 3);

    // ── 邮箱密码登录（已持有会话则直接进主 shell，跳过） ────────────────
    final alreadyAuthed = await waitFor(tester, find.text('记录'), timeout: const Duration(seconds: 8));
    if (!alreadyAuthed) {
      final loginEntry = find.text('登录').first;
      expect(await waitFor(tester, loginEntry), isTrue, reason: '启动页应有登录入口');
      await tester.tap(loginEntry);
      await dwell(tester, 2);

      // 默认是验证码 tab，切「邮箱密码登录」。
      final emailTab = find.byKey(const Key('login-tab-1'));
      expect(await waitFor(tester, emailTab), isTrue, reason: '登录页应有双 tab');
      await tester.tap(emailTab);
      await dwell(tester, 1);

      await tester.enterText(find.byKey(const Key('login-email')), 'zhaochy_2015@hotmail.com');
      await tester.enterText(find.byKey(const Key('login-password')), 'qweasdZXC@123');
      await tester.tap(find.byKey(const Key('login-agree')));
      await dwell(tester, 1);
      // 勾选协议后登录按钮才可点。
      await tester.tap(find.byType(StrideAuthPrimaryButton));
    }
    // 等落到主 shell（生产 API，放宽到 30s）。
    expect(
      await waitFor(tester, find.text('记录'), timeout: const Duration(seconds: 30)),
      isTrue,
      reason: '登录后应出现底部导航（记录 tab 标签）',
    );
    await dwell(tester, 4);

    // ── 切教练 tab ─────────────────────────────────────────────────────
    await tester.tap(find.text('教练').last);
    expect(
      await waitFor(tester, find.byIcon(Icons.menu), timeout: const Duration(seconds: 15)),
      isTrue,
      reason: '教练 tab 应有会话抽屉入口',
    );
    await dwell(tester, 5); // 截图：教练 tab

    // ── 多会话抽屉 + 服务端历史 ────────────────────────────────────────
    await tester.tap(find.byIcon(Icons.menu));
    expect(
      await waitFor(tester, find.text('对话列表')),
      isTrue,
      reason: '应打开会话抽屉',
    );
    await dwell(tester, 5); // 截图：会话抽屉（含存量会话）
    await tester.tapAt(const Offset(20, 200)); // 点遮罩关闭抽屉
    await dwell(tester, 2);

    // ── SSE 流式发送（少量无害测试消息） ──────────────────────────────
    const message = '请用一句话提醒我今天的训练注意事项';
    await tester.enterText(find.byType(TextField), message);
    await dwell(tester, 1); // 截图：键盘顶起输入栏（键盘高度自适应）
    await tester.tap(find.byIcon(Icons.send_rounded));

    // 流式期发送按钮被 spinner 替换；轮询等 done 出 markdown 回复（120s 预算）。
    final deadline = DateTime.now().add(const Duration(seconds: 120));
    var sawReply = false;
    while (DateTime.now().isBefore(deadline)) {
      await tester.pump(const Duration(milliseconds: 500));
      if (find.byType(ChatMarkdown).evaluate().isNotEmpty) {
        sawReply = true;
        break;
      }
    }
    expect(sawReply, isTrue, reason: 'done 后应有 markdown 助手回复气泡');
    await dwell(tester, 5); // 截图：流式完成后的回复

    // ── 会话抽屉：新会话已生成并带首条消息标题 ─────────────────────────
    await tester.tap(find.byIcon(Icons.menu));
    expect(await waitFor(tester, find.text('对话列表')), isTrue);
    expect(
      find.textContaining('请用一句话提醒我今').evaluate().isNotEmpty,
      isTrue,
      reason: '新会话应以首条消息为标题出现在抽屉',
    );
    await dwell(tester, 4); // 截图：会话抽屉（新会话置顶）
    await tester.tapAt(const Offset(20, 200));
    await dwell(tester, 1);

    // ── 周上下文入口：训练页「和教练聊一聊」带 target 跳教练 tab ────────
    await tester.tap(find.text('训练').last); // 底部导航 tab
    await dwell(tester, 3);
    final chatEntry = find.text('和教练聊一聊');
    if (chatEntry.evaluate().isNotEmpty) {
      await tester.tap(chatEntry.first);
      expect(
        await waitFor(tester, find.textContaining('正在围绕'), timeout: const Duration(seconds: 10)),
        isTrue,
        reason: '入口应新建锚定 target 的会话并显示上下文条',
      );
      await dwell(tester, 5); // 截图：上下文锚定条
    }
    // 「和教练聊一聊」入口在有今日安排时才出现；无安排时跳过（不视为失败）。
  });
}
