/// 合规声明查看页 —— 用户协议 / 隐私政策的当前生效版本。
///
/// 数据来自 stride-api 公开端点 `GET /api/declarations/:doc_type`
/// （未登录可读，镜像小程序 pages/declaration 的契约）。
library;

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:gpt_markdown/gpt_markdown.dart';

import '../../core/env/env.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/top_bar.dart';

class DeclarationScreen extends StatefulWidget {
  const DeclarationScreen({super.key, required this.docType, Dio? dio})
      : _dioOverride = dio;

  /// user_agreement / privacy_policy（由调用方从路由传入）。
  final String docType;

  /// 测试注入用；生产走默认实例。
  final Dio? _dioOverride;

  @override
  State<DeclarationScreen> createState() => _DeclarationScreenState();
}

class _DeclarationScreenState extends State<DeclarationScreen> {
  String? _title;
  String? _markdown;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final dio = widget._dioOverride ??
          Dio(BaseOptions(
            baseUrl: Env.apiBaseUrl,
            connectTimeout: const Duration(seconds: 10),
            receiveTimeout: const Duration(seconds: 15),
            headers: {
              'Accept': 'application/json',
              'X-Client-Id': Env.clientId,
            },
            validateStatus: (s) => s != null && s < 500,
          ));
      final res =
          await dio.get<Map<String, dynamic>>('/api/declarations/${widget.docType}');
      if (res.statusCode != 200 || res.data == null) {
        throw StateError('status ${res.statusCode}');
      }
      final data = res.data!;
      if (!mounted) return;
      setState(() {
        _title = data['title'] as String?;
        _markdown = data['content_markdown'] as String? ?? '';
      });
    } on DioException {
      if (mounted) setState(() => _error = '网络异常，请检查连接后重试');
    } catch (_) {
      if (mounted) setState(() => _error = '内容加载失败，请稍后重试');
    }
  }

  @override
  Widget build(BuildContext context) {
    final title = _title ?? _defaultTitle;
    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        title: title,
        leading: InkWell(
          onTap: () => Navigator.of(context).maybePop(),
          child: const Icon(Icons.arrow_back_ios_new, size: 18),
        ),
      ),
      body: SafeArea(
        child: _error != null
            ? _centered(
                Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      _error!,
                      style: const TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs14,
                        color: StrideTokens.muted,
                      ),
                    ),
                    const SizedBox(height: StrideTokens.spaceMd),
                    TextButton(onPressed: _load, child: const Text('重试')),
                  ],
                ),
              )
            : _markdown == null
                ? const _Loading()
                : SingleChildScrollView(
                    padding: const EdgeInsets.all(StrideTokens.spaceLg),
                    child: GptMarkdown(
                      _markdown!,
                      style: const TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs14,
                        color: StrideTokens.fg,
                        height: 1.7,
                      ),
                    ),
                  ),
      ),
    );
  }

  String get _defaultTitle =>
      widget.docType == 'privacy_policy' ? '隐私政策' : '用户协议';

  Widget _centered(Widget child) => Center(child: child);
}

class _Loading extends StatelessWidget {
  const _Loading();

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: Padding(
        padding: EdgeInsets.all(StrideTokens.space2xl),
        child: CircularProgressIndicator(color: StrideTokens.accent),
      ),
    );
  }
}
