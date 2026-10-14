import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features_v2/_shared/shell/main_shell.dart';
import '../../features_v2/activity/activity_detail_screen.dart';
import '../../features_v2/race/my_races_screen.dart';
import '../../features_v2/race/race_center_screen.dart';
import '../../features_v2/race/race_detail_screen.dart';
import '../../features_v2/race/race_strategy_screen.dart';
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
import '../../features_v2/auth/declaration_screen.dart';
import '../../features_v2/auth/login_screen.dart';
import '../../features_v2/auth/register_screen.dart';
import '../../features_v2/auth/start_screen.dart';
import '../../features_v2/onboarding/onboarding_screen.dart';
import '../../features_v2/plan/session_detail_screen.dart';
import '../../features_v2/plan/week_detail_screen.dart';
import '../../features_v2/plan/week_list_screen.dart';
import '../auth/auth_controller.dart';
import '../auth/current_user.dart';
import 'routes.dart';

/// GoRouter — IA mirrors the miniprogram four tabs (训练/记录/教练/我).
///
/// Redirect rules (stride-devops#461，blocked 死路已删):
///   0. Legacy /v2/* deep link -> remapped location (#414 table)
///   1. No token            -> /auth/start
///   2. Token, !completedAt -> /onboarding（单页三步，页面自重算落点）
///   3. else                -> as requested（无表 = 首页空态引导绑表，不再拦）
///
/// User-state probe is wrapped in try/catch — on any failure we conservatively
/// route to /onboarding to recompute the landing (不再 blocked).
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
        if (Routes.isPublicPath(loc)) return null;
        return Routes.authStart;
      }

      // Authed: try to inspect onboarding state.
      if (loc.startsWith('/declaration')) return null;
      try {
        final userAsync = ref.read(currentUserProvider);
        final user = userAsync.valueOrNull;
        if (user == null) {
          // Profile still loading — don't bounce yet.
          if (inAuthFlow) return Routes.training;
          return null;
        }
        final onboardingComplete = user.onboarding.completedAt != null;

        if (!onboardingComplete) {
          if (inOnboarding) return null;
          return Routes.onboarding;
        }
        if (inAuthFlow) return Routes.training;
        return null;
      } catch (_) {
        // Conservative fallback: recompute the landing on the onboarding page
        //（页面 refresh() 会再读一次服务端状态）。
        if (inOnboarding) return null;
        return Routes.onboarding;
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
      // 法务声明页公开可读（登录前也要能看协议）。
      GoRoute(
        path: Routes.declarationPattern,
        builder: (_, state) =>
            DeclarationScreen(docType: state.pathParameters['docType']!),
      ),
      GoRoute(
        path: Routes.onboarding,
        builder: (_, _) => const OnboardingScreen(),
      ),
      GoRoute(
        path: Routes.activityDetailPattern,
        builder: (_, state) =>
            ActivityDetailScreen(activityId: state.pathParameters['id']!),
      ),
      // Race domain（赛事域四屏，stride-devops#466）
      GoRoute(path: Routes.races, builder: (_, _) => const RaceCenterScreen()),
      GoRoute(
        path: Routes.raceDetailPattern,
        builder: (_, state) => RaceDetailScreen(
          raceId: int.parse(state.pathParameters['id']!),
        ),
      ),
      GoRoute(
        path: Routes.raceStrategyPattern,
        builder: (_, state) => RaceStrategyScreen(
          raceId: int.parse(state.pathParameters['id']!),
        ),
      ),
      GoRoute(path: Routes.myRaces, builder: (_, _) => const MyRacesScreen()),
      GoRoute(
        path: Routes.planWeeks,
        builder: (_, _) => const WeekListScreen(),
      ),
      GoRoute(
        path: Routes.weekDetailPattern,
        builder: (_, state) =>
            WeekDetailScreen(folder: state.pathParameters['folder']!),
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
        builder: (_, state) => WatchScreen(
          // ?provider=coros|garmin 直达对应品牌表单（onboarding 品牌卡跳转用）。
          initialProvider: state.uri.queryParameters['provider'],
        ),
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
