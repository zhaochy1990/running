/// WeekCard — a single row card in the D2a 周列表.
///
/// Displays:
///   - 周标签 + 状态 pill
///   - 完成率进度条 (when totalSessions > 0)
///   - 7-day mini-calendar color blocks
///   - 关键数据: 周里程 + 总时长
library;

import 'package:flutter/material.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/pill_colors.dart';
import '../../../core/theme/tokens.dart';
import '../../_shared/widgets/pill.dart';
import '../models/week_list_item.dart';

class WeekCard extends StatelessWidget {
  const WeekCard({
    super.key,
    required this.item,
    required this.onTap,
  });

  final WeekListItem item;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.only(bottom: StrideTokens.spaceMd),
        padding: const EdgeInsets.all(StrideTokens.spaceLg),
        decoration: BoxDecoration(
          color: StrideTokens.surface,
          borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
          border: Border.all(color: StrideTokens.border2),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Row 1: 周标签 + 状态 pill
            Row(
              children: [
                Expanded(
                  child: Text(
                    _headerLabel(),
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs15,
                      fontWeight: FontWeight.w600,
                      color: StrideTokens.fg,
                      height: 1.2,
                    ),
                  ),
                ),
                const SizedBox(width: StrideTokens.spaceSm),
                StridePill(
                  text: _statusLabel(),
                  variant: _statusVariant(),
                ),
                const SizedBox(width: StrideTokens.spaceXs),
                const Icon(
                  Icons.chevron_right,
                  size: 16,
                  color: StrideTokens.muted,
                ),
              ],
            ),
            // Date range sub-label
            const SizedBox(height: 2),
            Text(
              _dateRangeLabel(),
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs12,
                color: StrideTokens.muted,
                height: 1.3,
              ),
            ),
            // Completion progress bar (only when we have session counts)
            if (item.totalSessions != null && item.totalSessions! > 0) ...[
              const SizedBox(height: StrideTokens.spaceMd),
              _CompletionBar(
                completed: item.completedSessions ?? 0,
                total: item.totalSessions!,
              ),
            ],
            // Mini 7-day calendar
            if (item.miniCalendar != null) ...[
              const SizedBox(height: StrideTokens.spaceMd),
              _MiniCalendar(calendar: item.miniCalendar!),
            ],
            // Key stats: 里程 + 时长
            if (item.weeklyDistanceM != null || item.weeklyDurationS != null) ...[
              const SizedBox(height: StrideTokens.spaceMd),
              _StatsRow(
                distanceM: item.weeklyDistanceM,
                durationS: item.weeklyDurationS,
              ),
            ],
          ],
        ),
      ),
    );
  }

  String _headerLabel() {
    if (item.weekLabel != null) return item.weekLabel!;
    if (item.planTitle != null) return item.planTitle!;
    return _dateRangeLabel();
  }

  String _dateRangeLabel() {
    // Format "5/11 – 5/17"
    final from = _shortDate(item.dateFrom);
    final to = _shortDate(item.dateTo);
    return '$from – $to';
  }

  static String _shortDate(String iso) {
    final dt = DateTime.tryParse(iso);
    if (dt == null) return iso;
    return '${dt.month}/${dt.day}';
  }

  String _statusLabel() {
    return switch (item.status) {
      WeekStatus.inProgress => '进行中',
      WeekStatus.completed => '已完成',
      WeekStatus.upcoming => '未开始',
    };
  }

  PillVariant _statusVariant() {
    return switch (item.status) {
      WeekStatus.inProgress => PillVariant.green,
      WeekStatus.completed => PillVariant.muted,
      WeekStatus.upcoming => PillVariant.solid,
    };
  }
}

// ── Completion progress bar ───────────────────────────────────────────────────

class _CompletionBar extends StatelessWidget {
  const _CompletionBar({required this.completed, required this.total});

  final int completed;
  final int total;

