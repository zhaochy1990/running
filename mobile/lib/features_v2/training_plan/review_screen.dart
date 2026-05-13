/// C5 — Master plan review chat screen (fullscreen, no shell).
///
/// Shows the plan summary card, a chat interface for reviewing/adjusting
/// the plan, and a "确认总纲" confirm button.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/router/routes_v2.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/top_bar.dart';
import '../plan/models/plan_chat.dart';
import 'providers/master_plan_review_provider.dart';
import 'widgets/master_plan_diff_card.dart';
import 'widgets/master_plan_summary_card.dart';

// ── Quick suggestions ─────────────────────────────────────────────────────────

const _kSuggestions = [
  '基础期再多 2 周',
  '赛前期降低强度',
  '8 月份要出差，那周减量',
  '增加一场测试赛',
];

// ── Screen ────────────────────────────────────────────────────────────────────

class MasterPlanReviewScreen extends ConsumerStatefulWidget {
  const MasterPlanReviewScreen({super.key, required this.planId});

  final String planId;

  @override
  ConsumerState<MasterPlanReviewScreen> createState() =>
      _MasterPlanReviewScreenState();
}

class _MasterPlanReviewScreenState
    extends ConsumerState<MasterPlanReviewScreen> {
  final _inputController = TextEditingController();
  final _scrollController = ScrollController();

  @override
  void dispose() {
    _inputController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  void _send() {
    final text = _inputController.text.trim();
    if (text.isEmpty) return;
    _inputController.clear();
    ref
        .read(masterPlanReviewProvider(widget.planId).notifier)
        .sendMessage(text);
    _scrollToBottom();
  }

  void _sendSuggestion(String suggestion) {
    _inputController.text = suggestion;
    _send();
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        _scrollController.animateTo(
          0,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
        );
      }
    });
  }

  Future<void> _applyDiff() async {
    await ref
        .read(masterPlanReviewProvider(widget.planId).notifier)
        .applyDiff();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('已应用调整')),
      );
    }
  }

  Future<void> _confirm() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text(
          '确认总纲',
          style: TextStyle(
            fontFamily: AppTypography.fontSans,
            fontWeight: FontWeight.w600,
          ),
        ),
        content: const Text(
          '确认后将作为后续单周生成的基础，无法回到 draft 状态。',
          style: TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs14,
            height: 1.5,
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text(
              '确认',
              style: TextStyle(color: StrideTokens.accent),
            ),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    await ref
        .read(masterPlanReviewProvider(widget.planId).notifier)
        .confirm();

    if (mounted) {
      final state = ref.read(masterPlanReviewProvider(widget.planId));
      if (state.confirmed) {
        context.go(RoutesV2.trainingPlanView);
      } else if (state.error != null) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(state.error!)),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(masterPlanReviewProvider(widget.planId));

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        title: '审阅训练总纲',
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => Navigator.of(context).pop(),
        ),
        actions: [
          TextButton(
            onPressed: state.loading ? null : _confirm,
            child: const Text(
              '确认总纲',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs13,
                fontWeight: FontWeight.w600,
                color: StrideTokens.accent,
              ),
            ),
          ),
        ],
      ),
      body: Column(
        children: [
          // Summary card
          if (state.summaryLoading)
            const LinearProgressIndicator(
              color: StrideTokens.accent,
              backgroundColor: StrideTokens.border2,
            )
          else if (state.summary != null)
            MasterPlanSummaryCard(summary: state.summary!),

          // Message list
          Expanded(
            child: _MessageList(
              state: state,
              planId: widget.planId,
              scrollController: _scrollController,
            ),
          ),

          // Quick suggestion chips
          _SuggestionBar(onTap: _sendSuggestion),

          // Input bar
          _InputBar(
            controller: _inputController,
            loading: state.loading,
            onSend: _send,
          ),
        ],
      ),
      floatingActionButton: state.hasPendingAccepted
          ? FloatingActionButton.extended(
              onPressed: _applyDiff,
              backgroundColor: StrideTokens.accent,
              foregroundColor: StrideTokens.surface,
              label: Text(
                '应用 ${state.acceptedOpIds.length} 项调整',
                style: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontWeight: FontWeight.w600,
                ),
              ),
              icon: const Icon(Icons.check),
            )
          : null,
    );
  }
}

// ── Message list ──────────────────────────────────────────────────────────────

class _MessageList extends ConsumerWidget {
  const _MessageList({
    required this.state,
    required this.planId,
    required this.scrollController,
  });

  final MasterPlanReviewState state;
  final String planId;
  final ScrollController scrollController;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final messages = state.messages;
    final diff = state.pendingDiff;

    final items = <_ListItem>[];

    if (diff != null) {
      items.add(_DiffItem(diff: diff, planId: planId));
    }

    for (int i = messages.length - 1; i >= 0; i--) {
      items.add(_MessageItem(message: messages[i]));
    }

    if (messages.isEmpty && !state.loading) {
      return const Center(
        child: Text(
          '向 AI 教练发送消息\n开始调整总纲计划',
          textAlign: TextAlign.center,
          style: TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs14,
            color: StrideTokens.muted,
            height: 1.6,
          ),
        ),
      );
    }

    return ListView.builder(
      controller: scrollController,
      reverse: true,
      padding: const EdgeInsets.symmetric(
        horizontal: StrideTokens.spaceLg,
        vertical: StrideTokens.spaceMd,
      ),
      itemCount: items.length + (state.loading ? 1 : 0),
      itemBuilder: (context, index) {
        if (state.loading && index == 0) {
          return const _TypingIndicator();
        }
        final adjusted = state.loading ? index - 1 : index;
        final item = items[adjusted];
        if (item is _MessageItem) {
          return _BubbleWidget(message: item.message);
        } else if (item is _DiffItem) {
          return MasterPlanDiffCard(diff: item.diff, planId: item.planId);
        }
        return const SizedBox.shrink();
      },
    );
  }
}

