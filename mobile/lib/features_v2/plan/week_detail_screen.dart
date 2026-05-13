/// D2 — 周计划预览屏幕 (WeekDetailScreen).
///
/// 路由：/v2/plan/weeks/:folder（fullscreen，no shell）
///
/// 内容：
///   1. StrideTopBar：返回 + week 标题 + "调整"按钮（SnackBar 占位）
///   2. 本周定位卡：plan_title / phase
///   3. 周总览 StrideStatRow：周里程 / 总时长 / 力量次数
///   4. 7 天课表列表：每行 SessionRow，点击 → D3 课时详情（T25 占位）
///   5. 底部固定区：调整计划 + 推送到手表（均为 SnackBar 占位）
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../../core/router/routes_v2.dart';
import '../_shared/widgets/stat_row.dart';
import '../_shared/widgets/top_bar.dart';
import '../../data/models/plan.dart';
import 'providers/push_week_provider.dart';
import 'providers/week_detail_provider.dart';
import 'widgets/push_result_sheet.dart';
import 'widgets/session_row.dart';

class WeekDetailScreen extends ConsumerWidget {
  const WeekDetailScreen({super.key, required this.folder});

  final String folder;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(weekDetailProvider(folder));

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: async.when(
        loading: () => StrideTopBar(
          title: '本周计划',
          leading: _backButton(context),
        ),
        error: (_, _) => StrideTopBar(
          title: '本周计划',
          leading: _backButton(context),
        ),
        data: (data) => StrideTopBar(
          title: data.planTitle ?? _folderLabel(data.folder),
          leading: _backButton(context),
          actions: [
            TextButton(
              onPressed: () => context.push(RoutesV2.planChat(folder)),
              child: const Text(
                '调整',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs14,
                  color: StrideTokens.accent,
                ),
              ),
            ),
          ],
        ),
      ),
      body: async.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text(
                '加载失败',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs15,
                  color: StrideTokens.danger,
                ),
              ),
              const SizedBox(height: StrideTokens.spaceMd),
              TextButton(
                onPressed: () => ref.invalidate(weekDetailProvider(folder)),
                child: const Text('重试'),
              ),
            ],
          ),
        ),
        data: (data) => _Body(data: data, folder: folder),
      ),
    );
  }

  Widget _backButton(BuildContext context) {
    return IconButton(
      icon: const Icon(Icons.arrow_back),
      onPressed: () => context.pop(),
    );
  }

  static String _folderLabel(String folder) {
    // Extract the annotation part, e.g. "(W1基础)" → "W1基础"
    final match = RegExp(r'\(([^)]+)\)').firstMatch(folder);
    if (match != null) return match.group(1)!;
    return folder;
  }
}

// ── Body ──────────────────────────────────────────────────────────────────────

class _Body extends StatelessWidget {
  const _Body({required this.data, required this.folder});

  final WeekDetailData data;
  final String folder;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: EdgeInsets.zero,
            children: [
              // 本周定位卡
              _PositionCard(data: data),
              // 周总览 stat row
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  StrideTokens.spaceLg,
                  0,
                  StrideTokens.spaceLg,
                  StrideTokens.spaceLg,
                ),
                child: _WeekStatRow(data: data),
              ),
              // 7-day schedule header
              const Padding(
                padding: EdgeInsets.fromLTRB(
                  StrideTokens.spaceLg,
                  0,
                  StrideTokens.spaceLg,
                  StrideTokens.spaceSm,
                ),
                child: Text(
                  '本周课表',
                  style: TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs13,
                    fontWeight: FontWeight.w600,
                    color: StrideTokens.muted,
                    letterSpacing: 0.5,
                  ),
                ),
              ),
              // Session list card
              _SessionListCard(data: data, folder: folder),
              const SizedBox(height: 120), // padding for bottom buttons
            ],
          ),
        ),
        // Bottom action area
        _BottomActions(folder: folder, data: data),
      ],
    );
  }
}

