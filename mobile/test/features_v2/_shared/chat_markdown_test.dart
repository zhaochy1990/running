/// Widget tests for [ChatMarkdown] — assistant chat bubbles render Markdown
/// rather than showing raw `**`, `-`, `###` syntax.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/features_v2/_shared/widgets/chat_markdown.dart';

Future<void> _pump(WidgetTester tester, String data) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: ChatMarkdown(data: data),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('bold markdown drops the literal asterisks', (tester) async {
    await _pump(tester, '你今天状态**很好**，继续保持');

    // The rendered transcript contains the words without the `**` markers.
    expect(find.textContaining('很好', findRichText: true), findsOneWidget);
    expect(find.textContaining('**', findRichText: true), findsNothing);
  });

  testWidgets('bullet list renders items without leading dashes',
      (tester) async {
    await _pump(tester, '建议：\n- 早睡\n- 多补水');

    expect(find.textContaining('早睡', findRichText: true), findsOneWidget);
    expect(find.textContaining('多补水', findRichText: true), findsOneWidget);
    // The raw "- " list markers should not survive as literal text.
    expect(find.textContaining('- 早睡', findRichText: true), findsNothing);
  });

  testWidgets('heading markdown drops the hashes', (tester) async {
    await _pump(tester, '### 今日总结\n训练完成');

    expect(find.textContaining('今日总结', findRichText: true), findsOneWidget);
    expect(find.textContaining('###', findRichText: true), findsNothing);
  });
}
