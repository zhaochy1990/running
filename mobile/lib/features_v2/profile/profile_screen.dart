/// 我 tab（/me）—— 镜像小程序 pages/profile。
///
/// 用户卡 + 手动同步 + 功能菜单（训练状态/赛事中心/我的比赛/手表管理/
/// 数据与状态）+ 设置（检查更新/关于）+ 退出登录。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../../core/auth/auth_controller.dart';
import '../../core/auth/current_user.dart';
import '../../core/router/routes.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../../core/updater/update_checker.dart';
import '../../features/updater/update_prompt.dart';
import '../_shared/sync/sync_controller.dart';
import '../_shared/widgets/top_bar.dart';
import 'widgets/menu_item.dart';

class MeScreen extends ConsumerWidget {
  const MeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profileAsync = ref.watch(currentUserProvider);
    final sync = ref.watch(syncControllerProvider);
    final profile = profileAsync.valueOrNull;

    final displayName = profile?.displayName ??
        profile?.profile?['display_name'] as String? ??
        _emailPrefix((profile?.profile?['email'] as String?) ?? '');
    final email = (profile?.profile?['email'] as String?) ?? '';
    final watchBound = profile?.onboarding.corosReady ?? false;

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: const StrideTopBar(title: '我'),
      body: ListView(
        children: [
          _UserHeader(displayName: displayName, email: email),
          const SizedBox(height: StrideTokens.spaceSm),

          // ── 手动同步 ──
          _SyncRow(sync: sync),
          const _Divider(),
          const SizedBox(height: StrideTokens.spaceSm),

          // ── 功能 ──
          ProfileMenuItem(
            icon: Icons.monitor_heart_outlined,
            label: '训练状态',
            onTap: () => _comingSoon(context, '训练状态'),
          ),
          ProfileMenuItem(
            icon: Icons.emoji_events_outlined,
            label: '赛事中心',
            onTap: () => _comingSoon(context, '赛事中心'),
          ),
          ProfileMenuItem(
            icon: Icons.flag_outlined,
            label: '我的比赛',
            onTap: () => _comingSoon(context, '我的比赛'),
          ),
          ProfileMenuItem(
            icon: Icons.watch_outlined,
            label: '手表管理',
            trailing: Text(
              watchBound ? '已绑定' : '未绑定',
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs12,
                color: StrideTokens.muted,
              ),
            ),
            onTap: () => context.push(Routes.meWatch),
          ),
          ProfileMenuItem(
            icon: Icons.insights_outlined,
            label: '数据与状态',
            onTap: () => context.push(Routes.meData),
          ),
          ProfileMenuItem(
            icon: Icons.person_outline,
            label: '个人信息编辑',
            onTap: () => _comingSoon(context, '个人信息编辑'),
          ),
          const _Divider(),
          const SizedBox(height: StrideTokens.spaceSm),

          // ── 设置 ──
          ProfileMenuItem(
            icon: Icons.system_update_outlined,
            label: '检查更新',
            onTap: () => _checkForUpdate(context, ref),
          ),
          ProfileMenuItem(
            icon: Icons.info_outline,
            label: '关于 STRIDE',
            onTap: () => _showAbout(context),
          ),
          const _Divider(),
          const SizedBox(height: StrideTokens.spaceSm),
          ProfileMenuItem(
            icon: Icons.logout,
            label: '退出登录',
            destructive: true,
            trailing: const SizedBox.shrink(),
            onTap: () => _confirmLogout(context, ref),
          ),
          const SizedBox(height: StrideTokens.space3xl),
        ],
      ),
    );
  }

  static String _emailPrefix(String email) {
    final at = email.indexOf('@');
    return at > 0 ? email.substring(0, at) : email;
  }

  static void _comingSoon(BuildContext context, String feature) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text('$feature — 即将上线'),
        duration: const Duration(seconds: 2),
      ),
    );
  }

  static Future<void> _checkForUpdate(
      BuildContext context, WidgetRef ref) async {
    final messenger = ScaffoldMessenger.of(context);
    messenger.showSnackBar(
      const SnackBar(
        content: Text('正在检查更新…'),
        duration: Duration(seconds: 2),
      ),
    );
    try {
      final info = await ref.read(updateCheckerProvider).check(force: true);
      if (info != null) {
        if (!context.mounted) return;
        await showUpdatePrompt(context, ref, info);
      } else {
        messenger.hideCurrentSnackBar();
        messenger.showSnackBar(
          const SnackBar(content: Text('已是最新版本')),
        );
      }
    } catch (e) {
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(
        SnackBar(content: Text('检查更新失败：$e')),
      );
    }
  }

  static Future<void> _showAbout(BuildContext context) async {
    PackageInfo info;
    try {
      info = await PackageInfo.fromPlatform();
    } catch (_) {
      if (!context.mounted) return;
      showAboutDialog(
        context: context,
        applicationName: 'STRIDE',
        applicationVersion: 'dev',
      );
      return;
    }
    if (!context.mounted) return;
    showAboutDialog(
      context: context,
      applicationName: 'STRIDE',
      applicationVersion: '${info.version}+${info.buildNumber}',
      applicationLegalese: '© 2026 STRIDE Running',
      children: const [
        SizedBox(height: 8),
        Text(
          '跑步训练数据分析与计划管理工具。',
          style: TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: 13,
          ),
        ),
      ],
    );
  }

  static Future<void> _confirmLogout(BuildContext context, WidgetRef ref) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('退出登录'),
        content: const Text('确认退出当前账号？'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            style: TextButton.styleFrom(
              foregroundColor: StrideTokens.danger,
            ),
            child: const Text('退出'),
          ),
        ],
      ),
    );
    if (confirmed == true && context.mounted) {
      await ref.read(authControllerProvider.notifier).logout();
      if (context.mounted) {
        context.go(Routes.authStart);
      }
    }
  }
}

