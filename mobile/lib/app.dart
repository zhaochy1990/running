import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:go_router/go_router.dart';

import 'core/auth/auth_controller.dart';
import 'core/notifications/jpush_service.dart';
import 'core/notifications/rationale_storage.dart';
import 'core/router/app_router.dart';
import 'core/theme/app_theme.dart';

class StrideApp extends ConsumerStatefulWidget {
  const StrideApp({super.key});

  @override
  ConsumerState<StrideApp> createState() => _StrideAppState();
}

class _StrideAppState extends ConsumerState<StrideApp> {
  bool _bootstrapTriggered = false;

  @override
  Widget build(BuildContext context) {
    final router = ref.watch(appRouterProvider);

    // When auth becomes Authenticated, kick off post-login work exactly once
    // per app instance: show the rationale screen (first launch) or
    // silently init JPush (returning user with permission already granted).
    ref.listen<AuthState>(authControllerProvider, (_, next) async {
      if (next is! AuthAuthenticated) {
        _bootstrapTriggered = false;
        return;
      }
      if (_bootstrapTriggered) return;
      _bootstrapTriggered = true;
      await _onAuthenticated(router);
    });

    return MaterialApp.router(
      title: 'STRIDE',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      routerConfig: router,
    );
  }

  Future<void> _onAuthenticated(GoRouter router) async {
    final shown = await RationaleStorage().hasShown();
    if (!shown) {
      // Defer to next frame so the post-login redirect to /today completes
      // first; pushing onto /today gives a clean back-stack.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        router.push('/notifications/rationale');
      });
      return;
    }
    // Returning user — init JPush silently.
    try {
      final jpush = ref.read(jpushServiceProvider);
      await jpush.init(
        appKey: 'ab305c4addc8f9aa2b5efb4c',
        channel: 'default',
        production: true,
      );
      await jpush.registerOnServer(appVersion: '2026.5.0');
    } catch (_) {
      // Best-effort.
    }
  }
}
