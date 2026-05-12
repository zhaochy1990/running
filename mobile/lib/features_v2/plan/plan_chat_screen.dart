/// D4 — Plan Chat Screen.
///
/// 路由：/v2/plan/weeks/:folder/chat（fullscreen，no shell）
///
/// 功能：
///   1. StrideTopBar "调整本周计划"
///   2. 消息流（ListView reverse：用户右靠 accent，AI 左靠 muted）
///   3. DiffCard：op 类型 pill + 日期 + old→new + Checkbox 切换 accepted
///   4. 快捷气泡（水平横滚 4 个预设）
///   5. 底部输入栏（多行 + 发送按钮 + loading）
///   6. 当 acceptedOpIds 非空 → 浮动 "应用 N 项" 按钮
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/top_bar.dart';
import 'models/plan_chat.dart';
import 'providers/plan_chat_provider.dart';

// ── Quick suggestions ─────────────────────────────────────────────────────────

const _kSuggestions = [
  '将周三改为休息日',
  '把长跑移到周末',
  '减少本周跑量 20%',
  '增加一次力量训练',
];

// ── Screen ────────────────────────────────────────────────────────────────────

class PlanChatScreen extends ConsumerStatefulWidget {
  const PlanChatScreen({super.key, required this.folder});

  final String folder;

  @override
  ConsumerState<PlanChatScreen> createState() => _PlanChatScreenState();
}