// ── Position card ─────────────────────────────────────────────────────────────

class _PositionCard extends StatelessWidget {
  const _PositionCard({required this.data});

  final WeekDetailData data;

  @override
  Widget build(BuildContext context) {
    final label = data.planTitle ?? _folderLabel(data.folder);
    final dateRange =
        '${_shortDate(data.dateFrom)} – ${_shortDate(data.dateTo)}';

    return Container(
      margin: const EdgeInsets.all(StrideTokens.spaceLg),
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: const TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs18,
              fontWeight: FontWeight.w700,
              color: StrideTokens.fg,
              height: 1.2,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            dateRange,
            style: const TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs13,
              color: StrideTokens.muted,
            ),
          ),
        ],
      ),
    );
  }

  static String _folderLabel(String folder) {
    final match = RegExp(r'\(([^)]+)\)').firstMatch(folder);
    if (match != null) return match.group(1)!;
    return folder;
  }

  static String _shortDate(String iso) {
    final dt = DateTime.tryParse(iso);
    if (dt == null) return iso;
    return '${dt.month}月${dt.day}日';
  }
}

// ── Week stat row ─────────────────────────────────────────────────────────────

class _WeekStatRow extends StatelessWidget {
  const _WeekStatRow({required this.data});

  final WeekDetailData data;

