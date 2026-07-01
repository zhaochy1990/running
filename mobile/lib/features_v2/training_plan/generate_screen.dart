/// C4 — Master plan generation screen (fullscreen, no shell).
///
/// Kicks off generation through POST /api/users/me/coach/chat, persists job_id,
/// polls every 2s, and auto-navigates to C5 on completion.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/router/routes_v2.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../auth/start_screen.dart' show StrideAuthPrimaryButton;
import 'models/master_plan_job_status.dart';
import 'providers/master_plan_generation_provider.dart';

class MasterPlanGenerateScreen extends ConsumerWidget {
  const MasterPlanGenerateScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(masterPlanGenerationProvider);
    final jobStatus = state.jobStatus;

    // Navigate to C5 when done.
    ref.listen<MasterPlanGenerationState>(masterPlanGenerationProvider,
        (prev, next) {
      final prevDone = prev?.jobStatus?.isDone ?? false;
      final nowDone = next.jobStatus?.isDone ?? false;
      if (nowDone && !prevDone) {
        final planId = next.jobStatus?.resultPlanId ?? '';
        if (planId.isNotEmpty) {
          context.go(RoutesV2.trainingPlanReview(planId));
        }
      }
    });

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: StrideTokens.space2xl,
          ),
          child: Column(
            children: [
              const Spacer(flex: 1),
              if (state.error != null && jobStatus == null)
                _ErrorBlock(
                  message: state.error!,
                  onRetry: () =>
                      ref.read(masterPlanGenerationProvider.notifier).retry(),
                )
              else if (jobStatus != null && jobStatus.isFailed)
                _FailedBlock(
                  status: jobStatus,
                  onRetry: () =>
                      ref.read(masterPlanGenerationProvider.notifier).retry(),
                )
              else
                _ProgressBlock(
                  status: jobStatus,
                  loading: state.loading,
                ),
              const Spacer(flex: 1),
              const _LeaveHint(),
              const SizedBox(height: StrideTokens.space2xl),
            ],
          ),
        ),
      ),
    );
  }
}

// ── Progress block ────────────────────────────────────────────────────────────

class _ProgressBlock extends StatelessWidget {
  const _ProgressBlock({this.status, required this.loading});

  final MasterPlanJobStatus? status;
  final bool loading;

  String _formatElapsed(int seconds) {
    if (seconds < 60) return '已用 ${seconds}s';
    final m = seconds ~/ 60;
    final s = seconds % 60;
    return '已用 ${m}m${s}s';
  }

  @override
  Widget build(BuildContext context) {
    final progress = status?.progress ?? 0;
    final stageLabel = status?.stageLabel ?? '正在分析训练历史…';
    final elapsed = status?.elapsedSeconds ?? 0;

    return Column(
      children: [
        // Large ring progress indicator
        SizedBox(
          width: 120,
          height: 120,
          child: Stack(
            alignment: Alignment.center,
            children: [
              SizedBox(
                width: 120,
                height: 120,
                child: CircularProgressIndicator(
                  value: (loading || progress == 0) ? null : progress / 100.0,
                  strokeWidth: 6,
                  color: StrideTokens.accent,
                  backgroundColor: StrideTokens.border2,
                ),
              ),
              if (progress > 0)
                Text(
                  '$progress%',
                  style: const TextStyle(
                    fontFamily: AppTypography.fontMono,
                    fontSize: StrideTokens.fs20,
                    color: StrideTokens.fg,
                    fontWeight: FontWeight.w700,
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: StrideTokens.space2xl),
        const Text(
          '正在生成训练总纲',
          style: TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs18,
            color: StrideTokens.fg,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: StrideTokens.spaceSm),
        Text(
          stageLabel,
          textAlign: TextAlign.center,
          style: const TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs14,
            color: StrideTokens.muted,
            height: 1.5,
          ),
        ),
        if (elapsed > 0) ...[
          const SizedBox(height: StrideTokens.spaceSm),
          Text(
            _formatElapsed(elapsed),
            style: const TextStyle(
              fontFamily: AppTypography.fontMono,
              fontSize: StrideTokens.fs12,
              color: StrideTokens.muted2,
            ),
          ),
        ],
      ],
    );
  }
}

// ── Leave hint ────────────────────────────────────────────────────────────────

class _LeaveHint extends StatelessWidget {
  const _LeaveHint();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(StrideTokens.spaceMd),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: const Row(
        children: [
          Icon(
            Icons.info_outline,
            size: 16,
            color: StrideTokens.muted,
          ),
          SizedBox(width: StrideTokens.spaceSm),
          Expanded(
            child: Text(
              '你可以离开 App，完成后会推送通知',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs13,
                color: StrideTokens.muted,
                height: 1.4,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ── Error block ───────────────────────────────────────────────────────────────

class _ErrorBlock extends StatelessWidget {
  const _ErrorBlock({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

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
            height: 1.5,
          ),
        ),
        const SizedBox(height: StrideTokens.space2xl),
        StrideAuthPrimaryButton(label: '重试', onPressed: onRetry),
      ],
    );
  }
}

// ── Failed block (job failed, with raw output) ────────────────────────────────

class _FailedBlock extends StatefulWidget {
  const _FailedBlock({required this.status, required this.onRetry});

  final MasterPlanJobStatus status;
  final VoidCallback onRetry;

  @override
  State<_FailedBlock> createState() => _FailedBlockState();
}

class _FailedBlockState extends State<_FailedBlock> {
  bool _showRaw = false;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        const Icon(Icons.error_outline, size: 56, color: StrideTokens.danger),
        const SizedBox(height: StrideTokens.space2xl),
        Text(
          widget.status.error ?? '生成失败，请重试',
          textAlign: TextAlign.center,
          style: const TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs15,
            color: StrideTokens.fg,
            height: 1.5,
          ),
        ),
        const SizedBox(height: StrideTokens.space2xl),
        StrideAuthPrimaryButton(label: '重试', onPressed: widget.onRetry),
        if (widget.status.rawOutput != null &&
            widget.status.rawOutput!.isNotEmpty) ...[
          const SizedBox(height: StrideTokens.spaceMd),
          GestureDetector(
            onTap: () => setState(() => _showRaw = !_showRaw),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text(
                  _showRaw ? '收起调试信息' : '展开调试信息',
                  style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs12,
                    color: StrideTokens.muted,
                  ),
                ),
                Icon(
                  _showRaw ? Icons.expand_less : Icons.expand_more,
                  size: 16,
                  color: StrideTokens.muted,
                ),
              ],
            ),
          ),
          if (_showRaw) ...[
            const SizedBox(height: StrideTokens.spaceSm),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(StrideTokens.spaceMd),
              decoration: BoxDecoration(
                color: StrideTokens.surface,
                borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
                border: Border.all(color: StrideTokens.border2),
              ),
              child: SingleChildScrollView(
                child: Text(
                  widget.status.rawOutput!,
                  style: const TextStyle(
                    fontFamily: AppTypography.fontMono,
                    fontSize: StrideTokens.fs11,
                    color: StrideTokens.fgSoft,
                    height: 1.4,
                  ),
                ),
              ),
            ),
          ],
        ],
      ],
    );
  }
}
