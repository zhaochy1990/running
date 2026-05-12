/// G1 — 个人中心 (Profile / Me screen).
///
/// Shows user header (avatar + name + email + lifetime mileage) and
/// a menu list with settings entries + logout.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../../core/auth/auth_controller.dart';
import '../../core/auth/current_user.dart';
import '../../core/router/routes_v2.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../../core/updater/update_checker.dart';
import '../../data/api/stride_api.dart';
import '../../features/updater/update_prompt.dart';
import '../_shared/widgets/top_bar.dart';
import '../home/models/home_data.dart';
import '../home/providers/home_provider.dart';
import 'widgets/menu_item.dart';

class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profileAsync = ref.watch(currentUserProvider);
    final homeAsync = ref.watch(homeProvider);

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: const StrideTopBar(title: '我'),
      body: profileAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(
          child: Text(
            '加载失败: $e',
            style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs13,
                color: StrideTokens.muted),
          ),
        ),
        data: (profile) {
          final displayName = profile?.displayName ??
              profile?.profile?['display_name'] as String? ??
              _emailPrefix(
                  (profile?.profile?['email'] as String?) ?? '');

          final email = (profile?.profile?['email'] as String?) ?? '';

          final lifetimeKm = homeAsync.valueOrNull?.lifetimeStats.totalDistanceKm;

          return _ProfileBody(
            displayName: displayName,
            email: email,
            lifetimeKm: lifetimeKm,
            watch: homeAsync.valueOrNull?.watch,
          );
        },
      ),
    );
  }

  static String _emailPrefix(String email) {
    final at = email.indexOf('@');
    return at > 0 ? email.substring(0, at) : email;
  }
}

// ── Body ──────────────────────────────────────────────────────────────────────

class _ProfileBody extends ConsumerWidget {
  const _ProfileBody({
    required this.displayName,
    required this.email,
    this.lifetimeKm,
    this.watch,
  });

  final String displayName;
  final String email;
  final double? lifetimeKm;
  final WatchInfo? watch;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ListView(
      children: [
        _UserHeader(
          displayName: displayName,
          email: email,
          lifetimeKm: lifetimeKm,
        ),
        const SizedBox(height: StrideTokens.spaceSm),
        _Divider(),
        // ── Personal ────────────────────────────────────────────────────
        _SectionTitle('个人'),
        ProfileMenuItem(
          icon: Icons.person_outline,
          label: '个人信息',
          onTap: () => _showComingSoon(context, '个人信息编辑'),
        ),
        ProfileMenuItem(
          icon: Icons.directions_run,
          label: '跑步档案',
          onTap: () => _showComingSoon(context, '跑步档案'),
        ),
        ProfileMenuItem(
          icon: Icons.flag_outlined,
          label: '训练目标',
          onTap: () => _showComingSoon(context, '训练目标'),
        ),
        ProfileMenuItem(
          icon: Icons.restaurant_outlined,
          label: '营养偏好',
          onTap: () => context.push(RoutesV2.nutritionPrefs),
        ),
        _Divider(),
        // ── Device ──────────────────────────────────────────────────────
        _SectionTitle('设备与通知'),
        _WatchMenuItem(watch: watch),
        ProfileMenuItem(
          icon: Icons.notifications_outlined,
          label: '通知设置',
          onTap: () {
            // Route to existing notification settings (legacy route).
            try {
              context.push('/notifications/settings');
            } catch (_) {
              _showComingSoon(context, '通知设置');
            }
          },
        ),
        _Divider(),
        // ── App ─────────────────────────────────────────────────────────
        _SectionTitle('关于'),
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
        _Divider(),
        // ── Logout ──────────────────────────────────────────────────────
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
    );
  }

  static void _showComingSoon(BuildContext context, String feature) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text('$feature — v1.x 即将支持'),
        duration: const Duration(seconds: 2),
      ),
    );
  }

  static Future<void> _checkForUpdate(
      BuildContext context, WidgetRef ref) async {
    // Snackbar messenger captured before the async gap so we can still
    // surface a result if the user navigates away.
    final messenger = ScaffoldMessenger.of(context);
    messenger.showSnackBar(
      const SnackBar(
        content: Text('正在检查更新…'),
        duration: Duration(seconds: 2),
      ),
    );
    try {
      final info =
          await ref.read(updateCheckerProvider).check(force: true);
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
      // Fallback in test env.
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
        context.go(RoutesV2.authStart);
      }
    }
  }
}

// ── User header ───────────────────────────────────────────────────────────────

class _UserHeader extends StatelessWidget {
  const _UserHeader({
    required this.displayName,
    required this.email,
    this.lifetimeKm,
  });

  final String displayName;
  final String email;
  final double? lifetimeKm;

  @override
  Widget build(BuildContext context) {
    final initial =
        displayName.isNotEmpty ? displayName[0].toUpperCase() : 'U';
    final kmStr = lifetimeKm != null
        ? '${lifetimeKm!.toStringAsFixed(0)} km'
        : '— km';

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
                const SizedBox(height: StrideTokens.spaceSm),
                Row(
                  children: [
                    const Icon(Icons.route_outlined,
                        size: 14, color: StrideTokens.muted),
                    const SizedBox(width: 4),
                    Text(
                      '累计 $kmStr',
                      style: const TextStyle(
                        fontFamily: AppTypography.fontMono,
                        fontSize: StrideTokens.fs12,
                        color: StrideTokens.muted,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ── Watch menu item ───────────────────────────────────────────────────────────

class _WatchMenuItem extends ConsumerWidget {
  const _WatchMenuItem({this.watch});

  final WatchInfo? watch;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final brand = watch?.brand;
    final brandLabel = brand != null ? brand.toUpperCase() : '未绑定';

    return ProfileMenuItem(
      icon: Icons.watch_outlined,
      label: '手表绑定',
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            brandLabel,
            style: const TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs12,
              color: StrideTokens.muted,
            ),
          ),
          const SizedBox(width: 4),
          const Icon(Icons.chevron_right, size: 18, color: StrideTokens.muted),
        ],
      ),
      onTap: brand != null
          ? () => _confirmUnbind(context, ref, brand)
          : () => context.go(RoutesV2.onboardingBrand),
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
            style: TextButton.styleFrom(
              foregroundColor: StrideTokens.danger,
            ),
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
}

// ── Helpers ───────────────────────────────────────────────────────────────────

class _Divider extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return const Divider(
      height: 1,
      thickness: 1,
      color: StrideTokens.border2,
      indent: 0,
      endIndent: 0,
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        StrideTokens.spaceLg,
        StrideTokens.spaceMd,
        StrideTokens.spaceLg,
        StrideTokens.spaceXs,
      ),
      child: Text(
        text,
        style: const TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: StrideTokens.fs11,
          fontWeight: FontWeight.w500,
          color: StrideTokens.muted,
          letterSpacing: 0.5,
        ),
      ),
    );
  }
}
