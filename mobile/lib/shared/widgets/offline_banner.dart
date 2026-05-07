import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/connectivity/connectivity_provider.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/app_typography.dart';

/// Thin banner shown above the bottom-nav when the device is offline.
/// Cached reads still work; writes are disabled per AC9.
class OfflineBanner extends ConsumerWidget {
  const OfflineBanner({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final online = ref.watch(connectivityProvider).valueOrNull ?? true;
    if (online) return const SizedBox.shrink();
    return Container(
      width: double.infinity,
      color: AppColors.warning.withValues(alpha: 0.18),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      child: const Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.cloud_off, size: 14, color: AppColors.warning),
          SizedBox(width: 6),
          Text(
            '离线 · 显示缓存数据',
            style: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: 12,
              fontWeight: FontWeight.w500,
              color: AppColors.warning,
            ),
          ),
        ],
      ),
    );
  }
}