// ── List item types ───────────────────────────────────────────────────────────

abstract class _ListItem {}

class _MessageItem extends _ListItem {
  _MessageItem({required this.message});
  final ChatMessage message;
}

class _DiffItem extends _ListItem {
  _DiffItem({required this.diff, required this.planId});
  final MasterPlanDiff diff;
  final String planId;
}

// ── Bubble ────────────────────────────────────────────────────────────────────

class _BubbleWidget extends StatelessWidget {
  const _BubbleWidget({required this.message});

  final ChatMessage message;

  bool get _isUser => message.role == 'user';

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: _isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.75,
        ),
        margin: const EdgeInsets.only(bottom: StrideTokens.spaceMd),
        padding: const EdgeInsets.symmetric(
          horizontal: StrideTokens.spaceMd,
          vertical: StrideTokens.spaceSm,
        ),
        decoration: BoxDecoration(
          color: _isUser ? StrideTokens.accent : StrideTokens.surface,
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(StrideTokens.radiusMd),
            topRight: const Radius.circular(StrideTokens.radiusMd),
            bottomLeft: _isUser
                ? const Radius.circular(StrideTokens.radiusMd)
                : const Radius.circular(2),
            bottomRight: _isUser
                ? const Radius.circular(2)
                : const Radius.circular(StrideTokens.radiusMd),
          ),
          border: _isUser ? null : Border.all(color: StrideTokens.border2),
        ),
        child: Text(
          message.content,
          style: TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs14,
            color: _isUser ? StrideTokens.surface : StrideTokens.fg,
            height: 1.5,
          ),
        ),
      ),
    );
  }
}

// ── Typing indicator ──────────────────────────────────────────────────────────

class _TypingIndicator extends StatelessWidget {
  const _TypingIndicator();

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: StrideTokens.spaceMd),
        padding: const EdgeInsets.symmetric(
          horizontal: StrideTokens.spaceMd,
          vertical: StrideTokens.spaceSm,
        ),
        decoration: BoxDecoration(
          color: StrideTokens.surface,
          borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
          border: Border.all(color: StrideTokens.border2),
        ),
        child: const SizedBox(
          width: 40,
          height: 20,
          child: Center(
            child: SizedBox(
              width: 20,
              height: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          ),
        ),
      ),
    );
  }
}

// ── Suggestion bar ────────────────────────────────────────────────────────────

class _SuggestionBar extends StatelessWidget {
  const _SuggestionBar({required this.onTap});

  final void Function(String) onTap;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: StrideTokens.border2)),
      ),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(
          horizontal: StrideTokens.spaceMd,
          vertical: StrideTokens.spaceSm,
        ),
        child: Row(
          children: _kSuggestions
              .map(
                (s) => Padding(
                  padding: const EdgeInsets.only(right: StrideTokens.spaceSm),
                  child: ActionChip(
                    label: Text(
                      s,
                      style: const TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs12,
                        color: StrideTokens.fg,
                      ),
                    ),
                    backgroundColor: StrideTokens.surface,
                    side: const BorderSide(color: StrideTokens.border),
                    padding: const EdgeInsets.symmetric(horizontal: 4),
                    onPressed: () => onTap(s),
                  ),
                ),
              )
              .toList(),
        ),
      ),
    );
  }
}

// ── Input bar ─────────────────────────────────────────────────────────────────

class _InputBar extends StatelessWidget {
  const _InputBar({
    required this.controller,
    required this.loading,
    required this.onSend,
  });

  final TextEditingController controller;
  final bool loading;
  final VoidCallback onSend;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.fromLTRB(
        StrideTokens.spaceMd,
        StrideTokens.spaceSm,
        StrideTokens.spaceSm,
        StrideTokens.spaceSm + MediaQuery.of(context).viewInsets.bottom,
      ),
      decoration: const BoxDecoration(
        color: StrideTokens.surface,
        border: Border(top: BorderSide(color: StrideTokens.border2)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            child: TextField(
              controller: controller,
              maxLines: 4,
              minLines: 1,
              textInputAction: TextInputAction.newline,
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs14,
                color: StrideTokens.fg,
              ),
              decoration: InputDecoration(
                hintText: '向 AI 教练发送消息…',
                hintStyle: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs14,
                  color: StrideTokens.muted,
                ),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
                  borderSide: const BorderSide(color: StrideTokens.border2),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
                  borderSide: const BorderSide(color: StrideTokens.border2),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
                  borderSide: const BorderSide(color: StrideTokens.accent),
                ),
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: StrideTokens.spaceMd,
                  vertical: StrideTokens.spaceSm,
                ),
                filled: true,
                fillColor: StrideTokens.bg,
              ),
            ),
          ),
          const SizedBox(width: StrideTokens.spaceSm),
          SizedBox(
            width: 44,
            height: 44,
            child: loading
                ? const Center(
                    child: SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  )
                : IconButton(
                    onPressed: onSend,
                    icon: const Icon(Icons.send_rounded),
                    color: StrideTokens.accent,
                    tooltip: '发送',
                  ),
          ),
        ],
      ),
    );
  }
}
