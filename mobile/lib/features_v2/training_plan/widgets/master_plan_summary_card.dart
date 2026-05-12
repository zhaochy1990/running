/// MasterPlanSummaryCard — compact overview strip shown at the top of
/// the C5 review screen. Displays key plan dimensions from the summary.
library;

import 'package:flutter/material.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/tokens.dart';
import '../providers/master_plan_review_provider.dart';

class MasterPlanSummaryCard extends StatelessWidget {
  const MasterPlanSummaryCard({
    super.key,
    required this.summary,
  });

  final MasterPlanSummary summary;

  /// Format ISO date "2026-10-18" → "2026.10.18"
  static String _fmtDate(String? iso) {
    if (iso == null || iso.isEmpty) return '--';
    return iso.replaceAll('-', '.');
  }

  @override
  Widget build(BuildContext context) {
    final dateRange = summary.startDate != null || summary.endDate != null
        ? '${_fmtDate(summary.startDate)} – ${_fmtDate(summary.endDate)}'
        : null;

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(
        horizontal: StrideTokens.spaceLg,
        vertical: StrideTokens.spaceMd,
      ),
      decoration: const BoxDecoration(
        color: StrideTokens.surface,
        border: Border(
          bottom: BorderSide(color: StrideTokens.border2),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (dateRange != null)
            Text(
              dateRange,
              style: const TextStyle(
                fontFamily: AppTypography.fontMono,
                fontSize: StrideTokens.fs12,
                color: StrideTokens.muted,
              ),
            ),
          const SizedBox(height: StrideTokens.spaceSm),
          Row(
            children: [
              if (summary.totalWeeks != null)
                _Chip(label: '${summary.totalWeeks} 周'),
              if (summary.phaseCount != null)
                _Chip(label: '${summary.phaseCount} 阶段'),
              if (summary.milestoneCount != null)
                _Chip(label: '${summary.milestoneCount} 里程碑'),
            ],
          ),
        ],
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(right: StrideTokens.spaceSm),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: StrideTokens.accentFg,
        borderRadius: BorderRadius.circular(StrideTokens.radiusPill),
      ),
      child: Text(
        label,
        style: const TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: StrideTokens.fs12,
          fontWeight: FontWeight.w500,
          color: StrideTokens.accent,
        ),
      ),
    );
  }
}