class _PlanChatScreenState extends ConsumerState<PlanChatScreen> {
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
    ref.read(planChatProvider(widget.folder).notifier).sendMessage(
          widget.folder,
          text,
        );
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
        .read(planChatProvider(widget.folder).notifier)
        .applyDiff(widget.folder);
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('已应用调整')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(planChatProvider(widget.folder));

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        title: '调整本周计划',
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => Navigator.of(context).pop(),
        ),
      ),
      body: Column(
        children: [
          // Message list
          Expanded(
            child: _MessageList(
              state: state,
              folder: widget.folder,
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
                '应用 ${state.acceptedOpIds.length} 项',
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
    required this.folder,
    required this.scrollController,
  });

  final PlanChatState state;
  final String folder;
  final ScrollController scrollController;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final messages = state.messages;
    final diff = state.pendingDiff;

    // Build items list (reverse order for ListView.builder with reverse:true)
    // Items: messages first, then diff card appended after the last assistant message
    final items = <_ListItem>[];

    // Diff card is shown right after the last assistant message that created it
    if (diff != null) {
      items.add(_DiffItem(diff: diff, folder: folder));
    }

    for (int i = messages.length - 1; i >= 0; i--) {
      items.add(_MessageItem(message: messages[i]));
    }

    if (messages.isEmpty && !state.loading) {
      return Center(
        child: Text(
          '向 AI 教练发送消息\n开始调整计划',
          textAlign: TextAlign.center,
          style: const TextStyle(
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
          return _DiffCardWidget(diff: item.diff, folder: item.folder);
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
  _DiffItem({required this.diff, required this.folder});
  final PlanDiffView diff;
  final String folder;
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
          border: _isUser
              ? null
              : Border.all(color: StrideTokens.border2),
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

// ── Diff card ─────────────────────────────────────────────────────────────────

class _DiffCardWidget extends ConsumerWidget {
  const _DiffCardWidget({required this.diff, required this.folder});

  final PlanDiffView diff;
  final String folder;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(planChatProvider(folder));
    final notifier = ref.read(planChatProvider(folder).notifier);

    if (diff.ops.isEmpty) return const SizedBox.shrink();

    return Container(
      margin: const EdgeInsets.only(bottom: StrideTokens.spaceMd),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header
          Padding(
            padding: const EdgeInsets.fromLTRB(
              StrideTokens.spaceMd,
              StrideTokens.spaceMd,
              StrideTokens.spaceMd,
              StrideTokens.spaceSm,
            ),
            child: Text(
              '建议调整 ${diff.ops.length} 项',
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs13,
                fontWeight: FontWeight.w600,
                color: StrideTokens.muted,
                letterSpacing: 0.3,
              ),
            ),
          ),
          const Divider(height: 1, color: StrideTokens.border2),
          // Ops
          for (final op in diff.ops) ...[
            _OpRow(
              op: op,
              accepted: state.acceptedOpIds.contains(op.id),
              onToggle: () => notifier.toggleOp(op.id),
            ),
            if (op != diff.ops.last)
              const Divider(
                height: 1,
                indent: StrideTokens.spaceMd,
                endIndent: StrideTokens.spaceMd,
                color: StrideTokens.border2,
              ),
          ],
        ],
      ),
    );
  }
}

class _OpRow extends StatelessWidget {
  const _OpRow({
    required this.op,
    required this.accepted,
    required this.onToggle,
  });

  final DiffOpView op;
  final bool accepted;
  final VoidCallback onToggle;

  static String _opLabel(String op) {
    return switch (op) {
      'move_session' => '移动',
      'replace_kind' => '调整类型',
      'replace_distance' => '调整距离',
      'add_session' => '新增',
      'remove_session' => '删除',
      'replace_note' => '修改备注',
      _ => op,
    };
  }

  static Color _opColor(String op) {
    return switch (op) {
      'add_session' => StrideTokens.accent,
      'remove_session' => StrideTokens.danger,
      'move_session' => const Color(0xFF6366F1), // indigo
      _ => StrideTokens.muted,
    };
  }

  @override
  Widget build(BuildContext context) {
    final oldSummary = op.oldValue?['summary'] as String?;
    final newSummary = op.newValue?['summary'] as String?;

    return InkWell(
      onTap: onToggle,
      borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: StrideTokens.spaceMd,
          vertical: StrideTokens.spaceMd,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Checkbox
            SizedBox(
              width: 24,
              height: 24,
              child: Checkbox(
                value: accepted,
                onChanged: (_) => onToggle(),
                activeColor: StrideTokens.accent,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(4),
                ),
                materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
            ),
            const SizedBox(width: StrideTokens.spaceSm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Op type pill + date
                  Row(
                    children: [
                      _OpPill(label: _opLabel(op.op), color: _opColor(op.op)),
                      const SizedBox(width: StrideTokens.spaceSm),
                      Text(
                        _shortDate(op.date),
                        style: const TextStyle(
                          fontFamily: AppTypography.fontSans,
                          fontSize: StrideTokens.fs12,
                          color: StrideTokens.muted,
                        ),
                      ),
                    ],
                  ),
                  // old → new
                  if (oldSummary != null || newSummary != null) ...[
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        if (oldSummary != null)
                          Text(
                            oldSummary,
                            style: const TextStyle(
                              fontFamily: AppTypography.fontSans,
                              fontSize: StrideTokens.fs13,
                              color: StrideTokens.muted,
                              decoration: TextDecoration.lineThrough,
                            ),
                          ),
                        if (oldSummary != null && newSummary != null)
                          const Padding(
                            padding: EdgeInsets.symmetric(horizontal: 4),
                            child: Icon(
                              Icons.arrow_forward,
                              size: 14,
                              color: StrideTokens.muted,
                            ),
                          ),
                        if (newSummary != null)
                          Text(
                            newSummary,
                            style: const TextStyle(
                              fontFamily: AppTypography.fontSans,
                              fontSize: StrideTokens.fs13,
                              color: StrideTokens.fg,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  static String _shortDate(String iso) {
    final dt = DateTime.tryParse(iso);
    if (dt == null) return iso;
    return '${dt.month}/${dt.day}';
  }
}

class _OpPill extends StatelessWidget {
  const _OpPill({required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withOpacity(0.12),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: StrideTokens.fs11,
          fontWeight: FontWeight.w600,
          color: color,
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
        StrideTokens.spaceSm +
            MediaQuery.of(context).viewInsets.bottom,
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
                hintText: '发送消息给 AI 教练…',
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
