/// 手表管理（/me/watch）—— 绑定状态 + 前往绑定 + 解绑确认。
/// PR-4（#462）会替换为 COROS/GARMIN 双品牌完整管理页。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/current_user.dart';
import '../../core/router/routes.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../../data/api/stride_api.dart';
import '../_shared/widgets/top_bar.dart';

class WatchScreen extends ConsumerWidget {
  const WatchScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profile = ref.watch(currentUserProvider).valueOrNull;
    final bound = profile?.onboarding.corosReady ?? false;

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: const StrideTopBar(title: '手表管理'),
      body: ListView(
        padding: const EdgeInsets.all(StrideTokens.spaceLg),
        children: [
          Container(
            padding: const EdgeInsets.all(StrideTokens.spaceLg),
            decoration: BoxDecoration(
              color: StrideTokens.surface,
              borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
              border: Border.all(color: StrideTokens.border2),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Icon(Icons.watch_outlined,
                        size: 22, color: StrideTokens.accent),
                    const SizedBox(width: StrideTokens.spaceMd),
                    Expanded(
                      child: Text(
                        bound ? '已绑定手表' : '未绑定手表',
                        style: const TextStyle(
                          fontFamily: AppTypography.fontSans,
                          fontSize: StrideTokens.fs15,
                          fontWeight: FontWeight.w700,
                          color: StrideTokens.fg,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: StrideTokens.spaceSm),
                Text(
                  bound
                      ? '同步会自动进行；也可在「我」页手动同步。'
                      : '绑定 COROS 手表后，训练数据将自动同步到 STRIDE。',
                  style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs13,
                    color: StrideTokens.muted,
                    height: 1.5,
                  ),
                ),
                const SizedBox(height: StrideTokens.spaceLg),
                SizedBox(
                  width: double.infinity,
                  height: 44,
                  child: FilledButton(
                    onPressed: () => context.push(Routes.onboardingBrand),
                    style: FilledButton.styleFrom(
                      backgroundColor: StrideTokens.accent,
                      foregroundColor: StrideTokens.surface,
                      shape: RoundedRectangleBorder(
                        borderRadius:
                            BorderRadius.circular(StrideTokens.radiusMd),
                      ),
                    ),
                    child: Text(bound ? '换绑手表' : '绑定手表'),
                  ),
                ),
                if (bound) ...[
                  const SizedBox(height: StrideTokens.spaceSm),
                  SizedBox(
                    width: double.infinity,
                    height: 44,
                    child: OutlinedButton(
                      onPressed: () => _confirmUnbind(context, ref),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: StrideTokens.danger,
                        side: const BorderSide(color: StrideTokens.danger),
                        shape: RoundedRectangleBorder(
                          borderRadius:
                              BorderRadius.circular(StrideTokens.radiusMd),
                        ),
                      ),
                      child: const Text('解绑手表'),
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

  Future<void> _confirmUnbind(BuildContext context, WidgetRef ref) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('解绑手表'),
        content: const Text('解绑后手表数据将不再自动同步，确认解绑？'),
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
    if (confirmed != true || !context.mounted) return;

    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(strideApiProvider).unbindWatch();
      // 绑定状态来自 currentUserProfile（onboarding.corosReady）。
      ref.invalidate(currentUserProvider);
      messenger.showSnackBar(
        const SnackBar(
          content: Text('手表已解绑'),
          backgroundColor: StrideTokens.accent,
        ),
      );
    } catch (e) {
      messenger.showSnackBar(
        SnackBar(
          content: Text('解绑失败：$e'),
          backgroundColor: StrideTokens.danger,
        ),
      );
    }
  }
}
