/// 教练 (Coach) tab — SSE streaming chat mirroring the miniprogram coach page
/// (see stride-devops#421 resolution / #464).
///
/// Streaming typewriter + stage hints (status/narration → progress area,
/// never the body), multi-session drawer with server history restore,
/// race-strategy notification card → strategy draft handoff, idempotent
/// retry (same client_turn_id + byte-identical body), long-press copy,
/// keyboard-adaptive input bar, and the week-context entry from /training.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/chat_markdown.dart';
import '../_shared/widgets/top_bar.dart';
import 'providers/coach_chat_provider.dart';

const _kSuggestions = ['我今天状态怎么样？', '这周训练量合适吗？', '明天该怎么跑？', '最近 HRV 偏低要紧吗？'];

class CoachChatScreen extends ConsumerStatefulWidget {
  const CoachChatScreen({super.key});

  @override
  ConsumerState<CoachChatScreen> createState() => _CoachChatScreenState();
}

class _CoachChatScreenState extends ConsumerState<CoachChatScreen> {
  final _input = TextEditingController();
  final _scaffoldKey = GlobalKey<ScaffoldState>();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final notifier = ref.read(coachChatProvider.notifier);
      // 「和教练聊一聊」跨页交接：锚定 target 的新会话（一次性消费）。
      final pending = ref.read(pendingCoachContextProvider);
      if (pending != null) {
        ref.read(pendingCoachContextProvider.notifier).state = null;
        notifier.consumePendingContext(pending);
      }
      notifier.loadSessions();
      notifier.loadSession(ref.read(coachChatProvider).currentSessionId);
    });
  }

  @override
  void dispose() {
    _input.dispose();
    super.dispose();
  }

  void _send([String? preset]) {
    final text = (preset ?? _input.text).trim();
    if (text.isEmpty) return;
    _input.clear();
    ref.read(coachChatProvider.notifier).sendMessage(text);
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(coachChatProvider);

    ref.listen(coachChatProvider, (prev, next) {
      if (next.loadError != null && next.loadError != prev?.loadError) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(next.loadError!), duration: const Duration(seconds: 3)),
        );
      }
    });

    return Scaffold(
      key: _scaffoldKey,
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        title: '教练',
        leading: IconButton(
          icon: const Icon(Icons.menu),
          tooltip: '会话列表',
          onPressed: () => _scaffoldKey.currentState?.openEndDrawer(),
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.add_comment_outlined),
            tooltip: '新建对话',
            onPressed: () {
              _scaffoldKey.currentState?.closeDrawer();
              ref.read(coachChatProvider.notifier).newConversation();
            },
          ),
        ],
      ),
      endDrawer: const _SessionsDrawer(),
      body: Column(
        children: [
          if (state.sessionOf(state.currentSessionId)?.contextLabel != null)
            _ContextBanner(
              label: state.sessionOf(state.currentSessionId)!.contextLabel!,
              onClear: () => ref.read(coachChatProvider.notifier).clearContext(),
            ),
          Expanded(
            child: state.messages.isEmpty && !state.streaming
                ? _EmptyState(onTapSuggestion: _send)
                : _MessageList(
                    state: state,
                    notifier: ref.read(coachChatProvider.notifier),
                  ),
          ),
          _InputBar(
            controller: _input,
            loading: state.streaming,
            onSend: _send,
          ),
        ],
      ),
    );
  }
}

// ── Message list ──────────────────────────────────────────────────────────────

class _MessageList extends StatelessWidget {
  const _MessageList({required this.state, required this.notifier});

  final CoachChatState state;
  final CoachChatNotifier notifier;

  @override
  Widget build(BuildContext context) {
    final children = <Widget>[];
    for (final msg in state.messages) {
      if (msg.role == 'user') {
        children.add(_UserBubble(message: msg));
        if (msg.failed) {
          children.add(_RetryRow(onRetry: () => notifier.retry(msg.id)));
        }
      } else if (msg.card != null) {
        children.add(
          _StrategyCard(
            message: msg,
            onOpen: () {
              final ok = notifier.openStrategyCard(msg.id);
              ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                content: Text(
                  ok ? '策略草稿已就绪（报告页将随后续版本开放）' : '锚定赛事后生成的策略才可交接报告页',
                ),
                duration: const Duration(seconds: 2),
              ));
            },
          ),
        );
      } else {
        children.add(_AssistantBubble(message: msg));
      }
    }
    if (state.streaming) children.add(_StreamingBubble(state: state));
    // reverse:true keeps the newest child pinned to the bottom while the
    // typewriter grows.
    return ListView(
      reverse: true,
      padding: const EdgeInsets.symmetric(
        horizontal: StrideTokens.spaceLg,
        vertical: StrideTokens.spaceMd,
      ),
      children: children.reversed.toList(),
    );
  }
}

