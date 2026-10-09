import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features_v2/_shared/shell/main_shell.dart';
import '../../features_v2/activity/activity_detail_screen.dart';
import '../../features_v2/health/health_overview_screen.dart';
import '../../features_v2/health/ability_radar_screen.dart';
import '../../features_v2/health/pb_records_screen.dart';
import '../../features_v2/health/pmc_screen.dart';
import '../../features_v2/health/predictions_screen.dart';
import '../../features_v2/health/trends_screen.dart';
import '../../features_v2/coach/coach_chat_screen.dart';
import '../../features_v2/records/records_screen.dart';
import '../../features_v2/training/training_screen.dart';
import '../../features_v2/watch/watch_screen.dart';
import '../../features_v2/profile/profile_screen.dart';
import '../../features_v2/auth/login_screen.dart';
import '../../features_v2/auth/register_screen.dart';
import '../../features_v2/auth/start_screen.dart';
import '../../features_v2/onboarding/basic_info_screen.dart';
import '../../features_v2/onboarding/blocked_screen.dart';
import '../../features_v2/onboarding/brand_screen.dart';
import '../../features_v2/onboarding/coros_link_screen.dart';
import '../../features_v2/onboarding/sync_progress_screen.dart';
import '../../features_v2/plan/session_detail_screen.dart';
import '../../features_v2/plan/week_list_screen.dart';
import '../../features_v2/plan/week_detail_screen.dart';
import '../../features_v2/plan/week_list_screen.dart';
import '../auth/auth_controller.dart';
import '../auth/current_user.dart';
import 'routes.dart';

/// GoRouter — IA mirrors the miniprogram four tabs (训练/记录/教练/我).
///
/// Redirect rules:
///   0. Legacy /v2/* deep link -> remapped location (#414 table)
///   1. No token            -> /auth/start
///   2. Token, !onboardingComplete -> /onboarding/brand
///   3. Token, !hasWatch    -> /onboarding/blocked
///   4. else                -> as requested
///
/// User-state probe is wrapped in try/catch — on any failure we conservatively
/// route to /onboarding/blocked (assume logged in, not bound).
final appRouterProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    initialLocation: Routes.training,
    refreshListenable: _AuthRefreshNotifier(ref),
    redirect: (context, state) {
      final authState = ref.read(authControllerProvider);
      final loc = state.matchedLocation;

      // Deep links from pushed builds still carry /v2/* paths — remap first
      // so the auth gates below see final destinations.
      final remapped = Routes.redirectLegacy(loc);
      if (remapped != null) return remapped;

      if (authState is AuthLoading) return null;

      final isAuthed = authState is AuthAuthenticated;
      final inAuthFlow = loc.startsWith('/auth');
      final inOnboarding = loc.startsWith('/onboarding');

      if (!isAuthed) {
        if (inAuthFlow) return null;
        return Routes.authStart;
      }

      // Authed: try to inspect onboarding/watch state.
      try {
        final userAsync = ref.read(currentUserProvider);
        final user = userAsync.valueOrNull;
        if (user == null) {
          // Profile still loading — don't bounce yet.
          if (inAuthFlow) return Routes.training;
          return null;
        }
        final onboardingComplete = user.onboarding.completedAt != null;
        final hasWatch = user.onboarding.corosReady;

        if (!onboardingComplete) {
          if (inOnboarding) return null;
          return Routes.onboardingBrand;
        }
        if (!hasWatch) {
          if (loc == Routes.onboardingBlocked) return null;
          return Routes.onboardingBlocked;
        }
        if (inAuthFlow) return Routes.training;
        return null;
      } catch (_) {
        // Conservative fallback: assume not bound.
        if (loc == Routes.onboardingBlocked) return null;
        return Routes.onboardingBlocked;
      }
    },
    routes: [
      GoRoute(
        path: Routes.authStart,
        builder: (_, _) => const AuthStartScreen(),
      ),
      GoRoute(
        path: Routes.authLogin,
        builder: (_, _) => const AuthLoginScreen(),
      ),
      GoRoute(
        path: Routes.authRegister,
        builder: (_, _) => const AuthRegisterScreen(),
      ),
      GoRoute(
        path: Routes.onboardingBrand,
        builder: (_, _) => const BrandScreen(),
      ),
      GoRoute(
        path: Routes.onboardingCoros,
        builder: (_, _) => const CorosLinkScreen(),
      ),
      GoRoute(
        path: Routes.onboardingSync,
        builder: (_, _) => const SyncProgressScreen(),
      ),
      GoRoute(
        path: Routes.onboardingBasicInfo,
        builder: (_, _) => const BasicInfoScreen(),
      ),
      GoRoute(
        path: Routes.onboardingBlocked,
        builder: (_, _) => const BlockedScreen(),
      ),
      GoRoute(
        path: Routes.activityDetailPattern,
        builder: (_, state) => ActivityDetailScreen(
          activityId: state.pathParameters['id']!,
        ),
      ),
      GoRoute(
        path: Routes.planWeeks,
        builder: (_, _) => const WeekListScreen(),
      ),
      GoRoute(
        path: Routes.weekDetailPattern,
        builder: (_, state) => WeekDetailScreen(
          folder: state.pathParameters['folder']!,
        ),
      ),
      GoRoute(
        path: Routes.sessionDetailPattern,
        builder: (_, state) => SessionDetailScreen(
          folder: state.pathParameters['folder']!,
          date: state.pathParameters['date']!,
          sessionIndex: int.parse(state.pathParameters['sessionIndex']!),
        ),
      ),
      // Me — second-level pages.
      GoRoute(
        path: Routes.meData,
        builder: (_, _) => const HealthOverviewScreen(),
      ),
      GoRoute(path: Routes.meDataPmc, builder: (_, _) => const PmcScreen()),
      GoRoute(
        path: Routes.meDataTrends,
        builder: (_, _) => const TrendsScreen(),
      ),
      GoRoute(
        path: Routes.meDataAbility,
        builder: (_, _) => const AbilityRadarScreen(),
      ),
      GoRoute(
        path: Routes.meDataPredictions,
        builder: (_, _) => const PredictionsScreen(),
      ),
      GoRoute(
        path: Routes.meDataPbs,
        builder: (_, _) => const PbRecordsScreen(),
      ),
      GoRoute(
        path: Routes.meWatch,
        builder: (_, _) => const WatchScreen(),
      ),
      // 4 flat tabs mirroring the miniprogram: 训练 / 记录 / 教练 / 我.
      ShellRoute(
        builder: (_, _, child) => MainShell(child: child),
        routes: [
          GoRoute(
            path: Routes.training,
            builder: (_, _) => const TrainingScreen(),
          ),
          GoRoute(
            path: Routes.records,
            builder: (_, _) => const RecordsScreen(),
          ),
          GoRoute(
            path: Routes.coach,
            builder: (_, _) => const CoachChatScreen(),
          ),
          GoRoute(path: Routes.me, builder: (_, _) => const MeScreen()),
        ],
      ),
    ],
  );
});

class _AuthRefreshNotifier extends ChangeNotifier {
  _AuthRefreshNotifier(Ref ref) {
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
