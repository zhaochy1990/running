import 'dart:async';
import 'dart:io';

import 'package:app_settings/app_settings.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/app_typography.dart';
import '../../data/api/stride_api.dart';
import '../../data/models/notifications.dart';

/// Detect whether system-level notifications are enabled. Stays
/// best-effort on Android via a tiny MethodChannel; on iOS we rely on
/// the JPush apply-permission result. For v1 we only need to know *if*
/// the OS has permission, not which channel.
final _systemEnabledProvider = FutureProvider<bool>((ref) async {
  if (!Platform.isAndroid) return true;
  try {
    const ch = MethodChannel('cn.striderunning.app/notifications');
    final result = await ch.invokeMethod<bool>('areNotificationsEnabled');
    return result ?? true;
  } catch (_) {
    return true;
  }
});

final _prefsProvider = FutureProvider<NotificationPrefs>((ref) async {
  return ref.watch(strideApiProvider).getNotificationPrefs();
});

class NotificationSettingsScreen extends ConsumerWidget {
  const NotificationSettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final prefs = ref.watch(_prefsProvider);
    final sysEnabled = ref.watch(_systemEnabledProvider).valueOrNull ?? true;

    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.pop(),
        ),
        title: const Text('通知设置'),
      ),
      body: prefs.when(
        loading: () =>
            const Center(child: CircularProgressIndicator(strokeWidth: 2)),
        error: (e, _) => Center(child: Text('加载失败：$e')),
        data: (data) => ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (!sysEnabled) const _SystemDisabledCard(),
            if (!sysEnabled) const SizedBox(height: 16),
            Card(
              child: Column(
                children: [
                  _PrefSwitchTile(
                    title: '点赞提醒',
                    subtitle: '队友为你的训练点赞时通知',
                    value: data.likesEnabled,
                    enabled: sysEnabled,
                    onChanged: (v) async {
                      await ref
                          .read(strideApiProvider)
                          .patchNotificationPrefs(likesEnabled: v);
                      ref.invalidate(_prefsProvider);
                    },
                  ),
                  const Divider(height: 1, color: AppColors.border),
                  _PrefSwitchTile(
                    title: '训练日提醒',
                    subtitle: '早上 ${data.planReminderTime} 推送当天计划',
                    value: data.planReminderEnabled,
                    enabled: sysEnabled,
                    onChanged: (v) async {
                      await ref
                          .read(strideApiProvider)
                          .patchNotificationPrefs(planReminderEnabled: v);
                      ref.invalidate(_prefsProvider);
                    },
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SystemDisabledCard extends StatelessWidget {
  const _SystemDisabledCard();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      color: AppColors.warning.withValues(alpha: 0.08),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.notifications_off,
                    size: 18, color: AppColors.warning),
                const SizedBox(width: 8),
                Text('系统通知已关闭', style: theme.textTheme.titleMedium),
              ],
            ),
            const SizedBox(height: 8),
            const Text(
              '要接收点赞和训练提醒，请在系统设置中\n为 STRIDE 开启通知权限。',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: 14,
                height: 1.5,
                color: AppColors.foreground,
              ),
            ),
            const SizedBox(height: 12),
            Align(
              alignment: Alignment.centerRight,
              child: FilledButton(
                onPressed: () =>
                    AppSettings.openAppSettings(type: AppSettingsType.notification),
                child: const Text('去设置'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _PrefSwitchTile extends StatelessWidget {
  const _PrefSwitchTile({
    required this.title,
    required this.subtitle,
    required this.value,
    required this.enabled,
    required this.onChanged,
  });

  final String title;
  final String subtitle;
  final bool value;
  final bool enabled;
  final FutureOr<void> Function(bool) onChanged;

  @override
  Widget build(BuildContext context) {
    return SwitchListTile(
      title: Text(title),
      subtitle: Text(subtitle, style: AppTypography.monoCaption),
      value: enabled && value,
      onChanged: enabled ? (v) => onChanged(v) : null,
    );
  }
}
