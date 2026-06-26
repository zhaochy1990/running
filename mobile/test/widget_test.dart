import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/app.dart';
import 'package:stride/core/auth/auth_controller.dart';
import 'package:stride/core/auth/auth_models.dart';
import 'package:stride/core/auth/current_user.dart';

void main() {
  testWidgets('Unauthenticated user lands on the auth start screen',
      (tester) async {
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
    // A1 — auth start screen: wordmark + slogan + login / register buttons.
    expect(find.text('STRIDE'), findsOneWidget);
    expect(find.text('马拉松跑步应用'), findsOneWidget);
    expect(find.text('登录'), findsOneWidget);
    expect(find.text('注册'), findsOneWidget);
  });

  testWidgets('Authenticated user boots into the 4-tab shell', (tester) async {
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
          // Suppress the network call to /api/users/me/profile in tests.
          currentUserProvider.overrideWith((_) async => null),
        ],
        child: const StrideApp(),
      ),
    );
    // Pump frames without settling (home body shows a loading spinner that
    // never resolves without a network stub).
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    // The shell always renders the 4 flat tabs regardless of body state.
    expect(find.text('跑者'), findsOneWidget);
    expect(find.text('发现'), findsOneWidget);
    expect(find.text('数据'), findsOneWidget);
    expect(find.text('教练'), findsOneWidget);
  });
}

/// Test-only AuthController that skips the constructor's _hydrate() call by
/// immediately overwriting state.
class _StaticAuthController extends AuthController {
  _StaticAuthController(super.repo, AuthState initialState) {
    state = initialState;
  }
}
