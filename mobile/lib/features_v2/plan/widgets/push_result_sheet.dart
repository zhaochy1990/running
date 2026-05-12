/// PushResultSheet — D2b 推送结果 bottom sheet.
///
/// Shows a summary of the week push: success count / failure count / total,
/// expandable success list, expanded failure list with per-item retry buttons.
///
/// Triggered from D2 WeekDetailScreen after "推送到手表" confirm dialog.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/theme/tokens.dart';
import '../providers/push_week_provider.dart';

// ── Public entry-point ────────────────────────────────────────────────────────

/// Show [PushResultSheet] as a modal bottom sheet.
Future<void> showPushResultSheet(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (_) => const PushResultSheet(),
  );
}

// ── Sheet ─────────────────────────────────────────────────────────────────────

class PushResultSheet extends ConsumerStatefulWidget {
  const PushResultSheet({super.key});

  @override
  ConsumerState<PushResultSheet> createState() => _PushResultSheetState();
}

class _PushResultSheetState extends ConsumerState<PushResultSheet> {
  bool _successExpanded = false;

  @override
  Widget build(BuildContext context) {
    final pushState = ref.watch(pushWeekProvider);
    final userId = ref.watch(currentUserIdProvider);

    return Container(
      decoration: const BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(StrideTokens.radiusLg),
        ),
      ),
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom +
            StrideTokens.space2xl,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // ── Drag handle ──
          const _DragHandle(),
          // ── Title bar ──
          const _SheetTitle(title: '推送结果'),
          const Divider(height: 1, color: StrideTokens.border2),
          // ── Body ──
          switch (pushState) {
            PushWeekLoading() => const _LoadingBody(),
            PushWeekDone(:final result) => _ResultBody(
                result: result,
                userId: userId ?? '',
                successExpanded: _successExpanded,
                onToggleSuccess: () =>
                    setState(() => _successExpanded = !_successExpanded),
              ),
            PushWeekError(:final message) => _ErrorBody(message: message),
            PushWeekIdle() => const _LoadingBody(),
          },
          // ── Done button ──
          if (pushState is PushWeekDone || pushState is PushWeekError)
            _DoneButton(onPressed: () => Navigator.of(context).pop()),
        ],
      ),
    );
  }
}

// ── Loading body ──────────────────────────────────────────────────────────────

class _LoadingBody extends StatelessWidget {
  const _LoadingBody();

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.symmetric(vertical: StrideTokens.space3xl),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          CircularProgressIndicator(color: StrideTokens.accent),
          SizedBox(height: StrideTokens.spaceLg),
          Text(
            '推送中...',
            style: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs14,
              color: StrideTokens.muted,
            ),
          ),
        ],
      ),
    );
  }
}

// ── Error body ────────────────────────────────────────────────────────────────

class _ErrorBody extends StatelessWidget {
  const _ErrorBody({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      child: Text(
        message,
        style: const TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: StrideTokens.fs14,
          color: StrideTokens.danger,
        ),
      ),
    );
  }
}

// ── Result body ───────────────────────────────────────────────────────────────

class _ResultBody extends ConsumerWidget {
  const _ResultBody({
    required this.result,
    required this.userId,
    required this.successExpanded,
    required this.onToggleSuccess,
  });

  final PushWeekResult result;
  final String userId;
  final bool successExpanded;
  final VoidCallback onToggleSuccess;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Padding(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // ── Summary row ──
          _SummaryRow(result: result),
          const SizedBox(height: StrideTokens.spaceLg),

          // ── Failure list (always expanded) ──
          if (result.failures.isNotEmpty) ...[
            _SectionHeader(
              label: '失败 ${result.failureCount} 项',
              color: StrideTokens.danger,
            ),
            const SizedBox(height: StrideTokens.spaceSm),
            ...result.failures.map((f) => _FailureItem(
                  item: f,
                  userId: userId,
                )),
            const SizedBox(height: StrideTokens.spaceLg),
          ],

          // ── Success list (collapsible) ──
          if (result.successes.isNotEmpty) ...[
            InkWell(
              onTap: onToggleSuccess,
              borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
              child: Row(
                children: [
                  _SectionHeader(
                    label: '成功 ${result.successCount} 项',
                    color: StrideTokens.accent,
                  ),
                  const Spacer(),
                  Icon(
                    successExpanded
                        ? Icons.keyboard_arrow_up
                        : Icons.keyboard_arrow_down,
                    size: 18,
                    color: StrideTokens.muted,
                  ),
                ],
              ),
            ),
            if (successExpanded) ...[
              const SizedBox(height: StrideTokens.spaceSm),
              ...result.successes.map((s) => _SuccessItem(item: s)),
            ],
          ],
        ],
      ),
    );
  }
}

// ── Summary row ───────────────────────────────────────────────────────────────

class _SummaryRow extends StatelessWidget {
  const _SummaryRow({required this.result});

  final PushWeekResult result;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: BoxDecoration(
        color: StrideTokens.bg,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceAround,
        children: [
          _CountChip(
            icon: Icons.check_circle_outline,
            count: result.successCount,
            label: '成功',
            color: StrideTokens.accent,
          ),
          _CountChip(
            icon: Icons.error_outline,
            count: result.failureCount,
            label: '失败',
            color: StrideTokens.danger,
          ),
          _CountChip(
            icon: Icons.list_alt_outlined,
            count: result.total,
            label: '共',
            color: StrideTokens.fgSoft,
          ),
        ],
      ),
    );
  }
}

