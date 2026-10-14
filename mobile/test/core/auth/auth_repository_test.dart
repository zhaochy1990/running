import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/core/api/api_client.dart';
import 'package:stride/core/auth/auth_models.dart';
import 'package:stride/core/auth/auth_repository.dart';
import 'package:stride/core/auth/token_storage.dart';
import 'package:stride/core/env/env.dart';

import '../../helpers/fake_secure_storage.dart';

TokenStorage _storage() => TokenStorage(FakeSecureStorage());

const _tokenBody = {
  'access_token': 'at-1',
  'refresh_token': 'rt-1',
  'token_type': 'Bearer',
  'expires_in': 3600,
};

Dio _dioResponding(
  Response<Map<String, dynamic>> Function(RequestOptions options) handle,
) {
  final dio = Dio();
  dio.interceptors.add(
    InterceptorsWrapper(
      onRequest: (options, handler) => handler.resolve(handle(options)),
    ),
  );
  return dio;
}

Response<Map<String, dynamic>> _json(
  RequestOptions options,
  int status,
  Map<String, dynamic> body,
) =>
    Response<Map<String, dynamic>>(
      requestOptions: options,
      statusCode: status,
      data: body,
    );

void main() {
  group('AuthRepository.register', () {
    test('accepts the 201 Created the Go service actually returns', () async {
      // 回归（#460）：Go register 成功回 201，旧实现只认 200 把成功当失败。
      final repo = AuthRepository(
        dio: _dioResponding(
          (o) => _json(o, 201, {..._tokenBody, 'user_id': 'u-1'}),
        ),
        storage: _storage(),
      );

      final tokens = await repo.register(
        email: 'a@b.c',
        password: 'password123',
      );

      expect(tokens.accessToken, 'at-1');
    });

    test('parses {error, message} error bodies and exposes the machine code',
        () async {
      // 回归（#460）：auth 错误体是 {error, message}，旧实现读 detail 键永远读不到。
      final repo = AuthRepository(
        dio: _dioResponding(
          (o) => _json(o, 409, {
            'error': 'invite_code_already_used',
            'message': 'Invite code has already been used',
          }),
        ),
        storage: _storage(),
      );

      await expectLater(
        repo.register(email: 'a@b.c', password: 'password123'),
        throwsA(
          isA<AuthException>()
              .having((e) => e.code, 'code', 'invite_code_already_used')
              .having((e) => e.statusCode, 'statusCode', 409)
              .having((e) => e.localized, 'localized', '邀请码已被使用'),
        ),
      );
    });
  });

  group('AuthRepository.sendSmsCode', () {
    test('posts phone + scene=login and accepts {status: ok}', () async {
      late RequestOptions captured;
      final repo = AuthRepository(
        dio: _dioResponding((o) {
          captured = o;
          return _json(o, 200, {'status': 'ok'});
        }),
        storage: _storage(),
      );

      await repo.sendSmsCode(phone: '13800138000');

      expect(captured.path, '/api/auth/sms/send');
      expect(captured.data, {'phone': '13800138000', 'scene': 'login'});
    });

    test('cooldown violations surface the machine code for Chinese mapping',
        () async {
      final repo = AuthRepository(
        dio: _dioResponding(
          (o) => _json(o, 429, {
            'error': 'sms_send_cooldown',
            'message': 'Please wait before requesting a new code',
          }),
        ),
        storage: _storage(),
      );

      await expectLater(
        repo.sendSmsCode(phone: '13800138000'),
        throwsA(
          isA<AuthException>()
              .having((e) => e.code, 'code', 'sms_send_cooldown')
              .having((e) => e.localized, 'localized', '操作过于频繁，请 1 分钟后再试'),
        ),
      );
    });
  });

  group('AuthRepository.verifySmsCode', () {
    test('exchanges a verified code for tokens and remembers the phone',
        () async {
      final storage = _storage();
      late RequestOptions captured;
      final repo = AuthRepository(
        dio: _dioResponding((o) {
          captured = o;
          return _json(o, 200, {..._tokenBody});
        }),
        storage: storage,
      );

      final tokens = await repo.verifySmsCode(
        phone: '13800138000',
        code: '123456',
      );

      expect(captured.path, '/api/auth/sms/verify');
      expect(
        captured.data,
        {'phone': '13800138000', 'code': '123456'},
      );
      expect(tokens.refreshToken, 'rt-1');
      expect(await storage.readLastSmsPhone(), '13800138000');
      // tokens 同时落了持久化存储
      expect((await storage.read())?.accessToken, 'at-1');
    });

    test('forwards the optional invite code when supplied', () async {
      late RequestOptions captured;
      final repo = AuthRepository(
        dio: _dioResponding((o) {
          captured = o;
          return _json(o, 200, {..._tokenBody});
        }),
        storage: _storage(),
      );

      await repo.verifySmsCode(
        phone: '13800138000',
        code: '123456',
        inviteCode: 'STRIDE24',
      );

      expect(
        (captured.data as Map<String, dynamic>)['invite_code'],
        'STRIDE24',
      );
    });

    test('a wrong code surfaces sms_code_invalid', () async {
      final repo = AuthRepository(
        dio: _dioResponding(
          (o) => _json(o, 400, {
            'error': 'sms_code_invalid',
            'message': 'Invalid verification code',
          }),
        ),
        storage: _storage(),
      );

      await expectLater(
        repo.verifySmsCode(phone: '13800138000', code: '000000'),
        throwsA(
          isA<AuthException>()
              .having((e) => e.code, 'code', 'sms_code_invalid')
              .having((e) => e.localized, 'localized', '验证码错误，请重试'),
        ),
      );
    });
  });

  group('ApiClient data plane', () {
    test('sends X-Client-Id on every /api/* request (#419 decision 2)',
        () async {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      final client = container.read(apiClientProvider);

      expect(
        client.dio.options.headers['X-Client-Id'],
        Env.clientId,
      );
    });
  });
}
