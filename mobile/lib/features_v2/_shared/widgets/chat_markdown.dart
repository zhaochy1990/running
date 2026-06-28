/// Renders an assistant chat message as Markdown using a STRIDE-tuned theme.
///
/// Coach replies (S2 plan-adjust, S3 daily Q&A) come back as Markdown — bold,
/// bullet/numbered lists, headings, inline code, tables — so rendering them as
/// plain text leaves the raw `**`, `-`, `###` visible.
///
/// Uses [GptMarkdown], which is purpose-built for ChatGPT/Gemini-style replies
/// and actively maintained (the original `flutter_markdown` was discontinued).
/// User messages stay plain `Text` (white-on-accent); only assistant bubbles
/// use this. Shared by [CoachChatScreen] and [PlanChatScreen].
library;

import 'package:flutter/material.dart';
import 'package:gpt_markdown/gpt_markdown.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/tokens.dart';

class ChatMarkdown extends StatelessWidget {
  const ChatMarkdown({super.key, required this.data});

  /// Raw Markdown source from the assistant.
  final String data;

  @override
  Widget build(BuildContext context) {
    // SelectionArea enables long-press select/copy (GptMarkdown has no
    // `selectable` flag of its own).
    return SelectionArea(
      child: GptMarkdownTheme(
        gptThemeData: _theme,
        child: GptMarkdown(
          data,
          style: _baseText,
          onLinkTap: _openLink,
        ),
      ),
    );
  }

  static Future<void> _openLink(String url, String title) async {
    final uri = Uri.tryParse(url);
    if (uri == null) return;
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    }
  }

  static const _baseText = TextStyle(
    fontFamily: AppTypography.fontSans,
    fontSize: StrideTokens.fs14,
    color: StrideTokens.fg,
    height: 1.5,
  );

  static final _theme = GptMarkdownThemeData(
    brightness: Brightness.light,
    // Subtle grey behind inline `code` spans.
    highlightColor: StrideTokens.border2,
    h1: _baseText.copyWith(fontSize: StrideTokens.fs18, fontWeight: FontWeight.w700),
    h2: _baseText.copyWith(fontSize: StrideTokens.fs15, fontWeight: FontWeight.w700),
    h3: _baseText.copyWith(fontSize: StrideTokens.fs14, fontWeight: FontWeight.w700),
    h4: _baseText.copyWith(fontSize: StrideTokens.fs14, fontWeight: FontWeight.w600),
    h5: _baseText.copyWith(fontSize: StrideTokens.fs14, fontWeight: FontWeight.w600),
    h6: _baseText.copyWith(fontSize: StrideTokens.fs14, fontWeight: FontWeight.w600),
    linkColor: StrideTokens.accent,
    linkHoverColor: StrideTokens.accent,
    hrLineColor: StrideTokens.border2,
    hrLineThickness: 1,
    // No auto divider after `#` headings inside a compact chat bubble.
    autoAddDividerLineAfterH1: false,
  );
}
