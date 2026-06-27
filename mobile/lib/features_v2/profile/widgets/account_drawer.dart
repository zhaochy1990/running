/// AccountDrawer — the "我" side drawer opened from the top-left ≡.
///
/// Mirrors `spec/stitch/mobile/drawer-account.html`: identity header
/// (avatar + name + "COROS · 已绑定" + pill), a nav list (账号资料 / 手表绑定 /
/// 设置 / 意见反馈 / 常见问题 / 关于 STRIDE), a destructive 退出登录, and a
/// mono tagline pinned to the bottom.
library;

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../../../core/app_version.dart';
import '../../../core/auth/auth_controller.dart';
import '../../../core/auth/current_user.dart';
import '../../../core/router/routes_v2.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/theme/tokens.dart';
import '../../../core/updater/update_checker.dart';
import '../../../features/updater/update_prompt.dart';
import '../../../data/api/stride_api.dart';
import '../../_shared/sync/sync_controller.dart';
import '../../home/providers/home_provider.dart';
import 'menu_item.dart';

class AccountDrawer extends ConsumerWidget {
  const AccountDrawer({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profile = ref.watch(currentUserProvider).valueOrNull;
    final watch = ref.watch(homeProvider).valueOrNull?.watch;
    final syncing = ref.watch(syncControllerProvider).syncing;
    final appVersion = ref.watch(appVersionProvider).valueOrNull;

    final displayName = profile?.displayName ??
        (profile?.profile?['display_name'] as String?) ??
        _emailPrefix((profile?.profile?['email'] as String?) ?? '') ;
    final initial =
        displayName.isNotEmpty ? displayName[0].toUpperCase() : 'U';
    final watchLabel = watch?.brand != null
        ? '${watch!.brand!.toUpperCase()} · 已绑定'
        : '未绑定手表';

    return Drawer(
      backgroundColor: StrideTokens.surface,
      width: MediaQuery.of(context).size.width * 0.85,
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // ── Identity header ──────────────────────────────────────────
            Padding(
              padding: const EdgeInsets.fromLTRB(
                StrideTokens.spaceLg,
                StrideTokens.spaceXl,
                StrideTokens.spaceLg,
                StrideTokens.spaceLg,
              ),
              child: Row(
                children: [
                  Container(
                    width: 56,
                    height: 56,
                    alignment: Alignment.center,
                    decoration: const BoxDecoration(
                      color: StrideTokens.accentFg,
                      shape: BoxShape.circle,
                    ),
                    child: Text(
                      initial,
                      style: const TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs22,
                        fontWeight: FontWeight.w700,
                        color: StrideTokens.accent,
                      ),
                    ),
                  ),
                  const SizedBox(width: StrideTokens.spaceMd),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          displayName,
                          style: const TextStyle(
                            fontFamily: AppTypography.fontSans,
                            fontSize: StrideTokens.fs20,
                            fontWeight: FontWeight.w700,
                            color: StrideTokens.fg,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 4),
                        Text(
                          watchLabel,
                          style: const TextStyle(
                            fontFamily: AppTypography.fontMono,
                            fontSize: StrideTokens.fs11,
                            color: StrideTokens.muted,
                            letterSpacing: 0.6,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const Divider(height: 1, color: StrideTokens.border2),

            // ── Nav list ─────────────────────────────────────────────────
            Expanded(
              child: ListView(
                padding: EdgeInsets.zero,
                children: [
                  ProfileMenuItem(
                    icon: Icons.person_outline,
                    label: '账号资料',
                    onTap: () => _go(context, RoutesV2.me),
                  ),
                  ProfileMenuItem(
                    icon: Icons.watch_outlined,
                    label: '手表绑定',
                    trailing: _trailingText(
                        watch?.brand != null ? watch!.brand!.toUpperCase() : '未绑定'),
                    onTap: () {
                      Navigator.of(context).pop();
                      if (watch?.brand == null) {
                        context.go(RoutesV2.onboardingBrand);
                      } else {
                        _confirmUnbind(context, ref, watch!.brand!);
                      }
                    },
                  ),
                  ProfileMenuItem(
                    icon: Icons.sync,
                    label: '同步手表数据',
                    enabled: !syncing,
                    trailing: syncing
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: StrideTokens.accent,
                            ),
                          )
                        : null,
                    onTap: () async {
                      // Keep the drawer open so the row's spinner is visible
                      // while the COROS sync runs; mirror SyncIconButton UX.
                      final messenger = ScaffoldMessenger.of(context);
                      try {
                        await ref
                            .read(syncControllerProvider.notifier)
                            .triggerSync();
                        messenger.showSnackBar(
                          const SnackBar(content: Text('已同步手表数据')),
                        );
                      } catch (e) {
                        messenger.showSnackBar(
                          SnackBar(content: Text('同步失败：$e')),
                        );
                      }
                    },
                  ),
                  ProfileMenuItem(
                    icon: Icons.settings_outlined,
                    label: '设置',
                    onTap: () {
                      Navigator.of(context).pop();
                      try {
                        context.push('/notifications/settings');
                      } catch (_) {
                        _comingSoon(context, '设置');
                      }
                    },
                  ),
                  ProfileMenuItem(
                    icon: Icons.chat_bubble_outline,
                    label: '意见反馈',
                    onTap: () => _comingSoonClose(context, '意见反馈'),
                  ),
                  ProfileMenuItem(
                    icon: Icons.help_outline,
                    label: '常见问题',
                    onTap: () => _comingSoonClose(context, '常见问题'),
                  ),
                  ProfileMenuItem(
                    icon: Icons.system_update_alt,
                    label: '检查新版本',
                    onTap: () async {
                      final messenger = ScaffoldMessenger.of(context);
                      if (!Platform.isAndroid) {
                        messenger.showSnackBar(
                          const SnackBar(
                            content: Text('iOS 通过 TestFlight 更新'),
                          ),
                        );
                        return;
                      }
                      final info = await ref
                          .read(updateCheckerProvider)
                          .check(force: true);
                      if (!context.mounted) return;
                      if (info == null) {
                        messenger.showSnackBar(
                          const SnackBar(content: Text('已是最新版本')),
                        );
                        return;
                      }
                      await showUpdatePrompt(context, ref, info);
                    },
                  ),
                  ProfileMenuItem(
                    icon: Icons.info_outline,
                    label: '关于 STRIDE',
                    trailing: _trailingText(
                        appVersion != null ? 'v$appVersion' : 'v…'),
                    onTap: () {
                      Navigator.of(context).pop();
                      _showAbout(context);
                    },
                  ),
                ],
              ),
            ),

            const Divider(height: 1, color: StrideTokens.border2),
            ProfileMenuItem(
              icon: Icons.logout,
              label: '退出登录',
              destructive: true,
              trailing: const SizedBox.shrink(),
              onTap: () => _confirmLogout(context, ref),
            ),
            const Padding(
              padding: EdgeInsets.symmetric(vertical: StrideTokens.spaceMd),
              child: Center(
                child: Text(
                  'STRIDE · 跑得更聪明',
                  style: TextStyle(
                    fontFamily: AppTypography.fontMono,
                    fontSize: StrideTokens.fs10,
                    color: StrideTokens.muted2,
                    letterSpacing: 0.8,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  // Placeholder until package_info is read async in _showAbout; the row label
  // just shows "v…" — the precise version surfaces in the about dialog.
  static const String _appVersionSync = '1.0.0';

  static Widget _trailingText(String text) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            text,
            style: const TextStyle(
              fontFamily: AppTypography.fontMono,
              fontSize: StrideTokens.fs11,
              color: StrideTokens.muted,
            ),
          ),
          const SizedBox(width: 4),
          const Icon(Icons.chevron_right, size: 18, color: StrideTokens.muted2),
        ],
      );

  static void _go(BuildContext context, String route) {
    Navigator.of(context).pop();
    context.push(route);
  }

  static void _comingSoonClose(BuildContext context, String feature) {
    Navigator.of(context).pop();
    _comingSoon(context, feature);
  }

  static void _comingSoon(BuildContext context, String feature) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('$feature — v1.x 即将支持')),
    );
  }

  static String _emailPrefix(String email) {
    final at = email.indexOf('@');
    return at > 0 ? email.substring(0, at) : email;
  }

  Future<void> _showAbout(BuildContext context) async {
    String version = _appVersionSync;
    try {
      final info = await PackageInfo.fromPlatform();
      version = '${info.version}+${info.buildNumber}';
    } catch (_) {/* test env fallback */}
    if (!context.mounted) return;
    showAboutDialog(
      context: context,
      applicationName: 'STRIDE',
      applicationVersion: version,
      applicationLegalese: '© 2026 STRIDE Running',
    );
  }

  Future<void> _confirmUnbind(
      BuildContext context, WidgetRef ref, String brand) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('解绑手表'),
        content: Text('确认解绑 ${brand.toUpperCase()} 手表？'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            style: TextButton.styleFrom(foregroundColor: StrideTokens.danger),
            child: const Text('解绑'),
          ),
        ],
      ),
    );
    if (confirmed == true && context.mounted) {
      try {
        await ref.read(strideApiProvider).unbindWatch();
        ref.invalidate(homeProvider);
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('手表已解绑')),
          );
        }
      } catch (e) {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('解绑失败: $e')),
          );
        }
      }
    }
  }

  Future<void> _confirmLogout(BuildContext context, WidgetRef ref) async {
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
            style: TextButton.styleFrom(foregroundColor: StrideTokens.danger),
            child: const Text('退出'),
          ),
        ],
      ),
    );
    if (confirmed == true && context.mounted) {
      await ref.read(authControllerProvider.notifier).logout();
      if (context.mounted) context.go(RoutesV2.authStart);
    }
  }
}
