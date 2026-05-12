/// C8 — Master plan adjustment history screen (fullscreen, no shell).
///
/// Shows a time-descending list of MasterPlanVersion entries.
/// Tap a version to view the full snapshot.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/router/routes_v2.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/top_bar.dart';
import '../../data/api/stride_api.dart';
import 'models/master_plan.dart';

// ── Provider ──────────────────────────────────────────────────────────────────

final _versionsProvider = FutureProvider.autoDispose
    .family<List<MasterPlanVersionSummary>, String>((ref, planId) async {
  final api = ref.watch(strideApiProvider);
  return api.listMasterPlanVersions(planId);
});

// ── Screen ────────────────────────────────────────────────────────────────────

class MasterPlanHistoryScreen extends ConsumerWidget {
  const MasterPlanHistoryScreen({super.key, required this.planId});

  final String planId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(_versionsProvider(planId));

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        title: '调整历史',
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => Navigator.of(context).pop(),
        ),
      ),
      body: async.when(
        loading: () => const Center(
          child: CircularProgressIndicator(color: StrideTokens.accent),
        ),
        error: (err, _) => Center(
          child: Padding(
            padding: const EdgeInsets.all(StrideTokens.spaceLg),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.error_outline,
                    size: 40, color: StrideTokens.muted),
                const SizedBox(height: StrideTokens.spaceMd),
                Text(
                  '加载失败：$err',
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs13,
                    color: StrideTokens.muted,
                  ),
                ),
                const SizedBox(height: StrideTokens.spaceMd),
                TextButton(
                  onPressed: () => ref.refresh(_versionsProvider(planId)),
                  child: const Text('重试'),
                ),
              ],
            ),
          ),
        ),
        data: (versions) {
          if (versions.isEmpty) {
            return const Center(
              child: Text(
                '暂无调整历史',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs14,
                  color: StrideTokens.muted,
                ),
              ),
            );
          }
          return ListView.separated(
            padding: const EdgeInsets.symmetric(
              horizontal: StrideTokens.spaceLg,
              vertical: StrideTokens.spaceMd,
            ),
            itemCount: versions.length,
            separatorBuilder: (_, __) =>
                const SizedBox(height: StrideTokens.spaceSm),
            itemBuilder: (context, index) => _VersionCard(
              version: versions[index],
              planId: planId,
            ),
          );
        },
      ),
    );
  }
}

// ── Version card ──────────────────────────────────────────────────────────────

class _VersionCard extends StatelessWidget {
  const _VersionCard({required this.version, required this.planId});

  final MasterPlanVersionSummary version;
  final String planId;

  static String _fmtDatetime(String iso) {
    if (iso.isEmpty) return '--';
    try {
      final dt = DateTime.parse(iso).toLocal();
      return '${dt.year}.${dt.month.toString().padLeft(2, '0')}.${dt.day.toString().padLeft(2, '0')} '
          '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
    } catch (_) {
      return iso;
    }
  }

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: () => context.push(
        RoutesV2.trainingPlanVersion(planId, version.version),
      ),
      borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
      child: Container(
        padding: const EdgeInsets.all(StrideTokens.spaceMd),
        decoration: BoxDecoration(
          color: StrideTokens.surface,
          borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
          border: Border.all(color: StrideTokens.border2),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Version badge
            Container(
              width: 36,
              height: 36,
              decoration: BoxDecoration(
                color: StrideTokens.accentFg,
                borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
              ),
              child: Center(
                child: Text(
                  'V${version.version}',
                  style: const TextStyle(
                    fontFamily: AppTypography.fontMono,
                    fontSize: StrideTokens.fs12,
                    fontWeight: FontWeight.w700,
                    color: StrideTokens.accent,
                  ),
                ),
              ),
            ),
            const SizedBox(width: StrideTokens.spaceMd),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    version.changeReason.isNotEmpty
                        ? version.changeReason
                        : '(无说明)',
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs13,
                      fontWeight: FontWeight.w500,
                      color: StrideTokens.fg,
                    ),
                  ),
                  if (version.changeSummary.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(
                      version.changeSummary,
                      style: const TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs12,
                        color: StrideTokens.muted,
                      ),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                  const SizedBox(height: 4),
                  Text(
                    _fmtDatetime(version.changedAt),
                    style: const TextStyle(
                      fontFamily: AppTypography.fontMono,
                      fontSize: StrideTokens.fs11,
                      color: StrideTokens.muted2,
                    ),
                  ),
                ],
              ),
            ),
            const Icon(Icons.chevron_right, size: 18, color: StrideTokens.muted),
          ],
        ),
      ),
    );
  }
}
