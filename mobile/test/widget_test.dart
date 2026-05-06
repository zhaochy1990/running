import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/app.dart';
import 'package:stride/core/auth/auth_controller.dart';
import 'package:stride/core/auth/auth_models.dart';
import 'package:stride/core/auth/current_user.dart';

void main() {
  testWidgets('Unauthenticated user lands on login screen', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          authControllerProvider.overrideWith(
            (ref) => _StaticAuthController(
              ref.read(authRepositoryProvider),
              const AuthUnauthenticated(),
            ),
          ),
        ],
        child: const StrideApp(),
      ),
    );
    await tester.pumpAndSettle();
    // Login screen has 邮箱 / 密码 fields
    expect(find.text('邮箱'), findsOneWidget);
    expect(find.text('密码'), findsOneWidget);
    expect(find.text('马拉松训练数据 · 跑团社区'), findsOneWidget);
  });

  testWidgets('Authenticated user boots into Today tab', (tester) async {
    final fakeTokens = TokenSet(
      accessToken: 'fake-access',
      refreshToken: 'fake-refresh',
      expiresAt: DateTime.now().toUtc().add(const Duration(hours: 1)),
    );
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          authControllerProvider.overrideWith(
            (ref) => _StaticAuthController(
              ref.read(authRepositoryProvider),
              AuthAuthenticated(fakeTokens),
            ),
          ),
          // Suppress network call to /api/users/me/profile in tests.
          currentUserProvider.overrideWith((_) async => null),
        ],
        child: const StrideApp(),
      ),
    );
    // Pump frames without settling (StreamBuilders never resolve in tests).
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('今日'), findsWidgets);
    expect(find.text('体能'), findsOneWidget);
    expect(find.text('战队'), findsOneWidget);
    expect(find.text('计划'), findsOneWidget);
    expect(find.text('我的'), findsOneWidget);
  });
}

/// Test-only AuthController that skips the constructor's _hydrate() call by
/// immediately overwriting state.
class _StaticAuthController extends AuthController {
  _StaticAuthController(super.repo, AuthState initialState) {
    state = initialState;
  }
}
