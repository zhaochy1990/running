import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/auth/auth_controller.dart';
import '../../core/auth/current_user.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/app_typography.dart';
import '../../data/api/stride_api.dart';

class ProfileScreen extends ConsumerStatefulWidget {
  const ProfileScreen({super.key});

  @override
  ConsumerState<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends ConsumerState<ProfileScreen> {
  bool _syncing = false;
  String? _syncStatus;

  Future<void> _triggerSync() async {
    final profile = ref.read(currentUserProvider).valueOrNull;
    if (profile == null) return;
    setState(() {
      _syncing = true;
      _syncStatus = '正在从 COROS 拉取最新数据…';
    });
    try {
      await ref.read(strideApiProvider).triggerSync(profile.id);
      if (!mounted) return;
      setState(() {
        _syncing = false;
        _syncStatus = '同步完成 · ${TimeOfDay.now().format(context)}';
      });
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('同步完成')),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _syncing = false;
        _syncStatus = '同步失败：$e';
      });
    }
  }

  Future<void> _openPrivacy() async {
    final uri = Uri.parse('https://stride-running.cn/privacy');
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('无法打开 $uri')),
      );
    }
  }

  Future<void> _confirmLogout() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('退出登录'),
        content: const Text('退出后需要重新输入邮箱密码。继续吗？'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('确认退出'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    await ref.read(authControllerProvider.notifier).logout();
    if (!mounted) return;
    context.go('/login');
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final authState = ref.watch(authControllerProvider);
    final isAuthed = authState is AuthAuthenticated;
    final user = ref.watch(currentUserProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('我的')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: ListTile(
              contentPadding:
                  const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              leading: CircleAvatar(
                radius: 24,
                backgroundColor: AppColors.gray800,
                child: Text(
                  _initial(user.valueOrNull?.displayName),
                  style: const TextStyle(
                    fontFamily: AppTypography.fontMono,
                    fontWeight: FontWeight.w700,
                    color: AppColors.background,
                    fontSize: 18,
                  ),
                ),
              ),
              title: Text(
                user.valueOrNull?.displayName ?? (isAuthed ? '加载中…' : '未登录'),
                style: theme.textTheme.titleLarge,
              ),
              subtitle: Text(
                isAuthed
                    ? (user.valueOrNull?.id ?? '加载用户信息')
                    : '点击登录使用全部功能',
                style: AppTypography.monoCaption,
              ),
              onTap: isAuthed ? null : () => context.go('/login'),
            ),
          ),
          const SizedBox(height: 16),
          Card(
            child: Column(
              children: [
                _SettingRow(
                  icon: Icons.sync,
                  label: '同步 COROS 数据',
                  subtitle: _syncStatus,
                  trailing: _syncing
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child:
                              CircularProgressIndicator(strokeWidth: 2),
                        )
                      : null,
                  onTap: _syncing || !isAuthed ? null : _triggerSync,
                ),
                const Divider(height: 1, color: AppColors.border),
                _SettingRow(
                  icon: Icons.notifications_outlined,
                  label: '通知设置',
                  onTap: isAuthed
                      ? () => context.push('/notifications/settings')
                      : null,
                ),
                const Divider(height: 1, color: AppColors.border),
                _SettingRow(
                  icon: Icons.shield_outlined,
                  label: '隐私政策',
                  onTap: _openPrivacy,
                ),
                if (isAuthed) ...[
                  const Divider(height: 1, color: AppColors.border),
                  _SettingRow(
                    icon: Icons.logout,
                    label: '退出登录',
                    color: AppColors.danger,
                    onTap: _confirmLogout,
                  ),
                ] else ...[
                  const Divider(height: 1, color: AppColors.border),
                  _SettingRow(
                    icon: Icons.login,
                    label: '登录',
                    color: AppColors.accentDark,
                    onTap: () => context.go('/login'),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 16),
          Center(
            child: Text(
              'STRIDE v2026.5.0',
              style: theme.textTheme.bodySmall,
            ),
          ),
        ],
      ),
    );
  }

  static String _initial(String? name) {
    if (name == null || name.isEmpty) return '?';
    final ch = name.runes.first;
    return String.fromCharCode(ch).toUpperCase();
  }
}

class _SettingRow extends StatelessWidget {
  const _SettingRow({
    required this.icon,
    required this.label,
    this.color,
    this.onTap,
    this.subtitle,
    this.trailing,
  });

  final IconData icon;
  final String label;
  final Color? color;
  final VoidCallback? onTap;
  final String? subtitle;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      leading: Icon(icon, size: 20, color: color ?? AppColors.foreground),
      title: Text(
        label,
        style: TextStyle(
          fontFamily: 'GeistSans',
          fontSize: 14,
          fontWeight: FontWeight.w500,
          color: color ?? AppColors.foreground,
        ),
      ),
      subtitle: subtitle != null
          ? Text(subtitle!, style: AppTypography.monoCaption)
          : null,
      trailing: trailing ??
          const Icon(
            Icons.arrow_forward_ios,
            size: 14,
            color: AppColors.foregroundMuted,
          ),
      onTap: onTap,
      enabled: onTap != null,
    );
  }
}