class _CountChip extends StatelessWidget {
  const _CountChip({
    required this.icon,
    required this.count,
    required this.label,
    required this.color,
  });

  final IconData icon;
  final int count;
  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Icon(icon, size: 20, color: color),
        const SizedBox(height: 4),
        Text(
          '$count',
          style: TextStyle(
            fontFamily: AppTypography.fontMono,
            fontSize: StrideTokens.fs18,
            fontWeight: FontWeight.w700,
            color: color,
          ),
        ),
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

// ── Section header ────────────────────────────────────────────────────────────

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Text(
      label,
      style: TextStyle(
        fontFamily: AppTypography.fontSans,
        fontSize: StrideTokens.fs13,
        fontWeight: FontWeight.w600,
        color: color,
      ),
    );
  }
}

// ── Success item ──────────────────────────────────────────────────────────────

class _SuccessItem extends StatelessWidget {
  const _SuccessItem({required this.item});

  final SessionPushResult item;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: StrideTokens.spaceXs),
      child: Row(
        children: [
          const Icon(
            Icons.check_circle,
            size: 16,
            color: StrideTokens.accent,
          ),
          const SizedBox(width: StrideTokens.spaceSm),
          Text(
            _shortDate(item.date),
            style: const TextStyle(
              fontFamily: AppTypography.fontMono,
              fontSize: StrideTokens.fs13,
              color: StrideTokens.muted,
            ),
          ),
          const SizedBox(width: StrideTokens.spaceSm),
          Expanded(
            child: Text(
              item.sessionName,
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs14,
                color: StrideTokens.fg,
              ),
            ),
          ),
        ],
      ),
    );
  }

  static String _shortDate(String iso) {
    final dt = DateTime.tryParse(iso);
    if (dt == null) return iso;
    return '${dt.month}/${dt.day}';
  }
}

// ── Failure item ──────────────────────────────────────────────────────────────

class _FailureItem extends ConsumerWidget {
  const _FailureItem({required this.item, required this.userId});

  final SessionPushResult item;
  final String userId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Container(
      margin: const EdgeInsets.only(bottom: StrideTokens.spaceSm),
      padding: const EdgeInsets.all(StrideTokens.spaceMd),
      decoration: BoxDecoration(
        color: StrideTokens.bg,
        borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
        border: Border.all(color: const Color(0xFFE6B5AC)),
      ),
      child: Row(
        children: [
          const Icon(Icons.error, size: 16, color: StrideTokens.danger),
          const SizedBox(width: StrideTokens.spaceSm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text(
                      _shortDate(item.date),
                      style: const TextStyle(
                        fontFamily: AppTypography.fontMono,
                        fontSize: StrideTokens.fs12,
                        color: StrideTokens.muted,
                      ),
                    ),
                    const SizedBox(width: StrideTokens.spaceSm),
                    Text(
                      item.sessionName,
                      style: const TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs14,
                        color: StrideTokens.fg,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ],
                ),
                if (item.errorMessage != null) ...[
                  const SizedBox(height: 2),
                  Text(
                    item.errorMessage!,
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs12,
                      color: StrideTokens.danger,
                    ),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(width: StrideTokens.spaceSm),
          // Retry button
          TextButton(
            onPressed: () => ref.read(pushWeekProvider.notifier).retrySession(
                  userId: userId,
                  failed: item,
                ),
            style: TextButton.styleFrom(
              foregroundColor: StrideTokens.accent,
              minimumSize: const Size(48, 32),
              padding: const EdgeInsets.symmetric(
                horizontal: StrideTokens.spaceSm,
              ),
              textStyle: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs13,
                fontWeight: FontWeight.w600,
              ),
            ),
            child: const Text('重试'),
          ),
        ],
      ),
    );
  }

  static String _shortDate(String iso) {
    final dt = DateTime.tryParse(iso);
    if (dt == null) return iso;
    return '${dt.month}/${dt.day}';
  }
}

// ── Shared widgets ────────────────────────────────────────────────────────────

class _DragHandle extends StatelessWidget {
  const _DragHandle();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: StrideTokens.spaceMd),
      child: Center(
        child: Container(
          width: 36,
          height: 4,
          decoration: BoxDecoration(
            color: StrideTokens.border,
            borderRadius: BorderRadius.circular(2),
          ),
        ),
      ),
    );
  }
}

class _SheetTitle extends StatelessWidget {
  const _SheetTitle({required this.title});

  final String title;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        StrideTokens.spaceLg,
        0,
        StrideTokens.spaceLg,
        StrideTokens.spaceMd,
      ),
      child: Text(
        title,
        style: const TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: StrideTokens.fs18,
          fontWeight: FontWeight.w700,
          color: StrideTokens.fg,
        ),
      ),
    );
  }
}

class _DoneButton extends StatelessWidget {
  const _DoneButton({required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        StrideTokens.spaceLg,
        StrideTokens.spaceMd,
        StrideTokens.spaceLg,
        0,
      ),
      child: FilledButton(
        onPressed: onPressed,
        style: FilledButton.styleFrom(
          backgroundColor: StrideTokens.accent,
          foregroundColor: StrideTokens.surface,
          minimumSize: const Size.fromHeight(48),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
          ),
          textStyle: const TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs15,
            fontWeight: FontWeight.w600,
          ),
        ),
        child: const Text('完成'),
      ),
    );
  }
}
