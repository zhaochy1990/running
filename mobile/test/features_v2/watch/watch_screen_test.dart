import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stride/core/api/api_exception.dart';
import 'package:stride/core/auth/current_user.dart';
import 'package:stride/data/api/stride_api.dart';
import 'package:stride/data/models/profile.dart';
import 'package:stride/data/models/watch.dart';
import 'package:stride/features_v2/watch/watch_screen.dart';

class _StubApi extends StrideApi {
  _StubApi() : super(Dio());

  WatchInfo watch = const WatchInfo();
  int loginCalls = 0;
  String? loginProvider;
  String? loginEmail;
  String? loginRegion;
  Object? loginError;
  int unbindCalls = 0;

  @override
  Future<WatchInfo> getWatch() async => watch;

  @override
  Future<void> watchLogin({
    required String provider,
    required String email,
    required String password,
    String region = 'cn',
  }) async {
    loginCalls++;
    loginProvider = provider;
    loginEmail = email;
    loginRegion = region;
    if (loginError != null) throw loginError!;
  }

  @override
  Future<void> unbindWatch() async {
    unbindCalls++;
  }
}

const _profile = MyProfile(
  id: 'user-123',
  displayName: 'Test Runner',
  onboarding: OnboardingState(
    watchReady: false,
    profileReady: true,
    completedAt: '2026-01-01T00:00:00Z',
  ),
);

GoRouter _router(WidgetBuilder builder) {
  return GoRouter(
    initialLocation: '/me/watch',
    routes: [
      GoRoute(path: '/me/watch', builder: (ctx, _) => builder(ctx)),
      GoRoute(
        path: '/onboarding',
        builder: (_, _) => const Scaffold(body: Text('ONBOARDING')),
      ),
    ],
  );
}

Future<void> _pump(
  WidgetTester tester,
  _StubApi api, {
  String? provider,
}) async {
  // 表单卡片在默认 800x600 视口下折叠出屏，放大到整页可见再点。
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        strideApiProvider.overrideWithValue(api),
        currentUserProvider.overrideWith((_) => Future.value(_profile)),
      ],
      child: MaterialApp.router(
        routerConfig: _router((_) => WatchScreen(initialProvider: provider)),
      ),
    ),
  );
  await tester.pump();
  await tester.pump();
  // 预热 currentUserProvider：真实 App 里路由守卫早已激活它；测试容器是惰性的，
  // 不预热的话 currentUserIdProvider 首次同步读到 null（Future 未 resolve）。
  ProviderScope.containerOf(
    tester.element(find.byType(WatchScreen)),
    listen: false,
  ).read(currentUserProvider);
  await tester.pump();
  await tester.pump();
}

void main() {
  testWidgets('unbound: provider grid first, no form yet', (tester) async {
    await _pump(tester, _StubApi());

    expect(find.text('COROS'), findsOneWidget);
    expect(find.text('Garmin'), findsOneWidget);
    expect(find.text('绑定'), findsNothing);
    expect(find.text('佳明账号需关闭两步验证（暂不支持 MFA）'), findsNothing);
  });

  testWidgets('COROS form: phone-or-email placeholder, no region, no MFA hint',
      (tester) async {
    final api = _StubApi();
    await _pump(tester, api);

    await tester.tap(find.text('COROS'));
    await tester.pump();

    expect(find.text('COROS 高驰'), findsOneWidget);
    expect(find.text('邮箱或手机号'), findsOneWidget);
    expect(find.text('账号区域'), findsNothing);
    expect(find.text('佳明账号需关闭两步验证（暂不支持 MFA）'), findsNothing);
  });

  testWidgets('Garmin form: email placeholder, region picker, MFA hint',
      (tester) async {
    final api = _StubApi();
    await _pump(tester, api);

    await tester.tap(find.text('Garmin'));
    await tester.pump();

    expect(find.text('Garmin 佳明'), findsOneWidget);
    expect(find.text('邮箱'), findsOneWidget);
    expect(find.text('账号区域'), findsOneWidget);
    expect(find.text('中国区'), findsOneWidget);
    expect(find.text('佳明账号需关闭两步验证（暂不支持 MFA）'), findsOneWidget);
  });

  testWidgets('?provider=garmin opens the Garmin form directly',
      (tester) async {
    await _pump(tester, _StubApi(), provider: 'garmin');

    expect(find.text('Garmin 佳明'), findsOneWidget);
    expect(find.text('账号区域'), findsOneWidget);
    // 品牌网格不再出现。
    expect(find.text('COROS'), findsNothing);
  });

  testWidgets('bind: submits provider/email/region, clears form, jumps to '
      'onboarding', (tester) async {
    final api = _StubApi();
    await _pump(tester, api, provider: 'garmin');

    await tester.enterText(
      find.widgetWithText(TextField, '邮箱'),
      'runner@example.com',
    );
    await tester.pump();
    await tester.enterText(
      find.widgetWithText(TextField, '密码'),
      'secret',
    );
    await tester.pump();
    await tester.tap(find.text('国际区'));
    await tester.pump();
    await tester.tap(find.text('绑定'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));

    expect(api.loginCalls, 1);
    expect(api.loginProvider, 'garmin');
    expect(api.loginEmail, 'runner@example.com');
    expect(api.loginRegion, 'global');
    expect(find.text('ONBOARDING'), findsOneWidget);
  });

  testWidgets('bind failure shows the server error body inline', (tester) async {
    final api = _StubApi();
    api.loginError = const ApiException(
      400,
      'HTTP 400',
      {'error': '邮箱或密码错误'},
    );
    await _pump(tester, api, provider: 'coros');

    await tester.enterText(
      find.widgetWithText(TextField, '邮箱或手机号'),
      '13800000000',
    );
    await tester.pump();
    await tester.enterText(
      find.widgetWithText(TextField, '密码'),
      'secret',
    );
    await tester.pump();
    await tester.tap(find.text('绑定'));
    await tester.pump();
    await tester.pump();

    expect(api.loginCalls, 1);
    expect(find.text('邮箱或密码错误'), findsOneWidget);
    expect(find.text('ONBOARDING'), findsNothing);
  });

  testWidgets('bound card shows provider/email/device/caps; unbind is an '
      'inline confirm', (tester) async {
    final api = _StubApi();
    api.watch = const WatchInfo(
      provider: 'coros',
      providerDisplayName: '高驰',
      loggedIn: true,
      email: 'runner@example.com',
      device: 'COROS PACE 3',
      lastSyncAt: '2020-01-01T00:00:00Z',
      capabilities: ['activity_sync', 'health_sync'],
    );
    await _pump(tester, api);

    expect(find.text('高驰'), findsOneWidget);
    expect(find.text('runner@example.com'), findsOneWidget);
    expect(find.text('COROS PACE 3'), findsOneWidget);
    expect(find.text('已连接'), findsOneWidget);
    expect(find.text('activity_sync'), findsOneWidget);
    expect(find.text('最后同步'), findsOneWidget);

    // 内联确认（非模态）：解除按钮点击后确认按钮出现在同一卡片里。
    // 注意「解除绑定」同时是 danger 卡片标题与按钮文案，按按钮类型找。
    await tester.tap(find.widgetWithText(OutlinedButton, '解除绑定'));
    await tester.pump();
    expect(find.text('确认解除'), findsOneWidget);
    expect(find.byType(AlertDialog), findsNothing);

    await tester.tap(find.text('确认解除'));
    await tester.pump();
    await tester.pump();
    expect(api.unbindCalls, 1);
  });
}