// ── Bubbles ───────────────────────────────────────────────────────────────────

class _UserBubble extends StatelessWidget {
  const _UserBubble({required this.message});

  final CoachMessage message;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerRight,
      child: Container(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.78,
        ),
        margin: const EdgeInsets.only(bottom: StrideTokens.spaceMd),
        padding: const EdgeInsets.symmetric(
          horizontal: StrideTokens.spaceMd,
          vertical: StrideTokens.spaceSm,
        ),
        decoration: const BoxDecoration(
          color: StrideTokens.accent,
          borderRadius: BorderRadius.only(
            topLeft: Radius.circular(StrideTokens.radiusMd),
            topRight: Radius.circular(StrideTokens.radiusMd),
            bottomLeft: Radius.circular(StrideTokens.radiusMd),
            bottomRight: Radius.circular(2),
          ),
        ),
        child: Text(
          message.content,
          style: const TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs14,
            color: StrideTokens.surface,
            height: 1.5,
          ),
        ),
      ),
    );
  }
}

class _AssistantBubble extends StatelessWidget {
  const _AssistantBubble({required this.message});

  final CoachMessage message;

  void _copy(BuildContext context) {
    Clipboard.setData(ClipboardData(text: message.content));
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('已复制全文'), duration: Duration(seconds: 1)),
    );
  }

  @override
  Widget build(BuildContext context) {
    // mp-html 的 rich-text 选区不跨实例，小程序靠长按补「复制全文」；这里
    // SelectionArea 已支持跨段选择，长按手势兜底一键复制。
    return Align(
      alignment: Alignment.centerLeft,
      child: GestureDetector(
        onLongPress: () => _copy(context),
        child: Container(
          constraints: BoxConstraints(
            maxWidth: MediaQuery.of(context).size.width * 0.86,
          ),
          margin: const EdgeInsets.only(bottom: StrideTokens.spaceMd),
          padding: const EdgeInsets.symmetric(
            horizontal: StrideTokens.spaceMd,
            vertical: StrideTokens.spaceSm,
          ),
          decoration: BoxDecoration(
            color: StrideTokens.surface,
            borderRadius: const BorderRadius.only(
              topLeft: Radius.circular(StrideTokens.radiusMd),
              topRight: Radius.circular(StrideTokens.radiusMd),
              bottomLeft: Radius.circular(2),
              bottomRight: Radius.circular(StrideTokens.radiusMd),
            ),
            border: Border.all(color: StrideTokens.border2),
          ),
          child: ChatMarkdown(data: message.content),
        ),
      ),
    );
  }
}

/// Streaming bubble: stage hint + pre-tool narration + typewriter text.
/// narration 属进度区，绝不拼进正文；done 后整气泡被权威正文替换。
class _StreamingBubble extends StatelessWidget {
  const _StreamingBubble({required this.state});

