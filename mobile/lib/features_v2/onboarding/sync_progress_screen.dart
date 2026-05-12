/// B3 — first-sync progress (full-screen immersive).
///
/// Blocks back navigation via PopScope; on terminal `done` state
/// routes forward to /v2/onboarding/basic-info. On error shows a
/// retry button that restarts the sync.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/router/routes_v2.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../auth/start_screen.dart' show StrideAuthPrimaryButton;
import 'providers/sync_progress_provider.dart';

class SyncProgressScreen extends ConsumerWidget {
  const SyncProgressScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(syncProgressProvider);

    ref.listen<SyncProgress>(syncProgressProvider, (prev, next) {
      if (next.phase == SyncPhase.done &&
          (prev?.phase ?? SyncPhase.starting) != SyncPhase.done) {
        context.go(RoutesV2.onboardingBasicInfo);
      }
    });

    return PopScope(
      canPop: false,
      child: Scaffold(
        backgroundColor: StrideTokens.bg,
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.symmetric(
                horizontal: StrideTokens.space2xl),
            child: Column(
              children: [
                const Spacer(flex: 2),
                if (state.phase == SyncPhase.error)
                  _ErrorBlock(message: state.error ?? '同步失败，请重试')
                else
                  _ProgressBlock(state: state),
                const Spacer(flex: 1),
                _StatsCard(state: state),
                const Spacer(flex: 2),
                if (state.phase == SyncPhase.error)
                  StrideAuthPrimaryButton(
                    label: '重试',
                    onPressed: () =>
                        ref.read(syncProgressProvider.notifier).retry(),
                  ),
                const SizedBox(height: StrideTokens.space2xl),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ProgressBlock extends StatelessWidget {
  const _ProgressBlock({required this.state});
  final SyncProgress state;

  String get _caption {
    if (state.message != null && state.message!.isNotEmpty) {
      return state.message!;
    }
    switch (state.phase) {
      case SyncPhase.login:
        return '正在登录 COROS...';
      case SyncPhase.activities:
        final n = state.syncedActivities;
        return n != null ? '同步活动 $n' : '同步活动数据...';
      case SyncPhase.health:
        return '同步健康数据...';
      case SyncPhase.done:
        return '同步完成';
      case SyncPhase.error:
        return '同步失败';
      case SyncPhase.starting:
        return '正在准备...';
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        const SizedBox(
          width: 56,
          height: 56,
          child: CircularProgressIndicator(
            strokeWidth: 3,
            color: StrideTokens.accent,
          ),
        ),
        const SizedBox(height: StrideTokens.space2xl),
        Text(
          _caption,
          textAlign: TextAlign.center,
          style: const TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs15,
            color: StrideTokens.fg,
            fontWeight: FontWeight.w500,
            height: 1.5,
          ),
        ),
        if (state.percent > 0) ...[
          const SizedBox(height: StrideTokens.spaceMd),
          Text(
            '${state.percent}%',
            style: const TextStyle(
              fontFamily: AppTypography.fontMono,
              fontSize: StrideTokens.fs13,
              color: StrideTokens.muted,
            ),
          ),
        ],
      ],
    );
  }
}

class _ErrorBlock extends StatelessWidget {
  const _ErrorBlock({required this.message});
  final String message;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        const Icon(Icons.error_outline,
            size: 56, color: StrideTokens.danger),
        const SizedBox(height: StrideTokens.space2xl),
        Text(
          message,
          textAlign: TextAlign.center,
          style: const TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs15,
            color: StrideTokens.fg,
            fontWeight: FontWeight.w500,
            height: 1.5,
          ),
        ),
      ],
    );
  }
}

class _StatsCard extends StatelessWidget {
  const _StatsCard({required this.state});
  final SyncProgress state;

  @override
  Widget build(BuildContext context) {
    final acts = state.syncedActivities ?? 0;
    final health = state.syncedHealth ?? 0;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(
        horizontal: StrideTokens.spaceLg,
        vertical: StrideTokens.spaceLg,
      ),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        border: Border.all(color: StrideTokens.border2),
        borderRadius: BorderRadius.circular(StrideTokens.radiusLg),
      ),
      child: Row(
        children: [
          Expanded(child: _stat('活动', acts.toString())),
          Container(
            width: 1, height: 32, color: StrideTokens.border2,
          ),
          Expanded(child: _stat('健康记录', health.toString())),
        ],
      ),
    );
  }

  Widget _stat(String label, String value) {
    return Column(
      children: [
        Text(
          value,
          style: const TextStyle(
            fontFamily: AppTypography.fontMono,
            fontSize: StrideTokens.fs20,
            color: StrideTokens.fg,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: StrideTokens.spaceXs),
        Text(
          label,
          style: const TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs12,
            color: StrideTokens.muted,
          ),
        ),
      ],
    );
  }
}
