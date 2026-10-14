import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gpt_markdown/gpt_markdown.dart';

import 'package:stride/features_v2/auth/declaration_screen.dart';

void main() {
  testWidgets('fetches the public declaration endpoint and renders it',
      (tester) async {
    late RequestOptions captured;
    final dio = Dio();
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          captured = options;
          handler.resolve(
            Response<Map<String, dynamic>>(
              requestOptions: options,
              statusCode: 200,
              data: const {
                'doc_type': 'privacy_policy',
                'version': 3,
                'title': '隐私政策',
                'effective_at': null,
                'updated_at': '2026-10-01T00:00:00Z',
                'content_markdown': '# 隐私政策\n\n我们重视你的个人信息。',
              },
            ),
          );
        },
      ),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: DeclarationScreen(docType: 'privacy_policy', dio: dio),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    // 契约：公开端点、无需鉴权。
    expect(captured.path, '/api/declarations/privacy_policy');
    // 标题进了 app bar，正文进了 markdown 渲染器。
    expect(find.text('隐私政策'), findsWidgets);
    expect(find.byType(GptMarkdown), findsOneWidget);
  });

  testWidgets('shows a retryable error when the fetch fails', (tester) async {
    final dio = Dio();
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) => handler.resolve(
          Response<Map<String, dynamic>>(
            requestOptions: options,
            statusCode: 404,
            data: null,
          ),
        ),
      ),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: DeclarationScreen(docType: 'user_agreement', dio: dio),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.text('内容加载失败，请稍后重试'), findsOneWidget);
    expect(find.text('重试'), findsOneWidget);
  });
}