  @override
  Widget build(BuildContext context) {
    final ratio = (total > 0 ? completed / total : 0.0).clamp(0.0, 1.0);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            const Text(
              '完成进度',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs12,
                color: StrideTokens.muted,
              ),
            ),
            Text(
              '$completed/$total',
              style: const TextStyle(
                fontFamily: AppTypography.fontMono,
                fontSize: StrideTokens.fs12,
                color: StrideTokens.fgSoft,
              ),
            ),
          ],
        ),
        const SizedBox(height: 4),
        ClipRRect(
          borderRadius: BorderRadius.circular(2),
          child: LinearProgressIndicator(
            value: ratio,
            minHeight: 4,
            backgroundColor: StrideTokens.border2,
            valueColor:
                const AlwaysStoppedAnimation<Color>(StrideTokens.accent),
          ),
        ),
      ],
    );
  }
}

// ── Mini 7-day calendar ───────────────────────────────────────────────────────

class _MiniCalendar extends StatelessWidget {
  const _MiniCalendar({required this.calendar});

  /// 7 elements, index 0 = Monday … index 6 = Sunday.
  final List<String?> calendar;

  static const _dayLabels = ['一', '二', '三', '四', '五', '六', '日'];

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        for (int i = 0; i < 7; i++) ...[
          if (i > 0) const SizedBox(width: 4),
          Expanded(
            child: _DayBlock(
              dayLabel: _dayLabels[i],
              kind: calendar[i],
            ),
          ),
        ],
      ],
    );
  }
}

class _DayBlock extends StatelessWidget {
  const _DayBlock({required this.dayLabel, required this.kind});

  final String dayLabel;
  final String? kind;

  @override
  Widget build(BuildContext context) {
    final color = _kindColor(kind);
    return Column(
      children: [
        Container(
          height: 20,
          decoration: BoxDecoration(
            color: color,
            borderRadius: BorderRadius.circular(3),
          ),
        ),
        const SizedBox(height: 2),
        Text(
          dayLabel,
          style: const TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs10,
            color: StrideTokens.muted,
          ),
          textAlign: TextAlign.center,
        ),
      ],
    );
  }

  static Color _kindColor(String? kind) {
    return switch (kind?.toUpperCase()) {
      'E' => StrideTokens.accent,           // green — easy
      'M' => const Color(0xFF3B82F6),       // blue — marathon pace
      'T' => StrideTokens.warn,             // amber — tempo
      'I' => const Color(0xFFEF4444),       // red — interval
      'R' => StrideTokens.danger,           // danger — rep/sprint
      'STRENGTH' => const Color(0xFF8B5CF6), // purple — strength
      'REST' => StrideTokens.border,        // light grey — rest
      null => StrideTokens.border2,         // no plan
      _ => StrideTokens.muted2,             // unknown
    };
  }
}

// ── Stats row ─────────────────────────────────────────────────────────────────

class _StatsRow extends StatelessWidget {
  const _StatsRow({this.distanceM, this.durationS});

  final num? distanceM;
  final num? durationS;

  @override
  Widget build(BuildContext context) {
    final distStr = distanceM != null
        ? '${(distanceM! / 1000).toStringAsFixed(1)} km'
        : null;
    final durStr = durationS != null ? _fmtDuration(durationS!.toInt()) : null;

    final parts = <String>[
      ?distStr,
      ?durStr,
    ];
    if (parts.isEmpty) return const SizedBox.shrink();

    return Text(
      parts.join('  ·  '),
      style: const TextStyle(
        fontFamily: AppTypography.fontMono,
        fontSize: StrideTokens.fs12,
        color: StrideTokens.fgSoft,
      ),
    );
  }

  static String _fmtDuration(int totalSec) {
    final h = totalSec ~/ 3600;
    final m = (totalSec % 3600) ~/ 60;
    if (h > 0) return '${h}h${m.toString().padLeft(2, '0')}m';
    return '${m}min';
  }
}
