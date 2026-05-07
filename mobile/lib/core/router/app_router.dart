import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features/activity/activity_detail_screen.dart';
import '../../features/health/health_screen.dart';
import '../../features/login/login_screen.dart';
import '../../features/plan/plan_screen.dart';
import '../../features/profile/notification_rationale_screen.dart';
import '../../features/profile/notification_settings_screen.dart';
import '../../features/profile/profile_screen.dart';
import '../../features/teams/team_detail_screen.dart';
import '../../features/teams/teams_screen.dart';
import '../../features/today/today_screen.dart';
import '../auth/auth_controller.dart';
import 'main_shell.dart';

/// Top-level GoRouter configuration.
///
/// Auth-guard redirect: anonymous users land on /login. Authenticated
/// users hitting /login get bounced to /today.
///
/// AuthLoading state suspends navigation (returns initial location, the
/// hydrate flow finishes within ~100ms in normal conditions).
final appRouterProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    initialLocation: '/today',
    refreshListenable: _AuthRefreshNotifier(ref),
    redirect: (context, state) {
      final authState = ref.read(authControllerProvider);
      final loc = state.matchedLocation;

      // While hydrating tokens, do not redirect — let the splash render.
      if (authState is AuthLoading) return null;

      final isAuthed = authState is AuthAuthenticated;
      final goingToLogin = loc == '/login';

      if (!isAuthed && !goingToLogin) return '/login';
      if (isAuthed && goingToLogin) return '/today';
      return null;
    },
    routes: [
      GoRoute(
        path: '/login',
        builder: (_, _) => const LoginScreen(),
      ),
      GoRoute(
        path: '/activity/:id',
        builder: (_, state) {
          final id = state.pathParameters['id']!;
          return ActivityDetailScreen(activityId: id);
        },
      ),
      GoRoute(
        path: '/teams/:teamId/activity/:userId/:labelId',
        builder: (_, state) {
          return ActivityDetailScreen(
            activityId: state.pathParameters['labelId']!,
            teamId: state.pathParameters['teamId'],
            ownerUserId: state.pathParameters['userId'],
          );
        },
      ),
      GoRoute(
        path: '/teams/:teamId',
        builder: (_, state) {
          return TeamDetailScreen(teamId: state.pathParameters['teamId']!);
        },
      ),
      GoRoute(
        path: '/notifications/rationale',
        builder: (_, _) => const NotificationRationaleScreen(),
      ),
      GoRoute(
        path: '/notifications/settings',
        builder: (_, _) => const NotificationSettingsScreen(),
      ),
      ShellRoute(
        builder: (_, _, child) => MainShell(child: child),
        routes: [
          GoRoute(path: '/today', builder: (_, _) => const TodayScreen()),
          GoRoute(path: '/health', builder: (_, _) => const HealthScreen()),
          GoRoute(path: '/teams', builder: (_, _) => const TeamsScreen()),
          GoRoute(path: '/plan', builder: (_, _) => const PlanScreen()),
          GoRoute(path: '/profile', builder: (_, _) => const ProfileScreen()),
        ],
      ),
    ],
  );
});

/// Bridges Riverpod's auth state changes into GoRouter's redirect refresh.
class _AuthRefreshNotifier extends ChangeNotifier {
  _AuthRefreshNotifier(Ref ref) {
    ref.listen<AuthState>(
      authControllerProvider,
      (_, _) => notifyListeners(),
      fireImmediately: false,
    );
  }
}
