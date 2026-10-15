import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/core/auth/auth_controller.dart';
import 'package:stride/core/auth/auth_repository.dart';
import 'package:stride/core/auth/token_storage.dart';
import 'package:stride/features_v2/auth/login_screen.dart';

import '../../helpers/fake_secure_storage.dart';

/// 每个用例只发一个请求，单响应假后端即够。
Dio _dioWithResponse(
  int status,
  Map<String, dynamic> body, {
  void Function(RequestOptions options)? inspect,
}) {
  final dio = Dio();
  dio.interceptors.add(
    InterceptorsWrapper(
      onRequest: (options, handler) {
        inspect?.call(options);
        handler.resolve(
          Response<Map<String, dynamic>>(
            requestOptions: options,
            statusCode: status,
            data: body,
          ),
        );
      },
    ),
  );
  return dio;
}

const _tokenBody = {
  'access_token': 'at-1',
  'refresh_token': 'rt-1',
  'token_type': 'Bearer',
  'expires_in': 3600,
};

Future<void> _pump(
  WidgetTester tester,
  Dio dio,
  FakeSecureStorage storage,
) async {
  final repo = AuthRepository(dio: dio, storage: TokenStorage(storage));
  await tester.pumpWidget(
    ProviderScope(
      overrides: [authRepositoryProvider.overrideWithValue(repo)],
      child: const MaterialApp(home: AuthLoginScreen()),
    ),
  );
  await tester.pump();
}

void main() {
  testWidgets('defaults to the SMS tab (mirror of the miniprogram login)',
      (tester) async {
    final storage = FakeSecureStorage();
    await _pump(tester, _dioWithResponse(200, {'status': 'ok'}), storage);

    expect(find.byKey(const Key('login-phone')), findsOneWidget);
    expect(find.byKey(const Key('login-code')), findsOneWidget);
    expect(find.byKey(const Key('login-send-code')), findsOneWidget);
    // 邮箱 tab 的输入框不可见
    expect(find.byKey(const Key('login-email')), findsNothing);
  });

  testWidgets('email tab keeps the legacy fields and register entry',
      (tester) async {
    final storage = FakeSecureStorage();
    await _pump(tester, _dioWithResponse(200, {'status': 'ok'}), storage);

    await tester.tap(find.byKey(const Key('login-tab-1')));
    await tester.pump();

    expect(find.byKey(const Key('login-email')), findsOneWidget);
    expect(find.byKey(const Key('login-password')), findsOneWidget);
    expect(find.text('还没有账号？去注册'), findsOneWidget);
    expect(find.byKey(const Key('login-send-code')), findsNothing);
  });

  testWidgets('blocks submit until the agreement checkbox is ticked',
      (tester) async {
        final storage = FakeSecureStorage();
        var requests = 0;
        await _pump(
          tester,
          _dioWithResponse(200, {..._tokenBody}, inspect: (_) => requests++),
          storage,
        );

        await tester.enterText(
            find.byKey(const Key('login-phone')), '13800138000');
        await tester.enterText(find.byKey(const Key('login-code')), '123456');
        await tester.pump();

        await tester.tap(find.widgetWithText(FilledButton, '登录').first);
        await tester.pump();

        expect(
          find.text('请先阅读并勾选同意《用户协议》和《隐私政策》'),
          findsOneWidget,
        );
        // 未勾选协议时一个请求都不该发
        expect(requests, 0);
      });

  testWidgets('blocks sending SMS until the agreement checkbox is ticked',
      (tester) async {
    final storage = FakeSecureStorage();
    var requests = 0;
    await _pump(
      tester,
      _dioWithResponse(200, {'status': 'ok'}, inspect: (_) => requests++),
      storage,
    );

    await tester.enterText(
        find.byKey(const Key('login-phone')), '13800138000');
    await tester.pump();
    await tester.tap(find.byKey(const Key('login-send-code')));
    await tester.pump();

    expect(
      find.text('请先阅读并勾选同意《用户协议》和《隐私政策》'),
      findsOneWidget,
    );
    // 未勾选协议时一个短信请求都不该发（#540 合规门槛）
    expect(requests, 0);
  });

  testWidgets('sends a code for a valid phone and starts the 60s countdown',
      (tester) async {
    final storage = FakeSecureStorage();
    var requests = 0;
    late RequestOptions captured;
    await _pump(
      tester,
      _dioWithResponse(200, {'status': 'ok'}, inspect: (o) {
        requests++;
        captured = o;
      }),
      storage,
    );

    await tester.enterText(
        find.byKey(const Key('login-phone')), '13800138000');
    await tester.tap(find.byKey(const Key('login-agree')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('login-send-code')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(requests, 1);
    expect(captured.data, {'phone': '13800138000', 'scene': 'login'});
    expect(find.text('60 s'), findsOneWidget);
  });

  testWidgets('a malformed phone never leaves the client', (tester) async {
    final storage = FakeSecureStorage();
    var requests = 0;
    await _pump(
      tester,
      _dioWithResponse(200, {'status': 'ok'}, inspect: (_) => requests++),
      storage,
    );

    await tester.tap(find.byKey(const Key('login-agree')));
    await tester.enterText(find.byKey(const Key('login-phone')), '12345');
    await tester.pump();
    await tester.tap(find.byKey(const Key('login-send-code')));
    await tester.pump();

    expect(find.text('请输入正确的手机号'), findsOneWidget);
    expect(requests, 0);
  });

  testWidgets('maps cooldown violations to Chinese in the error area',
      (tester) async {
    final storage = FakeSecureStorage();
    await _pump(
      tester,
      _dioWithResponse(429, {
        'error': 'sms_send_cooldown',
        'message': 'Please wait',
      }),
      storage,
    );

    await tester.tap(find.byKey(const Key('login-agree')));
    await tester.enterText(
        find.byKey(const Key('login-phone')), '13800138000');
    await tester.pump();
    await tester.tap(find.byKey(const Key('login-send-code')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.text('操作过于频繁，请 1 分钟后再试'), findsOneWidget);
    // 发送失败不启动倒计时
    expect(find.text('60 s'), findsNothing);
  });

  testWidgets('SMS login with a verified code reaches AuthAuthenticated',
      (tester) async {
    final storage = FakeSecureStorage();
    late RequestOptions captured;
    await _pump(
      tester,
      _dioWithResponse(200, {..._tokenBody}, inspect: (o) => captured = o),
      storage,
    );

    await tester.enterText(
        find.byKey(const Key('login-phone')), '13800138000');
    await tester.enterText(find.byKey(const Key('login-code')), '123456');
    await tester.tap(find.byKey(const Key('login-agree')));
    await tester.pump();

    final button = find.widgetWithText(FilledButton, '登录');
    await tester.tap(button.first);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    final container = ProviderScope.containerOf(
      tester.element(find.byType(AuthLoginScreen)),
    );
    expect(container.read(authControllerProvider), isA<AuthAuthenticated>());
    expect(captured.path, '/api/auth/sms/verify');
  });

  testWidgets('prefills the phone remembered from the previous SMS login',
      (tester) async {
    final storage = FakeSecureStorage();
    storage.store['stride.sms.phone.v1'] = '13900139000';
    await _pump(tester, _dioWithResponse(200, {'status': 'ok'}), storage);
    await tester.pump(const Duration(milliseconds: 10));

    final phoneField = tester.widget<TextField>(
      find.byKey(const Key('login-phone')),
    );
    expect(phoneField.controller!.text, '13900139000');
  });
}
