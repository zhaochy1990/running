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
import '../../features/profile/notification_rationale_screen.dart';
import '../../features/profile/notification_settings_screen.dart';
import '../../features_v2/coach/coach_chat_screen.dart';
import '../../features_v2/discover/discover_screen.dart';
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
import '../../features_v2/feedback/post_activity_feedback_screen.dart';
import '../../features_v2/plan/generate_week_screen.dart';
import '../../features_v2/plan/plan_chat_screen.dart';
import '../../features_v2/plan/pre_training_screen.dart';
import '../../features_v2/training_plan/adjust_screen.dart';
import '../../features_v2/training_plan/generate_screen.dart';
import '../../features_v2/training_plan/goal_screen.dart';
import '../../features_v2/training_plan/history_screen.dart';
import '../../features_v2/training_plan/history_sync_screen.dart';
import '../../features_v2/training_plan/master_plan_view_screen.dart';
import '../../features_v2/training_plan/profile_screen.dart';
import '../../features_v2/training_plan/review_screen.dart';
import '../../features_v2/training_plan/version_screen.dart';
import '../../features_v2/plan/session_detail_screen.dart';
import '../../features_v2/plan/week_detail_screen.dart';
import '../../features_v2/plan/week_list_screen.dart';
import '../../features_v2/nutrition/daily_advice_screen.dart';
import '../../features_v2/nutrition/meal_log_screen.dart';
import '../../features_v2/nutrition/prefs_screen.dart';
import '../../features_v2/review/week_review_screen.dart';
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
      GoRoute(
        path: RoutesV2.preTrainingPattern,
        builder: (_, state) => PreTrainingScreen(
          date: state.pathParameters['date']!,
          sessionIndex: int.parse(state.pathParameters['sessionIndex']!),
        ),
      ),
      GoRoute(
        path: RoutesV2.feedbackPattern,
        builder: (_, state) => PostActivityFeedbackScreen(
          labelId: state.pathParameters['labelId']!,
          activityName: state.extra as String?,
        ),
      ),
      GoRoute(
        path: RoutesV2.reviewPattern,
        builder: (_, state) => WeekReviewScreen(
          folder: state.pathParameters['folder']!,
        ),
      ),
      GoRoute(
        path: RoutesV2.planChatPattern,
        builder: (_, state) => PlanChatScreen(
          folder: state.pathParameters['folder']!,
        ),
      ),
      GoRoute(
        path: RoutesV2.weekDetailPattern,
        builder: (_, state) => WeekDetailScreen(
          folder: state.pathParameters['folder']!,
        ),
      ),
      GoRoute(
        path: RoutesV2.sessionDetailPattern,
        builder: (_, state) => SessionDetailScreen(
          folder: state.pathParameters['folder']!,
          date: state.pathParameters['date']!,
          sessionIndex: int.parse(state.pathParameters['sessionIndex']!),
        ),
      ),
      GoRoute(
        path: RoutesV2.generatePattern,
        builder: (_, state) => GenerateWeekScreen(
          weekStart: state.uri.queryParameters['week_start'] ?? '',
        ),
      ),
      // C1 — Training goal
      GoRoute(
        path: RoutesV2.trainingPlanGoal,
        builder: (_, _) => const TrainingGoalScreen(),
      ),
      // C2 — Running profile
      GoRoute(
        path: RoutesV2.trainingPlanProfile,
        builder: (_, _) => const RunningProfileScreen(),
      ),
      // C3 — 3-year history sync
      GoRoute(
        path: RoutesV2.trainingPlanHistorySync,
        builder: (_, _) => const HistorySyncScreen(),
      ),
      // C4 — Master plan generation
      GoRoute(
        path: RoutesV2.trainingPlanGenerate,
        builder: (_, _) => const MasterPlanGenerateScreen(),
      ),
      // C5 — Master plan review chat
      GoRoute(
        path: RoutesV2.trainingPlanReviewPattern,
        builder: (_, state) => MasterPlanReviewScreen(
          planId: state.pathParameters['planId']!,
        ),
      ),
      // C6 — Master plan view
      GoRoute(
        path: RoutesV2.trainingPlanView,
        builder: (_, _) => const MasterPlanViewScreen(),
      ),
      // C7 — Master plan adjust chat
      GoRoute(
        path: RoutesV2.trainingPlanAdjustPattern,
        builder: (_, state) => MasterPlanAdjustScreen(
          planId: state.pathParameters['planId']!,
        ),
      ),
      // C8 — Master plan adjustment history
      GoRoute(
        path: RoutesV2.trainingPlanHistoryPattern,
        builder: (_, state) => MasterPlanHistoryScreen(
          planId: state.pathParameters['planId']!,
        ),
      ),
      // C8 — Master plan version snapshot
      GoRoute(
        path: RoutesV2.trainingPlanVersionPattern,
        builder: (_, state) => MasterPlanVersionScreen(
          planId: state.pathParameters['planId']!,
          version: int.parse(state.pathParameters['version']!),
        ),
      ),
      // E2 — PMC training load
      GoRoute(
        path: RoutesV2.dataPmc,
        builder: (_, _) => const PmcScreen(),
      ),
      // E3 — Health trends detail
      GoRoute(
        path: RoutesV2.dataTrends,
        builder: (_, _) => const TrendsScreen(),
      ),
      // E4 — Ability radar
      GoRoute(
        path: RoutesV2.abilityRadar,
        builder: (_, _) => const AbilityRadarScreen(),
      ),
      // E5 — Race predictions
      GoRoute(
        path: RoutesV2.predictions,
        builder: (_, _) => const PredictionsScreen(),
      ),
      // E6 — PB records
      GoRoute(
        path: RoutesV2.pbRecords,
        builder: (_, _) => const PbRecordsScreen(),
      ),
      // M5 — Nutrition
      GoRoute(
        path: RoutesV2.nutritionPrefs,
        builder: (_, _) => const NutritionPrefsScreen(),
      ),
      GoRoute(
        path: RoutesV2.nutritionDaily,
        builder: (_, _) => const DailyAdviceScreen(),
      ),
      GoRoute(
        path: RoutesV2.nutritionMeals,
        builder: (_, _) => const MealLogScreen(),
      ),
      // Notification screens (carried over from the legacy router; pushed by
      // the post-login bootstrap and the account drawer / profile page).
      GoRoute(
        path: '/notifications/rationale',
        builder: (_, _) => const NotificationRationaleScreen(),
      ),
      GoRoute(
        path: '/notifications/settings',
        builder: (_, _) => const NotificationSettingsScreen(),
      ),
      // Non-tab full-page destinations (no bottom bar).
      GoRoute(
        path: RoutesV2.train,
        builder: (_, _) => const WeekListScreen(),
      ),
      GoRoute(
        path: RoutesV2.me,
        builder: (_, _) => const ProfileScreen(),
      ),
      // 4 flat tabs: 跑者 / 发现 / 数据 / 教练.
      ShellRoute(
        builder: (_, _, child) => MainShellV2(child: child),
        routes: [
          GoRoute(
            path: RoutesV2.home,
            builder: (_, _) => const HomeScreen(),
          ),
          GoRoute(
            path: RoutesV2.discover,
            builder: (_, _) => const DiscoverScreen(),
          ),
          GoRoute(
            path: RoutesV2.data,
            builder: (_, _) => const HealthOverviewScreen(),
          ),
          GoRoute(
            path: RoutesV2.coach,
            builder: (_, _) => const CoachChatScreen(),
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
