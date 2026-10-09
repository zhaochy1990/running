import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:go_router/go_router.dart';

import 'core/auth/auth_controller.dart';
import 'core/router/app_router.dart';
import 'core/theme/app_theme.dart';
import 'core/updater/update_checker.dart';
import 'features/updater/update_prompt.dart';

class StrideApp extends ConsumerStatefulWidget {
  const StrideApp({super.key});

  @override
  ConsumerState<StrideApp> createState() => _StrideAppState();
}

class _StrideAppState extends ConsumerState<StrideApp> {
  bool _updateCheckTriggered = false;

  @override
  Widget build(BuildContext context) {
    final router = ref.watch(appRouterProvider);

    // Check for a newer mobile release once per app instance, after the
    // router settles. Fully best-effort — never blocks startup.
    ref.listen<AuthState>(authControllerProvider, (_, next) async {
      if (next is! AuthAuthenticated || _updateCheckTriggered) return;
      _updateCheckTriggered = true;
      await _checkForUpdate(router);
    });

    return MaterialApp.router(
      title: 'STRIDE',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      routerConfig: router,
    );
  }

  Future<void> _checkForUpdate(GoRouter router) async {
    try {
      final info = await ref.read(updateCheckerProvider).check();
      if (info == null || !mounted) return;
      // Wait a frame so the UI has settled before the bottom sheet pops.
      WidgetsBinding.instance.addPostFrameCallback((_) async {
        final ctx = router.routerDelegate.navigatorKey.currentContext;
        if (ctx != null) {
          await showUpdatePrompt(ctx, ref, info);
        }
      });
    } catch (_) {
      // Best-effort — never block startup on the updater.
    }
  }
}
