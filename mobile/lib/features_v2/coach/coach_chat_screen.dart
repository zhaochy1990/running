/// 教练 (Coach) tab — real-time S3 daily Q&A chat with the Coach Agent.
///
/// Mirrors `spec/stitch/mobile/tab-coach.html`: a ChatGPT-style transcript,
/// quick-question chips when empty, and a bottom input bar.
///
/// Data: `POST /api/users/me/coach/conversations/qa/messages` via
/// [coachChatProvider]. The server derives the thread from user + today.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../_shared/shell/main_shell.dart';
import '../_shared/widgets/chat_markdown.dart';
import '../_shared/widgets/top_bar.dart';
import 'providers/coach_chat_provider.dart';

const _kSuggestions = [
  '我今天状态怎么样？',
  '这周训练量合适吗？',
  '明天该怎么跑？',
  '最近 HRV 偏低要紧吗？',
];

class CoachChatScreen extends ConsumerStatefulWidget {
  const CoachChatScreen({super.key});

  @override
  ConsumerState<CoachChatScreen> createState() => _CoachChatScreenState();
}

class _CoachChatScreenState extends ConsumerState<CoachChatScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _send([String? preset]) {
    final text = (preset ?? _input.text).trim();
    if (text.isEmpty) return;
    _input.clear();
    ref.read(coachChatProvider.notifier).sendMessage(text);
    _scrollToBottom();
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(
          0,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
        );
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(coachChatProvider);

    ref.listen(coachChatProvider, (prev, next) {
      if (next.error != null && next.error != prev?.error) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('教练暂时不可用：${next.error}')),
        );
      }
    });

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        title: '教练',
        leading: IconButton(
          icon: const Icon(Icons.menu),
          onPressed: () => shellScaffoldKey.currentState?.openDrawer(),
        ),
      ),
      body: Column(
        children: [
          Expanded(
            child: state.messages.isEmpty && !state.loading
                ? _EmptyState(onTapSuggestion: _send)
                : _MessageList(state: state, scroll: _scroll),
          ),
          _InputBar(controller: _input, loading: state.loading, onSend: _send),
        ],
      ),
    );
  }
}

class _MessageList extends StatelessWidget {
  const _MessageList({required this.state, required this.scroll});
  final CoachChatState state;
  final ScrollController scroll;

  @override
  Widget build(BuildContext context) {
    final msgs = state.messages;
    return ListView.builder(
      controller: scroll,
      reverse: true,
      padding: const EdgeInsets.symmetric(
        horizontal: StrideTokens.spaceLg,
        vertical: StrideTokens.spaceMd,
      ),
      itemCount: msgs.length + (state.loading ? 1 : 0),
      itemBuilder: (context, index) {
        if (state.loading && index == 0) return const _TypingIndicator();
        final adjusted = state.loading ? index - 1 : index;
        final msg = msgs[msgs.length - 1 - adjusted];
        return _Bubble(message: msg);
      },
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({required this.message});
  final CoachMessage message;

  @override
  Widget build(BuildContext context) {
    final isUser = message.isUser;
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.78,
        ),
        margin: const EdgeInsets.only(bottom: StrideTokens.spaceMd),
        padding: const EdgeInsets.symmetric(
          horizontal: StrideTokens.spaceMd,
          vertical: StrideTokens.spaceSm,
        ),
        decoration: BoxDecoration(
          color: isUser ? StrideTokens.accent : StrideTokens.surface,
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(StrideTokens.radiusMd),
            topRight: const Radius.circular(StrideTokens.radiusMd),
            bottomLeft: Radius.circular(isUser ? StrideTokens.radiusMd : 2),
            bottomRight: Radius.circular(isUser ? 2 : StrideTokens.radiusMd),
          ),
          border: isUser ? null : Border.all(color: StrideTokens.border2),
        ),
        child: isUser
            ? Text(
                message.text,
                style: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs14,
                  color: StrideTokens.surface,
                  height: 1.5,
                ),
              )
            : ChatMarkdown(data: message.text),
      ),
    );
  }
}

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
          width: 20,
          height: 20,
          child: CircularProgressIndicator(
              strokeWidth: 2, color: StrideTokens.accent),
        ),
      ),
    );
  }
}

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
            child: const Icon(Icons.sports, size: 28, color: StrideTokens.accent),
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
                    const Icon(Icons.north_east,
                        size: 16, color: StrideTokens.muted2),
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