  final CoachChatState state;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.86,
        ),
        margin: const EdgeInsets.only(bottom: StrideTokens.spaceMd),
        padding: const EdgeInsets.symmetric(
          horizontal: StrideTokens.spaceMd,
          vertical: StrideTokens.spaceSm,
        ),
        decoration: BoxDecoration(
          color: StrideTokens.surface,
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(StrideTokens.radiusMd),
            topRight: Radius.circular(StrideTokens.radiusMd),
            bottomLeft: Radius.circular(2),
            bottomRight: Radius.circular(StrideTokens.radiusMd),
          ),
          border: Border.all(color: StrideTokens.border2),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                const SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(strokeWidth: 2, color: StrideTokens.accent),
                ),
                const SizedBox(width: StrideTokens.spaceSm),
                Text(
                  state.streamPhase.isEmpty ? '正在思考…' : state.streamPhase,
                  style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs13,
                    color: StrideTokens.muted,
                  ),
                ),
              ],
            ),
            if (state.streamNarration.isNotEmpty) ...[
              const SizedBox(height: StrideTokens.spaceSm),
              Text(
                state.streamNarration,
                style: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs13,
                  color: StrideTokens.muted,
                  height: 1.5,
                ),
              ),
            ],
            if (state.streamText.isNotEmpty) ...[
              const SizedBox(height: StrideTokens.spaceSm),
              Text(
                state.streamText,
                style: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs14,
                  color: StrideTokens.fg,
                  height: 1.5,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _RetryRow extends StatelessWidget {
  const _RetryRow({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerRight,
      child: Padding(
        padding: const EdgeInsets.only(bottom: StrideTokens.spaceMd),
        child: ActionChip(
          avatar: const Icon(Icons.refresh, size: 16, color: StrideTokens.accent),
          label: const Text(
            '发送失败，点击重试',
            style: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs13,
              color: StrideTokens.accent,
            ),
          ),
          onPressed: onRetry,
        ),
      ),
    );
  }
}

// ── Race-strategy notification card ──────────────────────────────────────────

class _StrategyCard extends StatelessWidget {
  const _StrategyCard({required this.message, required this.onOpen});

  final CoachMessage message;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final card = message.card!;
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.86,
        ),
        margin: const EdgeInsets.only(bottom: StrideTokens.spaceMd),
        child: Material(
          color: StrideTokens.surface,
          borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
          child: InkWell(
            borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
            onTap: onOpen,
            child: Container(
              padding: const EdgeInsets.all(StrideTokens.spaceMd),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
                border: Border.all(color: StrideTokens.border2),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(
                    children: [
                      const Icon(Icons.flag_outlined, size: 18, color: StrideTokens.accent),
                      const SizedBox(width: StrideTokens.spaceSm),
                      Expanded(
                        child: Text(
                          card.title,
                          style: const TextStyle(
                            fontFamily: AppTypography.fontSans,
                            fontSize: StrideTokens.fs14,
                            fontWeight: FontWeight.w600,
                            color: StrideTokens.fg,
                          ),
                        ),
                      ),
                      if (card.badge.isNotEmpty) _Badge(text: card.badge),
                    ],
                  ),
                  const SizedBox(height: StrideTokens.spaceSm),
                  Text(
                    card.subtitle,
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs13,
                      color: StrideTokens.muted,
                      height: 1.5,
                    ),
                  ),
                  if (card.buttonText.isNotEmpty) ...[
                    const SizedBox(height: StrideTokens.spaceSm),
                    Text(
                      card.buttonText,
                      style: const TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs13,
                        fontWeight: FontWeight.w600,
                        color: StrideTokens.accent,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: StrideTokens.accentFg,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        text,
        style: const TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: 11,
          color: StrideTokens.accent,
        ),
      ),
    );
  }
}

// ── Sessions drawer / context banner ─────────────────────────────────────────

