import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features_v2/_placeholders/tab_placeholders.dart';
import '../../features_v2/_shared/shell/main_shell.dart';
import '../../features_v2/activity/activity_detail_screen.dart';
import '../../features_v2/health/health_overview_screen.dart';
import '../../features_v2/home/home_screen.dart';
import '../../features_v2/profile/profile_screen.dart';
import '../../features_v2/auth/login_screen.dart';
import '../../features_v2/auth/register_screen.dart';
import '../../features_v2/auth/start_screen.dart';
import '../../features_v2/onboarding/basic_info_screen.dart';
import '../../features_v2/onboarding/blocked_screen.dart';
import '../../features_v2/onboarding/brand_screen.dart';
import '../../features_v2/onboarding/coros_link_screen.dart';
import '../../features_v2/onboarding/sync_progress_screen.dart';
import '../auth/auth_controller.dart';
import '../auth/current_user.dart';
import 'routes_v2.dart';

/// v2 GoRouter — gated behind `--dart-define=STRIDE_V2=true` in `app.dart`.
///
/// Redirect rules:
///   1. No token            -> /v2/auth/start
///   2. Token, !onboardingComplete -> /v2/onboarding/brand
///   3. Token, !hasWatch    -> /v2/onboarding/blocked
///   4. else                -> as requested
///
/// User-state probe is wrapped in try/catch — on any failure we conservatively
/// route to /v2/onboarding/blocked (assume logged in, not bound).
final appRouterV2Provider = Provider<GoRouter>((ref) {
  return GoRouter(
    initialLocation: RoutesV2.home,
    refreshListenable: _AuthRefreshNotifierV2(ref),
    redirect: (context, state) {
      final authState = ref.read(authControllerProvider);
      final loc = state.matchedLocation;

      if (authState is AuthLoading) return null;

      final isAuthed = authState is AuthAuthenticated;
      final inAuthFlow = loc.startsWith('/v2/auth');
      final inOnboarding = loc.startsWith('/v2/onboarding');

      if (!isAuthed) {
        if (inAuthFlow) return null;
        return RoutesV2.authStart;
      }

      // Authed: try to inspect onboarding/watch state.
      try {
        final userAsync = ref.read(currentUserProvider);
        final user = userAsync.valueOrNull;
        if (user == null) {
          // Profile still loading — don't bounce yet.
          if (inAuthFlow) return RoutesV2.home;
          return null;
        }
        final onboardingComplete = user.onboarding.completedAt != null;
        final hasWatch = user.onboarding.corosReady;

        if (!onboardingComplete) {
          if (inOnboarding) return null;
          return RoutesV2.onboardingBrand;
        }
        if (!hasWatch) {
          if (loc == RoutesV2.onboardingBlocked) return null;
          return RoutesV2.onboardingBlocked;
        }
        if (inAuthFlow) return RoutesV2.home;
        return null;
      } catch (_) {
        // Conservative fallback: assume not bound.
        if (loc == RoutesV2.onboardingBlocked) return null;
        return RoutesV2.onboardingBlocked;
      }
    },
    routes: [
      GoRoute(
        path: RoutesV2.authStart,
        builder: (_, _) => const AuthStartScreen(),
      ),
      GoRoute(
        path: RoutesV2.authLogin,
        builder: (_, _) => const AuthLoginScreen(),
      ),
      GoRoute(
        path: RoutesV2.authRegister,
        builder: (_, _) => const AuthRegisterScreen(),
      ),
      GoRoute(
        path: RoutesV2.onboardingBrand,
        builder: (_, _) => const BrandScreen(),
      ),
      GoRoute(
        path: RoutesV2.onboardingCoros,
        builder: (_, _) => const CorosLinkScreen(),
      ),
      GoRoute(
        path: RoutesV2.onboardingSync,
        builder: (_, _) => const SyncProgressScreen(),
      ),
      GoRoute(
        path: RoutesV2.onboardingBasicInfo,
        builder: (_, _) => const BasicInfoScreen(),
      ),
      GoRoute(
        path: RoutesV2.onboardingBlocked,
        builder: (_, _) => const BlockedScreen(),
      ),
      GoRoute(
        path: RoutesV2.activityDetailPattern,
        builder: (_, state) => ActivityDetailScreen(
          activityId: state.pathParameters['id']!,
        ),
      ),
      ShellRoute(
        builder: (_, _, child) => MainShellV2(child: child),
        routes: [
          GoRoute(
            path: RoutesV2.home,
            builder: (_, _) => const HomeScreen(),
          ),
          GoRoute(
            path: RoutesV2.train,
            builder: (_, _) => const TrainPlaceholderScreen(),
          ),
          GoRoute(
            path: RoutesV2.data,
            builder: (_, _) => const HealthOverviewScreen(),
          ),
          GoRoute(
            path: RoutesV2.me,
            builder: (_, _) => const ProfileScreen(),
          ),
        ],
      ),
    ],
  );
});

class _AuthRefreshNotifierV2 extends ChangeNotifier {
  _AuthRefreshNotifierV2(Ref ref) {
    ref.listen<AuthState>(
      authControllerProvider,
      (_, _) => notifyListeners(),
      fireImmediately: false,
    );
    ref.listen(
      currentUserProvider,
      (_, _) => notifyListeners(),
      fireImmediately: false,
    );
  }
}
