/// 隐私与权限 /me/privacy —— 镜像小程序 pages/privacy：声明入口列表。
///
/// 条目静态列出（与后端 LegalDocumentTypes 对齐，同小程序 PRIVACY_ROWS）；
/// 正文走公开端点 GET /api/declarations/:doc_type，由 /declaration/:docType
/// 渲染（免登录可读，stride-devops#414 路由表 17/18）。
library;

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/router/routes.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/top_bar.dart';

class PrivacyScreen extends StatelessWidget {
  const PrivacyScreen({super.key});

  static const _rows = [
    (
      key: Key('privacy-user-agreement'),
      docType: 'user_agreement',
      title: '用户协议',
      subtitle: '服务条款与用户权利义务',
      icon: Icons.verified_user_outlined,
    ),
    (
      key: Key('privacy-privacy-policy'),
      docType: 'privacy_policy',
      title: '隐私政策',
      subtitle: '个人信息的收集、使用与保护',
      icon: Icons.visibility_off_outlined,
    ),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        title: '隐私与权限',
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new, size: 18),
          onPressed: () => Navigator.of(context).maybePop(),
        ),
      ),
      body: ListView(
        padding: const EdgeInsets.all(StrideTokens.spaceLg),
        children: [
          for (final (i, row) in _rows.indexed) ...[
            if (i > 0) const SizedBox(height: StrideTokens.spaceMd),
            _EntryCard(
              row: row,
              onTap: () => context.push(Routes.declaration(row.docType)),
            ),
          ],
        ],
      ),
    );
  }
}

class _EntryCard extends StatelessWidget {
  const _EntryCard({required this.row, required this.onTap});

  final ({
    Key key,
    String docType,
    String title,
    String subtitle,
    IconData icon,
  }) row;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: StrideTokens.surface,
      borderRadius: BorderRadius.circular(StrideTokens.radiusLg),
      child: InkWell(
        key: row.key,
        onTap: onTap,
        borderRadius: BorderRadius.circular(StrideTokens.radiusLg),
        child: Container(
          padding: const EdgeInsets.all(StrideTokens.spaceLg),
          decoration: BoxDecoration(
            border: Border.all(color: StrideTokens.border),
            borderRadius: BorderRadius.circular(StrideTokens.radiusLg),
          ),
          child: Row(
            children: [
              Icon(row.icon, size: 22, color: StrideTokens.fgSoft),
              const SizedBox(width: StrideTokens.spaceMd),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      row.title,
                      style: const TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs15,
                        fontWeight: FontWeight.w600,
                        color: StrideTokens.fg,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      row.subtitle,
                      style: const TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs12,
                        color: StrideTokens.muted,
                      ),
                    ),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right, size: 20, color: StrideTokens.muted2),
            ],
          ),
        ),
      ),
    );
  }
}