  @override
  Widget build(BuildContext context) {
    final distKm = data.totalDistanceM > 0
        ? (data.totalDistanceM / 1000).toStringAsFixed(1)
        : '—';
    final durStr = data.totalDurationS > 0
        ? _fmtDuration(data.totalDurationS.toInt())
        : '—';
    final strengthStr = data.strengthCount > 0
        ? '${data.strengthCount}次'
        : '—';

    return Container(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: StrideStatRow(
        items: [
          StatItem(label: '周里程', value: distKm, unit: 'km'),
          StatItem(label: '总时长', value: durStr),
          StatItem(label: '力量', value: strengthStr),
        ],
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

// ── Session list card ─────────────────────────────────────────────────────────

class _SessionListCard extends StatelessWidget {
  const _SessionListCard({required this.data, required this.folder});

  final WeekDetailData data;
  final String folder;

  @override
  Widget build(BuildContext context) {
    if (data.days.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: StrideTokens.spaceLg),
        child: Container(
          padding: const EdgeInsets.all(StrideTokens.spaceLg),
          decoration: BoxDecoration(
            color: StrideTokens.surface,
            borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
            border: Border.all(color: StrideTokens.border2),
          ),
          child: const Text(
            '暂无课时数据',
            style: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs14,
              color: StrideTokens.muted,
            ),
          ),
        ),
      );
    }

    // Build a flat list of rows: one per session (or rest row if no sessions).
    final rows = <({String date, PlannedSession? session, int sessionIndex})>[];

    // Gather all dates in the week (Mon → Sun).
    final from = DateTime.tryParse(data.dateFrom);
    final to = DateTime.tryParse(data.dateTo);
    if (from != null && to != null) {
      for (var d = from;
          !d.isAfter(to);
          d = d.add(const Duration(days: 1))) {
        final isoDate =
            '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
        final planDay = data.days.where((pd) => pd.date == isoDate).firstOrNull;
        if (planDay == null || planDay.sessions.isEmpty) {
          rows.add((date: isoDate, session: null, sessionIndex: 0));
        } else {
          for (var idx = 0; idx < planDay.sessions.length; idx++) {
            rows.add((
              date: isoDate,
              session: planDay.sessions[idx],
              sessionIndex: idx,
            ));
          }
        }
      }
    } else {
      // Fallback: just use the days returned by the API.
      for (final day in data.days) {
        if (day.sessions.isEmpty) {
          rows.add((date: day.date, session: null, sessionIndex: 0));
        } else {
          for (var idx = 0; idx < day.sessions.length; idx++) {
            rows.add((
              date: day.date,
              session: day.sessions[idx],
              sessionIndex: idx,
            ));
          }
        }
      }
    }

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: StrideTokens.spaceLg),
      child: Container(
        decoration: BoxDecoration(
          color: StrideTokens.surface,
          borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
          border: Border.all(color: StrideTokens.border2),
        ),
        child: Column(
          children: [
            for (int i = 0; i < rows.length; i++) ...[
              if (i > 0)
                const Divider(
                  height: 1,
                  indent: StrideTokens.spaceLg,
                  endIndent: StrideTokens.spaceLg,
                  color: StrideTokens.border2,
                ),
              _buildRow(context, rows[i]),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildRow(
    BuildContext context,
    ({String date, PlannedSession? session, int sessionIndex}) row,
  ) {
    if (row.session == null) {
      return RestDayRow(date: row.date);
    }
    return SessionRow(
      date: row.date,
      session: row.session!,
      onTap: () => context.push(
        RoutesV2.sessionDetail(folder, row.date, row.sessionIndex),
      ),
    );
  }
}

// ── Bottom action area ────────────────────────────────────────────────────────

class _BottomActions extends ConsumerWidget {
  const _BottomActions({required this.folder, required this.data});

  final String folder;
  final WeekDetailData data;

  Future<void> _onPushWeek(BuildContext context, WidgetRef ref) async {
    // 1. Confirm dialog
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text(
          '推送整周计划',
          style: TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs18,
            fontWeight: FontWeight.w700,
            color: StrideTokens.fg,
          ),
        ),
        content: const Text(
          '将本周所有课时推送到手表，确认？',
          style: TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs14,
            color: StrideTokens.fgSoft,
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            style: FilledButton.styleFrom(
              backgroundColor: StrideTokens.accent,
            ),
            child: const Text('确认推送'),
          ),
        ],
      ),
    );

    if (confirmed != true || !context.mounted) return;

    // 2. Start push (state transitions to loading)
    ref.read(pushWeekProvider.notifier).pushWeek(
          folder: folder,
          days: data.days,
        );

    // 3. Show result sheet (stays open through loading → done transition)
    if (context.mounted) {
      await showPushResultSheet(context);
      // Reset state after sheet is dismissed so next open starts fresh
      ref.read(pushWeekProvider.notifier).reset();
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Container(
      padding: const EdgeInsets.fromLTRB(
        StrideTokens.spaceLg,
        StrideTokens.spaceMd,
        StrideTokens.spaceLg,
        StrideTokens.space2xl,
      ),
      decoration: const BoxDecoration(
        color: StrideTokens.surface,
        border: Border(top: BorderSide(color: StrideTokens.border2)),
      ),
      child: Row(
        children: [
          // 调整计划 — outline button
          Expanded(
            child: OutlinedButton(
              onPressed: () => context.push(RoutesV2.planChat(folder)),
              style: OutlinedButton.styleFrom(
                minimumSize: const Size.fromHeight(48),
                foregroundColor: StrideTokens.fg,
                side: const BorderSide(color: StrideTokens.border),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
                ),
                textStyle: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs14,
                  fontWeight: FontWeight.w500,
                ),
              ),
              child: const Text('调整计划'),
            ),
          ),
          const SizedBox(width: StrideTokens.spaceMd),
          // 推送到手表 — primary filled button
          Expanded(
            child: FilledButton(
              onPressed: () => _onPushWeek(context, ref),
              style: FilledButton.styleFrom(
                backgroundColor: StrideTokens.accent,
                foregroundColor: StrideTokens.surface,
                minimumSize: const Size.fromHeight(48),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
                ),
                textStyle: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs14,
                  fontWeight: FontWeight.w600,
                ),
              ),
              child: const Text('推送到手表'),
            ),
          ),
        ],
      ),
    );
  }
}