class _SessionsDrawer extends ConsumerWidget {
  const _SessionsDrawer();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(coachChatProvider);
    return Drawer(
      width: 300,
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.all(StrideTokens.spaceMd),
              child: Row(
                children: [
                  const Expanded(
                    child: Text(
                      '对话列表',
                      style: TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs15,
                        fontWeight: FontWeight.w700,
                        color: StrideTokens.fg,
                      ),
                    ),
                  ),
                  TextButton.icon(
                    onPressed: () {
                      Navigator.of(context).pop();
                      ref.read(coachChatProvider.notifier).newConversation();
                    },
                    icon: const Icon(Icons.add, size: 18),
                    label: const Text(
                      '新建对话',
                      style: TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs13,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const Divider(height: 1, color: StrideTokens.border2),
            Expanded(
              child: state.sessions.isEmpty
                  ? const Center(
                      child: Text(
                        '暂无历史会话',
                        style: TextStyle(
                          fontFamily: AppTypography.fontSans,
                          fontSize: StrideTokens.fs13,
                          color: StrideTokens.muted,
                        ),
                      ),
                    )
                  : ListView(
                      children: [
                        for (final session in state.sessions)
                          ListTile(
                            selected: session.id == state.currentSessionId,
                            selectedTileColor: StrideTokens.accentFg,
                            leading: Icon(
                              Icons.chat_bubble_outline,
                              size: 18,
                              color: session.id == state.currentSessionId
                                  ? StrideTokens.accent
                                  : StrideTokens.muted2,
                            ),
                            title: Text(
                              session.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontFamily: AppTypography.fontSans,
                                fontSize: StrideTokens.fs14,
                                color: session.id == state.currentSessionId
                                    ? StrideTokens.accent
                                    : StrideTokens.fg,
                              ),
                            ),
                            onTap: () {
                              Navigator.of(context).pop();
                              ref.read(coachChatProvider.notifier).selectSession(session.id);
                            },
                          ),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ContextBanner extends StatelessWidget {
  const _ContextBanner({required this.label, required this.onClear});

  final String label;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: StrideTokens.spaceLg,
        vertical: StrideTokens.spaceSm,
      ),
      decoration: const BoxDecoration(
        color: StrideTokens.accentFg,
        border: Border(bottom: BorderSide(color: StrideTokens.border2)),
      ),
      child: Row(
        children: [
          const Icon(Icons.anchor_outlined, size: 16, color: StrideTokens.accent),
          const SizedBox(width: StrideTokens.spaceSm),
          Expanded(
            child: Text(
              '正在围绕「$label」对话',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs13,
                color: StrideTokens.accent,
              ),
            ),
          ),
          IconButton(
            visualDensity: VisualDensity.compact,
            icon: const Icon(Icons.close, size: 16, color: StrideTokens.muted),
            tooltip: '清除上下文',
            onPressed: onClear,
          ),
        ],
      ),
    );
  }
}

// ── Empty state / input bar ──────────────────────────────────────────────────

class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.onTapSuggestion});
  final void Function(String) onTapSuggestion;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      children: [
        const SizedBox(height: StrideTokens.space3xl),
        Center(
          child: Container(
            width: 56,
            height: 56,
            alignment: Alignment.center,
            decoration: const BoxDecoration(
              color: StrideTokens.accentFg,
              shape: BoxShape.circle,
            ),
            child: const Icon(
              Icons.sports,
              size: 28,
              color: StrideTokens.accent,
            ),
          ),
        ),
        const SizedBox(height: StrideTokens.spaceMd),
        const Center(
          child: Text(
            '问问你的 STRIDE 教练',
            style: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs18,
              fontWeight: FontWeight.w700,
              color: StrideTokens.fg,
            ),
          ),
        ),
        const SizedBox(height: 6),
        const Center(
          child: Text(
            '基于你的训练数据，随时解答',
            style: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs13,
              color: StrideTokens.muted,
            ),
          ),
        ),
        const SizedBox(height: StrideTokens.space2xl),
        ..._kSuggestions.map(
          (s) => Padding(
            padding: const EdgeInsets.only(bottom: StrideTokens.spaceSm),
            child: GestureDetector(
              onTap: () => onTapSuggestion(s),
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(
                  horizontal: StrideTokens.spaceMd,
                  vertical: StrideTokens.spaceMd,
                ),
                decoration: BoxDecoration(
                  color: StrideTokens.surface,
                  borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
                  border: Border.all(color: StrideTokens.border2),
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        s,
                        style: const TextStyle(
                          fontFamily: AppTypography.fontSans,
                          fontSize: StrideTokens.fs14,
                          color: StrideTokens.fg,
                        ),
                      ),
                    ),
                    const Icon(
                      Icons.north_east,
                      size: 16,
                      color: StrideTokens.muted2,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _InputBar extends StatelessWidget {
  const _InputBar({
    required this.controller,
    required this.loading,
    required this.onSend,
  });

  final TextEditingController controller;
  final bool loading;
  final void Function([String?]) onSend;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(
        StrideTokens.spaceMd,
        StrideTokens.spaceSm,
        StrideTokens.spaceSm,
        StrideTokens.spaceSm,
      ),
      decoration: const BoxDecoration(
        color: StrideTokens.surface,
        border: Border(top: BorderSide(color: StrideTokens.border2)),
      ),
      // 键盘高度自适应：Scaffold resizeToAvoidBottomInset 顶起 body，这里不做
      // 手动 viewInsets 叠加（会双重 padding）。
      child: SafeArea(
        top: false,
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
                  hintText: '问问你的教练…',
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
                      onPressed: () => onSend(null),
                      icon: const Icon(Icons.send_rounded),
                      color: StrideTokens.accent,
                      tooltip: '发送',
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
