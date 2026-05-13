/// C3 — 3-year history sync screen (fullscreen, no shell, no back).
///
/// Calls POST /api/users/me/full-sync on entry, polls every 2s, then
/// auto-navigates to C4 (/v2/training-plan/generate) on completion.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/router/routes_v2.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../auth/start_screen.dart' show StrideAuthPrimaryButton;
import 'providers/history_sync_provider.dart';

class HistorySyncScreen extends ConsumerWidget {
  const HistorySyncScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(historySyncProvider);

    // Navigate to C4 when done.
    ref.listen<HistorySyncState>(historySyncProvider, (prev, next) {
      if (next.phase == HistorySyncPhase.done &&
          (prev?.phase ?? HistorySyncPhase.starting) != HistorySyncPhase.done) {
        context.go(RoutesV2.trainingPlanGenerate);
      }
    });

    return PopScope(
      canPop: false,
      child: Scaffold(
        backgroundColor: StrideTokens.bg,
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: StrideTokens.space2xl,
            ),
            child: Column(
              children: [
                const Spacer(flex: 2),
                if (state.phase == HistorySyncPhase.error)
                  _ErrorBlock(message: state.error ?? '同步失败，请重试')
                else
                  _ProgressBlock(state: state),
                const Spacer(flex: 1),
                _StatsCard(syncedCount: state.syncedCount ?? 0),
                const Spacer(flex: 2),
                if (state.phase == HistorySyncPhase.error)
                  StrideAuthPrimaryButton(
                    label: '重试',
                    onPressed: () =>
                        ref.read(historySyncProvider.notifier).retry(),
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

// ── Progress block ────────────────────────────────────────────────────────────

class _ProgressBlock extends StatelessWidget {
  const _ProgressBlock({required this.state});

  final HistorySyncState state;

  String get _caption {
    if (state.message != null && state.message!.isNotEmpty) {
      return state.message!;
    }
    return switch (state.phase) {
      HistorySyncPhase.starting => '正在准备 3 年历史数据同步…',
      HistorySyncPhase.running => '同步历史活动数据…',
      HistorySyncPhase.done => '同步完成',
      HistorySyncPhase.error => '同步失败',
    };
  }

  @override
  Widget build(BuildContext context) {
    final percent = state.percent;
    return Column(
      children: [
        SizedBox(
          width: 72,
          height: 72,
          child: Stack(
            alignment: Alignment.center,
            children: [
              CircularProgressIndicator(
                value: percent > 0 ? percent / 100.0 : null,
                strokeWidth: 4,
                color: StrideTokens.accent,
                backgroundColor: StrideTokens.border2,
              ),
              if (percent > 0)
                Text(
                  '$percent%',
                  style: const TextStyle(
                    fontFamily: AppTypography.fontMono,
                    fontSize: StrideTokens.fs12,
                    color: StrideTokens.fg,
                    fontWeight: FontWeight.w600,
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: StrideTokens.space2xl),
        const Text(
          '3 年历史数据同步',
          style: TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs18,
            color: StrideTokens.fg,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: StrideTokens.spaceSm),
        Text(
          _caption,
          textAlign: TextAlign.center,
          style: const TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs14,
            color: StrideTokens.muted,
            height: 1.5,
          ),
        ),
      ],
    );
  }
}

// ── Error block ───────────────────────────────────────────────────────────────

class _ErrorBlock extends StatelessWidget {
  const _ErrorBlock({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        const Icon(Icons.error_outline, size: 56, color: StrideTokens.danger),
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

// ── Stats card ────────────────────────────────────────────────────────────────

class _StatsCard extends StatelessWidget {
  const _StatsCard({required this.syncedCount});

  final int syncedCount;

  @override
  Widget build(BuildContext context) {
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
      child: Column(
        children: [
          Text(
            syncedCount.toString(),
            style: const TextStyle(
              fontFamily: AppTypography.fontMono,
              fontSize: StrideTokens.fs20,
              color: StrideTokens.fg,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: StrideTokens.spaceXs),
          const Text(
            '已同步活动',
            style: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs12,
              color: StrideTokens.muted,
            ),
          ),
        ],
      ),
    );
  }
}
