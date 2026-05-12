/// D1 — 单周生成中屏 (GenerateWeekScreen).
///
/// 路由：/v2/plan/generate?week_start=YYYY-MM-DD（fullscreen，no shell）
///
/// Flow:
///   1. 进屏后立即触发 POST /api/{user}/plan/weeks/generate
///   2. 全屏 loading：旋转 indicator + 假阶段文案（3 阶段，每阶段 ~500ms）
///   3. 成功 → push /v2/plan/weeks/:folder（D2 周预览）
///   4. 409 conflict → confirm dialog，确认后 force=true 重试
///   5. 其他错误 → 显示错误信息 + 重试按钮
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/router/routes_v2.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/top_bar.dart';
import 'providers/generate_week_provider.dart';

class GenerateWeekScreen extends ConsumerStatefulWidget {
  const GenerateWeekScreen({super.key, required this.weekStart});

  /// Monday of the week to generate, e.g. "2026-05-11".
  final String weekStart;

  @override
  ConsumerState<GenerateWeekScreen> createState() => _GenerateWeekScreenState();
}

class _GenerateWeekScreenState extends ConsumerState<GenerateWeekScreen> {
  // ── Phase animation ────────────────────────────────────────────────────────
  static const _phases = [
    '读取上周完成情况...',
    '决定周量...',
    '排课...',
  ];
  int _phaseIndex = 0;
  Timer? _phaseTimer;

  // Track whether a conflict dialog is currently showing to avoid duplicates.
  bool _dialogShowing = false;

  @override
  void initState() {
    super.initState();
    _startPhaseAnimation();
    // After the first frame: check if the provider already has a terminal
    // state (e.g. injected by a test), then react to it; otherwise trigger
    // generation normally.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final current = ref.read(generateWeekProvider);
      switch (current) {
        case GenerateWeekSuccess(:final folder):
          _stopPhaseAnimation();
          context.pushReplacement(RoutesV2.weekDetail(folder));
        case GenerateWeekConflict():
          _stopPhaseAnimation();
          if (!_dialogShowing) _showConflictDialog();
        case GenerateWeekError():
          _stopPhaseAnimation();
        case GenerateWeekIdle():
          _triggerGenerate();
        case GenerateWeekGenerating():
          break;
      }
    });
  }

  @override
  void dispose() {
    _phaseTimer?.cancel();
    super.dispose();
  }

  void _startPhaseAnimation() {
    _phaseTimer?.cancel();
    setState(() => _phaseIndex = 0);
    _phaseTimer = Timer.periodic(const Duration(milliseconds: 500), (t) {
      if (!mounted) {
        t.cancel();
        return;
      }
      setState(() {
        _phaseIndex = (_phaseIndex + 1) % _phases.length;
      });
    });
  }

  void _stopPhaseAnimation() {
    _phaseTimer?.cancel();
    _phaseTimer = null;
  }

  void _triggerGenerate({bool force = false}) {
    _startPhaseAnimation();
    ref
        .read(generateWeekProvider.notifier)
        .generate(widget.weekStart, force: force);
  }

  // ── State listener ─────────────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    // Listen for state changes to navigate or show dialogs.
    ref.listen<GenerateWeekState>(generateWeekProvider, (_, next) {
      switch (next) {
        case GenerateWeekSuccess(:final folder):
          _stopPhaseAnimation();
          // Replace this screen with the week detail screen.
          if (mounted) {
            context.pushReplacement(RoutesV2.weekDetail(folder));
          }
        case GenerateWeekConflict():
          _stopPhaseAnimation();
          if (mounted && !_dialogShowing) {
            _showConflictDialog();
          }
        case GenerateWeekError():
          _stopPhaseAnimation();
        case GenerateWeekGenerating():
          break;
        case GenerateWeekIdle():
          break;
      }
    });

    final state = ref.watch(generateWeekProvider);

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      // No leading / back button — generation is in progress; user must wait.
      appBar: StrideTopBar(title: '生成计划'),
      body: _buildBody(state),
    );
  }

  Widget _buildBody(GenerateWeekState state) {
    return switch (state) {
      GenerateWeekError(:final message) => _ErrorBody(
          message: message,
          onRetry: () => _triggerGenerate(),
        ),
      // Idle should only flash for one frame before generate fires.
      _ => _LoadingBody(phaseText: _phases[_phaseIndex]),
    };
  }

  // ── Conflict dialog ────────────────────────────────────────────────────────
  void _showConflictDialog() {
    _dialogShowing = true;
    showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        backgroundColor: StrideTokens.surface,
        title: const Text(
          '计划已存在',
          style: TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs15,
            fontWeight: FontWeight.w600,
            color: StrideTokens.fg,
          ),
        ),
        content: const Text(
          '下周计划已存在，覆盖生成？',
          style: TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs13,
            color: StrideTokens.fgSoft,
          ),
        ),
        actions: [
          TextButton(
            onPressed: () {
              _dialogShowing = false;
              Navigator.of(ctx).pop(false);
              // User cancelled — pop back to caller.
              if (mounted) context.pop();
            },
            child: const Text(
              '取消',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                color: StrideTokens.muted,
              ),
            ),
          ),
          TextButton(
            onPressed: () {
              _dialogShowing = false;
              Navigator.of(ctx).pop(true);
              // Force-regenerate.
              _triggerGenerate(force: true);
            },
            child: const Text(
              '覆盖生成',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                color: StrideTokens.accent,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ── Loading body ───────────────────────────────────────────────────────────────

class _LoadingBody extends StatelessWidget {
  const _LoadingBody({required this.phaseText});

  final String phaseText;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: StrideTokens.space2xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const CircularProgressIndicator(
              color: StrideTokens.accent,
              strokeWidth: 2.5,
            ),
            const SizedBox(height: StrideTokens.spaceLg),
            const Text(
              '正在生成下周计划...',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs15,
                fontWeight: FontWeight.w600,
                color: StrideTokens.fg,
              ),
            ),
            const SizedBox(height: StrideTokens.spaceSm),
            AnimatedSwitcher(
              duration: const Duration(milliseconds: 300),
              child: Text(
                phaseText,
                key: ValueKey(phaseText),
                style: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs13,
                  color: StrideTokens.muted,
                ),
                textAlign: TextAlign.center,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ── Error body ─────────────────────────────────────────────────────────────────

class _ErrorBody extends StatelessWidget {
  const _ErrorBody({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: StrideTokens.space2xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 48, color: StrideTokens.danger),
            const SizedBox(height: StrideTokens.spaceLg),
            const Text(
              '生成失败',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs15,
                fontWeight: FontWeight.w600,
                color: StrideTokens.fg,
              ),
            ),
            const SizedBox(height: StrideTokens.spaceSm),
            Text(
              message,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs12,
                color: StrideTokens.muted,
              ),
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
            ),
            const SizedBox(height: StrideTokens.spaceLg),
            FilledButton(
              onPressed: onRetry,
              style: FilledButton.styleFrom(
                backgroundColor: StrideTokens.accent,
                foregroundColor: StrideTokens.surface,
              ),
              child: const Text(
                '重试',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
