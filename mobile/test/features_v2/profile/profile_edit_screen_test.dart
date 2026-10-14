// 个人资料编辑页自检：身份面（auth-service /api/users/me）与数据面
// （/api/users/me/profile）分库加载；身体字段保存走 PATCH、未建档走 POST。
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/core/auth/auth_user_client.dart';
import 'package:stride/data/api/stride_api.dart';
import 'package:stride/features_v2/profile/profile_edit_screen.dart';

Dio _fakeDio(Map<String, dynamic>? Function(RequestOptions) route) {
  final dio = Dio();
  dio.interceptors.add(InterceptorsWrapper(
    onRequest: (options, handler) {
      final data = route(options);
      if (data != null) {
        handler.resolve(
          Response<Map<String, dynamic>>(
            requestOptions: options,
            statusCode: 200,
            data: data,
          ),
        );
        return;
      }
      handler.reject(DioException(requestOptions: options, error: 'no route'));
    },
  ));
  return dio;
}

ProviderScope _wrap(Widget child,
    {required Dio identityDio, required Dio dataDio}) {
  return ProviderScope(
    overrides: [
      authUserClientProvider.overrideWith(
        (ref) => AuthUserClient(identityDio),
      ),
      strideApiProvider.overrideWith((ref) => StrideApi(dataDio)),
    ],
    child: MaterialApp(home: child),
  );
}

const Map<String, dynamic> _me = {
  'id': 'user-123',
  'name': '老赵',
  'email': 'z@stride.cn',
  'avatar_url': null,
};

const Map<String, dynamic> _profile = {
  'id': 'user-123',
  'display_name': '老赵',
  'profile': {
    'display_name': '老赵',
    'dob': '1990-01-01',
    'sex': 'male',
    'height_cm': 175.0,
    'weight_kg': 65.0,
    'running_age_range': '1y_3y',
  },
  'onboarding': {
    'watch_ready': true,
    'profile_ready': true,
    'completed_at': '2026-01-01T00:00:00Z',
  },
};

void main() {
  testWidgets('双库加载：昵称/邮箱来自 auth，身体字段来自数据面', (tester) async {
    final requests = <String>[];
    await tester.pumpWidget(_wrap(
      const ProfileEditScreen(),
      identityDio: _fakeDio((o) {
        requests.add(o.path);
        return o.method == 'GET' && o.path == '/api/users/me' ? _me : null;
      }),
      dataDio: _fakeDio((o) {
        requests.add(o.path);
        return o.path == '/api/users/me/profile' ? _profile : null;
      }),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.text('老赵'), findsWidgets);
    expect(find.text('z@stride.cn'), findsOneWidget);
    expect(find.text('1990-01-01'), findsOneWidget);
    expect(
      requests.toSet(),
      {'/api/users/me', '/api/users/me/profile'},
    );
  });

  testWidgets('已建档保存：PATCH 数据面，带身体字段', (tester) async {
    final bodies = <String, dynamic>{};
    await tester.pumpWidget(_wrap(
      const ProfileEditScreen(),
      identityDio: _fakeDio((o) => o.path == '/api/users/me' ? _me : null),
      dataDio: _fakeDio((o) {
        if (o.path != '/api/users/me/profile') return null;
        if (o.method == 'PATCH') {
          bodies.addAll(o.data as Map<String, dynamic>);
        }
        return _profile;
      }),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    await tester.ensureVisible(find.byKey(const Key('profile-edit-body-save')));
    await tester.pump();
    await tester.enterText(find.byKey(const Key('height-input')), '176');
    await tester.tap(find.byKey(const Key('profile-edit-body-save')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(bodies['height_cm'], 176.0);
    expect(bodies['sex'], 'male');
    expect(bodies['running_age_range'], '1y_3y');
    expect(find.text('身体数据已保存'), findsOneWidget);
  });

  testWidgets('未建档保存：整表 POST 六字段', (tester) async {
    final noProfile = Map<String, dynamic>.of(_profile)..['profile'] = null;
    Map<String, dynamic>? posted;
    await tester.pumpWidget(_wrap(
      const ProfileEditScreen(),
      identityDio: _fakeDio((o) => o.path == '/api/users/me' ? _me : null),
      dataDio: _fakeDio((o) {
        if (o.path != '/api/users/me/profile') return null;
        if (o.method == 'POST') posted = o.data as Map<String, dynamic>;
        return noProfile;
      }),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    await tester.ensureVisible(find.byKey(const Key('sex-male')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('sex-male')));
    await tester.ensureVisible(find.byKey(const Key('profile-edit-body-save')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('profile-edit-body-save')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(posted, isNotNull);
    expect(posted!['display_name'], '老赵');
    expect(posted!['sex'], 'male');
    expect(posted!.keys, containsAll(
        ['dob', 'height_cm', 'weight_kg', 'running_age_range']));
  });
}
