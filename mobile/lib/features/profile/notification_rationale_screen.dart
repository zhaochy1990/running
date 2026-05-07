import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/notifications/jpush_service.dart';
import '../../core/notifications/rationale_storage.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/app_typography.dart';
import '../../data/api/stride_api.dart';

/// Pre-permission rationale shown once before the system POST_NOTIFICATIONS
/// dialog. Per plan §4 F3 (a), the copy must be verbatim.
class NotificationRationaleScreen extends ConsumerStatefulWidget {
  const NotificationRationaleScreen({super.key});

  @override
  ConsumerState<NotificationRationaleScreen> createState() =>
      _NotificationRationaleScreenState();
}

class _NotificationRationaleScreenState
    extends ConsumerState<NotificationRationaleScreen> {
  bool _busy = false;

  Future<void> _onContinue() async {
    if (_busy) return;
    setState(() => _busy = true);

    // Mark shown FIRST so a permission decline doesn't bring us back here.
    await RationaleStorage().markShown();
    try {
      final jpush = ref.read(jpushServiceProvider);
      await jpush.init(
        appKey: 'ab305c4addc8f9aa2b5efb4c',
        channel: 'default',
        production: true,
      );
      await jpush.registerOnServer(appVersion: '2026.5.0');
    } catch (_) {
      // Non-fatal — settings page lets the user fix it later.
    }
    if (!mounted) return;
    setState(() => _busy = false);
    context.pop();
  }

  Future<void> _onSkip() async {
    if (_busy) return;
    setState(() => _busy = true);
    await RationaleStorage().markShown();
    try {
      // Disable both notification kinds server-side so cron + like-hook
      // don't try to deliver to a missing registration.
      await ref.read(strideApiProvider).patchNotificationPrefs(
            likesEnabled: false,
            planReminderEnabled: false,
          );
    } catch (_) {
      // Non-fatal — user can always re-enable from 我的 → 通知设置.
    }
    if (!mounted) return;
    setState(() => _busy = false);
    context.pop();
  }

  Future<void> _openPrivacy() async {
    final uri = Uri.parse('https://stride-running.cn/privacy');
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(automaticallyImplyLeading: false),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 16, 24, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 16),
              const Icon(
                Icons.notifications_active_outlined,
                size: 40,
                color: AppColors.accentDark,
              ),
              const SizedBox(height: 16),
              Text(
                '开启通知，跟队友互动 + 别忘记今天的训练',
                style: theme.textTheme.headlineSmall,
              ),
              const SizedBox(height: 24),
              const _Bullet(text: '队友给你的活动点赞时第一时间收到提醒'),
              const SizedBox(height: 12),
              const _Bullet(text: '训练日早上 8 点提醒你今天的计划'),
              const SizedBox(height: 24),
              Text(
                '随时可以在“我的”里关闭。',
                style: theme.textTheme.bodyMedium,
              ),
              const SizedBox(height: 16),
              GestureDetector(
                onTap: _openPrivacy,
                child: Text(
                  '了解更多 →',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: AppColors.accentDark,
                    decoration: TextDecoration.underline,
                  ),
                ),
              ),
              const Spacer(),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: _busy ? null : _onSkip,
                      child: const Text('暂不开启'),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: FilledButton(
                      onPressed: _busy ? null : _onContinue,
                      child: _busy
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: Colors.white,
                              ),
                            )
                          : const Text('继续'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Bullet extends StatelessWidget {
  const _Bullet({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Padding(
          padding: EdgeInsets.only(top: 8, right: 12),
          child: Icon(Icons.circle, size: 6, color: AppColors.foregroundMuted),
        ),
        Expanded(
          child: Text(
            text,
            style: const TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: 15,
              height: 1.5,
              color: AppColors.foreground,
            ),
          ),
        ),
      ],
    );
  }
}
