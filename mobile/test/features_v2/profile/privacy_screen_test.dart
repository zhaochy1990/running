// 隐私与权限入口页自检：镜像小程序 PRIVACY_ROWS 的两个声明入口，点击跳转
// /declaration/:docType（正文渲染由 declaration_screen_test 覆盖）。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stride/features_v2/profile/privacy_screen.dart';

GoRouter _router() => GoRouter(
      initialLocation: '/me/privacy',
      routes: [
        GoRoute(
          path: '/me/privacy',
          builder: (_, _) => const PrivacyScreen(),
        ),
        GoRoute(
          path: '/declaration/:docType',
          builder: (_, state) =>
              Scaffold(body: Text('doc=${state.pathParameters['docType']}')),
        ),
      ],
    );

void main() {
  testWidgets('两个声明入口：用户协议 + 隐私政策', (tester) async {
    await tester.pumpWidget(MaterialApp.router(routerConfig: _router()));
    await tester.pump();

    expect(find.text('用户协议'), findsOneWidget);
    expect(find.text('隐私政策'), findsOneWidget);
    expect(find.text('服务条款与用户权利义务'), findsOneWidget);
    expect(find.text('个人信息的收集、使用与保护'), findsOneWidget);
  });

  testWidgets('点击入口跳转对应 docType', (tester) async {
    await tester.pumpWidget(MaterialApp.router(routerConfig: _router()));
    await tester.pump();

    await tester.tap(find.byKey(const Key('privacy-privacy-policy')));
    await tester.pump();
    await tester.pump();

    expect(find.text('doc=privacy_policy'), findsOneWidget);
  });
}