// ── User header ───────────────────────────────────────────────────────────────

class _UserHeader extends StatelessWidget {
  const _UserHeader({required this.displayName, required this.email});

  final String displayName;
  final String email;

  @override
  Widget build(BuildContext context) {
    final initial = displayName.isNotEmpty ? displayName[0].toUpperCase() : 'U';

    return Container(
      color: StrideTokens.surface,
      padding: const EdgeInsets.symmetric(
        horizontal: StrideTokens.spaceLg,
        vertical: StrideTokens.spaceXl,
      ),
      child: Row(
        children: [
          CircleAvatar(
            radius: 28,
            backgroundColor: StrideTokens.accent,
            child: Text(
              initial,
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs20,
                fontWeight: FontWeight.w700,
                color: StrideTokens.surface,
              ),
            ),
          ),
          const SizedBox(width: StrideTokens.spaceLg),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  displayName,
                  style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs18,
                    fontWeight: FontWeight.w600,
                    color: StrideTokens.fg,
                  ),
                ),
                if (email.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(
                    email,
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs12,
                      color: StrideTokens.muted,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ── Manual sync row ───────────────────────────────────────────────────────────

class _SyncRow extends ConsumerWidget {
  const _SyncRow({required this.sync});

  final SyncState sync;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final lastSynced = sync.lastSyncedAt;
    final subtitle = sync.syncing
        ? '正在同步…'
        : lastSynced != null
            ? '上次同步 ${lastSynced.month}月${lastSynced.day}日 ${lastSynced.hour.toString().padLeft(2, '0')}:${lastSynced.minute.toString().padLeft(2, '0')}'
            : '从手表拉取最新训练数据';

    return Container(
      color: StrideTokens.surface,
      child: ListTile(
        leading: sync.syncing
            ? const SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: StrideTokens.accent,
                ),
              )
            : const Icon(Icons.sync_outlined, size: 20, color: StrideTokens.fg),
        title: const Text(
          '手动同步',
          style: TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs14,
            color: StrideTokens.fg,
          ),
        ),
        subtitle: Text(
          subtitle,
          style: const TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs12,
            color: StrideTokens.muted,
          ),
        ),
        trailing: const Icon(Icons.chevron_right, size: 18, color: StrideTokens.muted),
        onTap: sync.syncing
            ? null
            : () async {
                final messenger = ScaffoldMessenger.of(context);
                try {
                  await ref.read(syncControllerProvider.notifier).triggerSync();
                  messenger.showSnackBar(
                    const SnackBar(
                      content: Text('同步完成'),
                      backgroundColor: StrideTokens.accent,
                    ),
                  );
                } catch (e) {
                  messenger.showSnackBar(
                    SnackBar(
                      content: Text('同步失败：$e'),
                      backgroundColor: StrideTokens.danger,
                    ),
                  );
                }
              },
      ),
    );
  }
}

class _Divider extends StatelessWidget {
  const _Divider();

  @override
  Widget build(BuildContext context) {
    return const Divider(
      height: 1,
      thickness: 1,
      color: StrideTokens.border2,
    );
  }
}
