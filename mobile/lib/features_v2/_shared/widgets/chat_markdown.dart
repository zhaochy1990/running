/// Renders an assistant chat message as Markdown using a STRIDE-tuned
/// stylesheet. Coach replies (S2 plan-adjust, S3 daily Q&A) come back as
/// Markdown — bold, bullet/numbered lists, headings, inline code, tables —
/// so rendering them as plain text leaves the raw `**`, `-`, `###` visible.
///
/// User messages stay plain `Text` (white-on-accent); only assistant bubbles
/// use this. Shared by [CoachChatScreen] and [PlanChatScreen].
library;

import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/tokens.dart';

class ChatMarkdown extends StatelessWidget {
  const ChatMarkdown({super.key, required this.data});

  /// Raw Markdown source from the assistant.
  final String data;

  @override
  Widget build(BuildContext context) {
    return MarkdownBody(
      data: data,
      selectable: true,
      // shrinkWrap so the bubble sizes to content inside the constrained Align.
      shrinkWrap: true,
      fitContent: true,
      styleSheet: _styleSheet,
    );
  }

  static const _baseText = TextStyle(
    fontFamily: AppTypography.fontSans,
    fontSize: StrideTokens.fs14,
    color: StrideTokens.fg,
    height: 1.5,
  );

  static const _codeText = TextStyle(
    fontFamily: AppTypography.fontMono,
    fontSize: StrideTokens.fs13,
    color: StrideTokens.fg,
    height: 1.4,
    backgroundColor: StrideTokens.bg,
  );

  static final _styleSheet = MarkdownStyleSheet(
    p: _baseText,
    a: _baseText.copyWith(
      color: StrideTokens.accent,
      decoration: TextDecoration.underline,
    ),
    strong: _baseText.copyWith(fontWeight: FontWeight.w700),
    em: _baseText.copyWith(fontStyle: FontStyle.italic),
    h1: _baseText.copyWith(fontSize: StrideTokens.fs18, fontWeight: FontWeight.w700),
    h2: _baseText.copyWith(fontSize: StrideTokens.fs15, fontWeight: FontWeight.w700),
    h3: _baseText.copyWith(fontSize: StrideTokens.fs14, fontWeight: FontWeight.w700),
    h4: _baseText.copyWith(fontSize: StrideTokens.fs14, fontWeight: FontWeight.w600),
    h5: _baseText.copyWith(fontSize: StrideTokens.fs14, fontWeight: FontWeight.w600),
    h6: _baseText.copyWith(fontSize: StrideTokens.fs14, fontWeight: FontWeight.w600),
    listBullet: _baseText,
    code: _codeText,
    codeblockDecoration: BoxDecoration(
      color: StrideTokens.bg,
      borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
      border: Border.all(color: StrideTokens.border2),
    ),
    codeblockPadding: const EdgeInsets.all(StrideTokens.spaceSm),
    blockquote: _baseText.copyWith(color: StrideTokens.muted),
    blockquoteDecoration: const BoxDecoration(
      border: Border(
        left: BorderSide(color: StrideTokens.border, width: 3),
      ),
    ),
    blockquotePadding: const EdgeInsets.only(left: StrideTokens.spaceMd),
    horizontalRuleDecoration: const BoxDecoration(
      border: Border(top: BorderSide(color: StrideTokens.border2)),
    ),
    tableHead: _baseText.copyWith(fontWeight: FontWeight.w700),
    tableBody: _baseText.copyWith(fontSize: StrideTokens.fs13),
    tableBorder: TableBorder.all(color: StrideTokens.border2),
    tableCellsPadding: const EdgeInsets.symmetric(
      horizontal: StrideTokens.spaceSm,
      vertical: StrideTokens.spaceXs,
    ),
    // Tighten the default gap between block elements inside a chat bubble.
    pPadding: EdgeInsets.zero,
    h1Padding: const EdgeInsets.only(top: StrideTokens.spaceXs),
    h2Padding: const EdgeInsets.only(top: StrideTokens.spaceXs),
    h3Padding: const EdgeInsets.only(top: StrideTokens.spaceXs),
    listIndent: StrideTokens.spaceLg,
  );
}
