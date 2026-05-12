/// C8 — Master plan version snapshot screen (fullscreen, no shell).
///
/// Shows the full MasterPlan snapshot for a specific version number.
/// Simplified read-only view (no actions).
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/top_bar.dart';
import '../../data/api/stride_api.dart';
import 'models/master_plan.dart';
import 'widgets/milestone_row.dart';
import 'widgets/phase_detail_card.dart';

// ── Provider ──────────────────────────────────────────────────────────────────

final _versionSnapshotProvider = FutureProvider.autoDispose
    .family<MasterPlan?, _VersionKey>((ref, key) async {
  final api = ref.watch(strideApiProvider);
  final raw = await api.getMasterPlanVersion(key.planId, key.version);
  return MasterPlan.fromJson(raw);
});

class _VersionKey {
  const _VersionKey(this.planId, this.version);
  final String planId;
  final int version;

  @override
  bool operator ==(Object other) =>
      other is _VersionKey &&
      other.planId == planId &&
      other.version == version;

  @override
  int get hashCode => Object.hash(planId, version);
}

// ── Screen ────────────────────────────────────────────────────────────────────

class MasterPlanVersionScreen extends ConsumerWidget {
  const MasterPlanVersionScreen({
    super.key,
    required this.planId,
    required this.version,
  });

  final String planId;
  final int version;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final key = _VersionKey(planId, version);
    final async = ref.watch(_versionSnapshotProvider(key));

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        title: '版本 V$version 快照',
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
              ],
            ),
          ),
        ),
        data: (plan) {
          if (plan == null) {
            return const Center(
              child: Text(
                '版本数据不存在',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs14,
                  color: StrideTokens.muted,
                ),
              ),
            );
          }
          return _SnapshotBody(plan: plan);
        },
      ),
    );
  }
}

// ── Snapshot body ─────────────────────────────────────────────────────────────

class _SnapshotBody extends StatelessWidget {
  const _SnapshotBody({required this.plan});

  final MasterPlan plan;

  static String _fmtDate(String iso) => iso.replaceAll('-', '.');

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.only(bottom: StrideTokens.space3xl),
      children: [
        // Meta banner
        Container(
          margin: const EdgeInsets.all(StrideTokens.spaceLg),
          padding: const EdgeInsets.all(StrideTokens.spaceMd),
          decoration: BoxDecoration(
            color: StrideTokens.surface,
            borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
            border: Border.all(color: StrideTokens.border2),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '${_fmtDate(plan.startDate)} – ${_fmtDate(plan.endDate)}',
                style: const TextStyle(
                  fontFamily: AppTypography.fontMono,
                  fontSize: StrideTokens.fs12,
                  color: StrideTokens.muted,
                ),
              ),
              const SizedBox(height: 4),
              Row(
                children: [
                  _MetaChip('${plan.phases.length} 阶段'),
                  const SizedBox(width: StrideTokens.spaceSm),
                  _MetaChip('${plan.milestones.length} 里程碑'),
                  const SizedBox(width: StrideTokens.spaceSm),
                  _MetaChip('V${plan.version}'),
                ],
              ),
              if (plan.trainingPrinciples.isNotEmpty) ...[
                const SizedBox(height: StrideTokens.spaceSm),
                const Divider(height: 1, color: StrideTokens.border2),
                const SizedBox(height: StrideTokens.spaceSm),
                const Text(
                  '训练原则',
                  style: TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs12,
                    fontWeight: FontWeight.w600,
                    color: StrideTokens.muted,
                  ),
                ),
                const SizedBox(height: 4),
                for (final p in plan.trainingPrinciples)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 2),
                    child: Text(
                      '• $p',
                      style: const TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs13,
                        color: StrideTokens.fgSoft,
                        height: 1.4,
                      ),
                    ),
                  ),
              ],
            ],
          ),
        ),

        // Phase detail cards
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: StrideTokens.spaceLg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Padding(
                padding:
                    EdgeInsets.symmetric(vertical: StrideTokens.spaceSm),
                child: Text(
                  '阶段',
                  style: TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs12,
                    fontWeight: FontWeight.w600,
                    color: StrideTokens.muted,
                    letterSpacing: 0.5,
                  ),
                ),
              ),
              for (final phase in plan.phases)
                PhaseDetailCard(
                  phase: phase,
                  milestones: plan.milestones,
                  isCurrent: false, // snapshot — no "current" concept
                ),
            ],
          ),
        ),

        // Milestones
        if (plan.milestones.isNotEmpty) ...[
          const Padding(
            padding: EdgeInsets.fromLTRB(
              StrideTokens.spaceLg,
              StrideTokens.spaceSm,
              StrideTokens.spaceLg,
              StrideTokens.spaceSm,
            ),
            child: Text(
              '里程碑',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs12,
                fontWeight: FontWeight.w600,
                color: StrideTokens.muted,
                letterSpacing: 0.5,
              ),
            ),
          ),
          Container(
            margin:
                const EdgeInsets.symmetric(horizontal: StrideTokens.spaceLg),
            decoration: BoxDecoration(
              color: StrideTokens.surface,
              borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
              border: Border.all(color: StrideTokens.border2),
            ),
            child: Column(
              children: [
                for (final ms in plan.milestones)
                  MilestoneRow(milestone: ms),
              ],
            ),
          ),
        ],
      ],
    );
  }
}

class _MetaChip extends StatelessWidget {
  const _MetaChip(this.label);

  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: StrideTokens.grid,
        borderRadius: BorderRadius.circular(StrideTokens.radiusPill),
      ),
      child: Text(
        label,
        style: const TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: StrideTokens.fs11,
          color: StrideTokens.muted,
        ),
      ),
    );
  }
}
