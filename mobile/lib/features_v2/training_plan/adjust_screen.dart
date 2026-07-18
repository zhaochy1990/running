/// C7 — Master plan adjust chat screen (fullscreen, no shell).
///
/// Allows the user to adjust an ACTIVE master plan via AI conversation.
/// After applying a diff, shows affected_weeks and offers to regenerate them.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/top_bar.dart';
import '../plan/models/plan_chat.dart';
import 'providers/master_plan_adjust_provider.dart';
import 'providers/master_plan_review_provider.dart'
    show MasterPlanDiff, MasterPlanDiffOp;
import 'widgets/master_plan_summary_card.dart';

// ── Quick suggestions ─────────────────────────────────────────────────────────

const _kAdjustSuggestions = [
  '比赛延期到 12 月 20 日',
  '降低强度一档',
  '增加一场测试赛',
  '我膝盖最近不舒服，下个月减量',
];

// ── Screen ────────────────────────────────────────────────────────────────────

class MasterPlanAdjustScreen extends ConsumerStatefulWidget {
  const MasterPlanAdjustScreen({super.key, required this.planId});

  final String planId;

  @override
  ConsumerState<MasterPlanAdjustScreen> createState() =>
      _MasterPlanAdjustScreenState();
}

class _MasterPlanAdjustScreenState
    extends ConsumerState<MasterPlanAdjustScreen> {
  final _inputController = TextEditingController();
  final _scrollController = ScrollController();

  @override
  void dispose() {
    _inputController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  void _send() {
    final text = _inputController.text.trim();
    if (text.isEmpty) return;
    _inputController.clear();
    ref
        .read(masterPlanAdjustProvider(widget.planId).notifier)
        .sendMessage(text);
    _scrollToBottom();
  }

  void _sendSuggestion(String s) {
    _inputController.text = s;
    _send();
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        _scrollController.animateTo(
          0,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
        );
      }
    });
  }

  Future<void> _applyDiff() async {
    final outcome = await ref
        .read(masterPlanAdjustProvider(widget.planId).notifier)
        .applyDiff();

    if (!mounted) return;

    switch (outcome.status) {
      case AdjustApplyStatus.ignoredInFlight:
        return;
      case AdjustApplyStatus.failed:
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('应用失败，请稍后重试')));
        return;
      case AdjustApplyStatus.applied:
        final result = outcome.result!;
        if (result.affectedWeeks.isNotEmpty) {
          _showAffectedWeeksDialog(result);
        } else {
          ScaffoldMessenger.of(
            context,
          ).showSnackBar(const SnackBar(content: Text('已应用调整')));
        }
    }
  }

  void _showAffectedWeeksDialog(AdjustApplyResult result) {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(
          '以下 ${result.affectedWeeks.length} 周的计划可能需重新生成',
          style: const TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs14,
            fontWeight: FontWeight.w600,
          ),
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final aw in result.affectedWeeks)
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Text(
                  '• ${aw.folder}',
                  style: const TextStyle(
                    fontFamily: AppTypography.fontMono,
                    fontSize: StrideTokens.fs12,
                    color: StrideTokens.fgSoft,
                  ),
                ),
              ),
            const SizedBox(height: StrideTokens.spaceSm),
            const Text(
              '注意：已推送到手表的训练将失效，请手动清理。',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs12,
                color: StrideTokens.warn,
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('稍后处理'),
          ),
          TextButton(
            onPressed: () {
              Navigator.of(ctx).pop();
              // TODO(T43): implement batch week regeneration
              ScaffoldMessenger.of(
                context,
              ).showSnackBar(const SnackBar(content: Text('周计划重生成功能即将上线')));
            },
            child: const Text(
              '全部重生成',
              style: TextStyle(color: StrideTokens.accent),
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(masterPlanAdjustProvider(widget.planId));

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        title: '调整训练总纲',
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => Navigator.of(context).pop(),
        ),
      ),
      body: Column(
        children: [
          // Summary card
          if (state.summaryLoading)
            const LinearProgressIndicator(
              color: StrideTokens.accent,
              backgroundColor: StrideTokens.border2,
            )
          else if (state.summary != null)
            MasterPlanSummaryCard(summary: state.summary!),

          // Message list
          Expanded(
            child: _MessageList(
              state: state,
              planId: widget.planId,
              scrollController: _scrollController,
            ),
          ),

          // Quick suggestion chips
          _SuggestionBar(onTap: _sendSuggestion),

          // Input bar
          _InputBar(
            controller: _inputController,
            loading: state.loading,
            onSend: _send,
          ),
        ],
      ),
      floatingActionButton: state.hasPendingAccepted
          ? FloatingActionButton.extended(
              onPressed: state.loading ? null : _applyDiff,
              backgroundColor: StrideTokens.accent,
              foregroundColor: StrideTokens.surface,
              label: Text(
                '应用 ${state.acceptedOpIds.length} 项调整',
                style: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontWeight: FontWeight.w600,
                ),
              ),
              icon: const Icon(Icons.check),
            )
          : null,
    );
  }
}

// ── Message list ──────────────────────────────────────────────────────────────

class _MessageList extends ConsumerWidget {
  const _MessageList({
    required this.state,
    required this.planId,
    required this.scrollController,
  });

  final MasterPlanAdjustState state;
  final String planId;
  final ScrollController scrollController;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final messages = state.messages;
    final diff = state.pendingDiff;

    // Build a unified list for the reversed ListView
    final items = <_ListItem>[];
    if (diff != null) {
      items.add(_DiffItem(diff: diff, planId: planId));
    }
    for (int i = messages.length - 1; i >= 0; i--) {
      items.add(_MessageItem(message: messages[i]));
    }

    if (messages.isEmpty && !state.loading) {
      return const Center(
        child: Text(
          '向 AI 教练发送消息\n调整当前训练总纲',
          textAlign: TextAlign.center,
          style: TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs14,
            color: StrideTokens.muted,
            height: 1.6,
          ),
        ),
      );
    }

    return ListView.builder(
      controller: scrollController,
      reverse: true,
      padding: const EdgeInsets.symmetric(
        horizontal: StrideTokens.spaceLg,
        vertical: StrideTokens.spaceMd,
      ),
      itemCount: items.length + (state.loading ? 1 : 0),
      itemBuilder: (context, index) {
        if (state.loading && index == 0) {
          return const _TypingIndicator();
        }
        final adjusted = state.loading ? index - 1 : index;
        final item = items[adjusted];
        if (item is _MessageItem) {
          return _BubbleWidget(message: item.message);
        } else if (item is _DiffItem) {
          return _AdjustDiffCard(diff: item.diff, planId: item.planId);
        }
        return const SizedBox.shrink();
      },
    );
  }
}

// ── List item types ───────────────────────────────────────────────────────────

abstract class _ListItem {}

class _MessageItem extends _ListItem {
  _MessageItem({required this.message});
  final ChatMessage message;
}

class _DiffItem extends _ListItem {
  _DiffItem({required this.diff, required this.planId});
  final MasterPlanDiff diff;
  final String planId;
}

// ── Adjust-specific diff card (uses adjust provider instead of review) ─────────

class _AdjustDiffCard extends ConsumerWidget {
  const _AdjustDiffCard({required this.diff, required this.planId});

  final MasterPlanDiff diff;
  final String planId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(masterPlanAdjustProvider(planId));
    final notifier = ref.read(masterPlanAdjustProvider(planId).notifier);

    if (diff.ops.isEmpty) return const SizedBox.shrink();

    return Container(
      margin: const EdgeInsets.only(bottom: StrideTokens.spaceMd),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(
              StrideTokens.spaceMd,
              StrideTokens.spaceMd,
              StrideTokens.spaceMd,
              StrideTokens.spaceSm,
            ),
            child: Text(
              '总纲调整建议 ${diff.ops.length} 项',
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs13,
                fontWeight: FontWeight.w600,
                color: StrideTokens.muted,
                letterSpacing: 0.3,
              ),
            ),
          ),
          const Divider(height: 1, color: StrideTokens.border2),
          for (final op in diff.ops) ...[
            _AdjustOpRow(
              op: op,
              accepted: state.acceptedOpIds.contains(op.id),
              enabled: op.accepted != false && !state.loading,
              onToggle: () => notifier.toggleOp(op.id),
            ),
            if (op != diff.ops.last)
              const Divider(
                height: 1,
                indent: StrideTokens.spaceMd,
                endIndent: StrideTokens.spaceMd,
                color: StrideTokens.border2,
              ),
          ],
        ],
      ),
    );
  }
}

class _AdjustOpRow extends StatelessWidget {
  const _AdjustOpRow({
    required this.op,
    required this.accepted,
    required this.enabled,
    required this.onToggle,
  });

  final MasterPlanDiffOp op;
  final bool accepted;
  final bool enabled;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) {
    final previewLines = _previewLines(op);
    return Opacity(
      opacity: enabled ? 1 : 0.55,
      child: InkWell(
        onTap: enabled ? onToggle : null,
        borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: StrideTokens.spaceMd,
            vertical: StrideTokens.spaceMd,
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                width: 24,
                height: 24,
                child: Checkbox(
                  key: Key('master-plan-adjust-op-${op.id}'),
                  value: accepted,
                  onChanged: enabled ? (_) => onToggle() : null,
                  activeColor: StrideTokens.accent,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(4),
                  ),
                  materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
              ),
              const SizedBox(width: StrideTokens.spaceSm),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _OpPill(op: op.op),
                    if (previewLines.isNotEmpty) ...[
                      const SizedBox(height: 4),
                      for (final line in previewLines)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 2),
                          child: Text(
                            line,
                            style: const TextStyle(
                              fontFamily: AppTypography.fontSans,
                              fontSize: StrideTokens.fs13,
                              color: StrideTokens.fg,
                            ),
                          ),
                        ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

List<String> _previewLines(MasterPlanDiffOp op) {
  final oldValue = op.oldValue ?? const <String, dynamic>{};
  final newValue = op.newValue ?? op.specPatch ?? const <String, dynamic>{};

  if (op.op == 'reschedule_target_race') {
    return [
      _arrowLine('比赛日', oldValue['race_date'], newValue['race_date']),
      _arrowLine('计划结束', oldValue['plan_end_date'], newValue['plan_end_date']),
      ..._phaseBoundaryLines(newValue['phase_updates']),
    ].whereType<String>().toList(growable: false);
  }

  if (op.op == 'update_target_race_time') {
    return [
      _arrowLine('目标成绩', oldValue['target_time'], newValue['target_time']),
      _arrowLine(
        '里程碑目标',
        oldValue['milestone_target'],
        newValue['milestone_target'],
      ),
    ].whereType<String>().toList(growable: false);
  }

  final oldSummary = oldValue['summary'] ?? oldValue['value'];
  final newSummary = newValue['summary'] ?? newValue['value'];
  final summaryLine = _arrowLine('调整', oldSummary, newSummary);
  if (summaryLine != null) return [summaryLine];

  final weeklyLine = _weeklyRangeLine(oldValue, newValue);
  if (weeklyLine != null) return [weeklyLine];

  if (newValue.isNotEmpty) {
    return [newValue.entries.map((e) => '${e.key}: ${e.value}').join(', ')];
  }
  return const [];
}

List<String> _phaseBoundaryLines(Object? rawUpdates) {
  if (rawUpdates is! List) return const [];
  final updates = rawUpdates.whereType<Map>().toList(growable: false);
  if (updates.isEmpty) return const [];

  final lines = <String>[];
  final preceding = updates.first;
  final precedingEnd = preceding['end_date'];
  if (precedingEnd != null) {
    lines.add('前序阶段结束：$precedingEnd');
  }

  if (updates.length > 1) {
    final taper = updates.last;
    final taperStart = taper['start_date'];
    final taperEnd = taper['end_date'];
    if (taperStart != null && taperEnd != null) {
      lines.add('调整期：$taperStart → $taperEnd');
    } else if (taperStart != null || taperEnd != null) {
      lines.add(
        '调整期：${taperStart ?? ''}${taperEnd == null ? '' : ' → $taperEnd'}',
      );
    }
  }
  return lines;
}

String? _arrowLine(String label, Object? oldValue, Object? newValue) {
  if (oldValue == null && newValue == null) return null;
  if (oldValue == null) return '$label ${newValue ?? ''}';
  if (newValue == null) return '$label $oldValue';
  return '$label $oldValue → $newValue';
}

String? _weeklyRangeLine(
  Map<String, dynamic> oldValue,
  Map<String, dynamic> newValue,
) {
  final oldLow = oldValue['weekly_distance_km_low'];
  final oldHigh = oldValue['weekly_distance_km_high'];
  final newLow = newValue['weekly_distance_km_low'];
  final newHigh = newValue['weekly_distance_km_high'];
  if (oldLow == null || oldHigh == null || newLow == null || newHigh == null) {
    return null;
  }
  return '周量 $oldLow–$oldHigh km → $newLow–$newHigh km';
}

class _OpPill extends StatelessWidget {
  const _OpPill({required this.op});

  final String op;

  static String _label(String op) => switch (op) {
    'resize_phase' => '调整阶段',
    'shift_phase_boundary' => '调整阶段边界',
    'replace_phase_focus' => '更新重点',
    'replace_weekly_range' => '调整周量',
    'add_phase' => '新增阶段',
    'remove_phase' => '删除阶段',
    'add_milestone' => '新增里程碑',
    'remove_milestone' => '删除里程碑',
    'replace_milestone_date' => '调整日期',
    'replace_milestone_target' => '调整目标',
    'reschedule_target_race' => '调整目标比赛',
    'update_target_race_time' => '调整目标成绩',
    _ => op,
  };

  static Color _color(String op) => switch (op) {
    'add_phase' || 'add_milestone' => StrideTokens.accent,
    'remove_phase' || 'remove_milestone' => StrideTokens.danger,
    'resize_phase' ||
    'shift_phase_boundary' ||
    'replace_weekly_range' => StrideTokens.warn,
    _ => StrideTokens.muted,
  };

  @override
  Widget build(BuildContext context) {
    final color = _color(op);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        _label(op),
        style: TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: StrideTokens.fs11,
          fontWeight: FontWeight.w600,
          color: color,
        ),
      ),
    );
  }
}

// ── Bubble ────────────────────────────────────────────────────────────────────

class _BubbleWidget extends StatelessWidget {
  const _BubbleWidget({required this.message});

  final ChatMessage message;

  bool get _isUser => message.role == 'user';

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: _isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.75,
        ),
        margin: const EdgeInsets.only(bottom: StrideTokens.spaceMd),
        padding: const EdgeInsets.symmetric(
          horizontal: StrideTokens.spaceMd,
          vertical: StrideTokens.spaceSm,
        ),
        decoration: BoxDecoration(
          color: _isUser ? StrideTokens.accent : StrideTokens.surface,
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(StrideTokens.radiusMd),
            topRight: const Radius.circular(StrideTokens.radiusMd),
            bottomLeft: _isUser
                ? const Radius.circular(StrideTokens.radiusMd)
                : const Radius.circular(2),
            bottomRight: _isUser
                ? const Radius.circular(2)
                : const Radius.circular(StrideTokens.radiusMd),
          ),
          border: _isUser ? null : Border.all(color: StrideTokens.border2),
        ),
        child: Text(
          message.content,
          style: TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs14,
            color: _isUser ? StrideTokens.surface : StrideTokens.fg,
            height: 1.5,
          ),
        ),
      ),
    );
  }
}

// ── Typing indicator ──────────────────────────────────────────────────────────

class _TypingIndicator extends StatelessWidget {
  const _TypingIndicator();

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: StrideTokens.spaceMd),
        padding: const EdgeInsets.symmetric(
          horizontal: StrideTokens.spaceMd,
          vertical: StrideTokens.spaceSm,
        ),
        decoration: BoxDecoration(
          color: StrideTokens.surface,
          borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
          border: Border.all(color: StrideTokens.border2),
        ),
        child: const SizedBox(
          width: 40,
          height: 20,
          child: Center(
            child: SizedBox(
              width: 20,
              height: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          ),
        ),
      ),
    );
  }
}

// ── Suggestion bar ────────────────────────────────────────────────────────────

class _SuggestionBar extends StatelessWidget {
  const _SuggestionBar({required this.onTap});

  final void Function(String) onTap;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: StrideTokens.border2)),
      ),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(
          horizontal: StrideTokens.spaceMd,
          vertical: StrideTokens.spaceSm,
        ),
        child: Row(
          children: _kAdjustSuggestions
              .map(
                (s) => Padding(
                  padding: const EdgeInsets.only(right: StrideTokens.spaceSm),
                  child: ActionChip(
                    label: Text(
                      s,
                      style: const TextStyle(
                        fontFamily: AppTypography.fontSans,
                        fontSize: StrideTokens.fs12,
                        color: StrideTokens.fg,
                      ),
                    ),
                    backgroundColor: StrideTokens.surface,
                    side: const BorderSide(color: StrideTokens.border),
                    padding: const EdgeInsets.symmetric(horizontal: 4),
                    onPressed: () => onTap(s),
                  ),
                ),
              )
              .toList(),
        ),
      ),
    );
  }
}

// ── Input bar ─────────────────────────────────────────────────────────────────

class _InputBar extends StatelessWidget {
  const _InputBar({
    required this.controller,
    required this.loading,
    required this.onSend,
  });

  final TextEditingController controller;
  final bool loading;
  final VoidCallback onSend;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.fromLTRB(
        StrideTokens.spaceMd,
        StrideTokens.spaceSm,
        StrideTokens.spaceSm,
        StrideTokens.spaceSm + MediaQuery.of(context).viewInsets.bottom,
      ),
      decoration: const BoxDecoration(
        color: StrideTokens.surface,
        border: Border(top: BorderSide(color: StrideTokens.border2)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            child: TextField(
              controller: controller,
              maxLines: 4,
              minLines: 1,
              textInputAction: TextInputAction.newline,
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs14,
                color: StrideTokens.fg,
              ),
              decoration: InputDecoration(
                hintText: '向 AI 教练发送消息…',
                hintStyle: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs14,
                  color: StrideTokens.muted,
                ),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
                  borderSide: const BorderSide(color: StrideTokens.border2),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
                  borderSide: const BorderSide(color: StrideTokens.border2),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
                  borderSide: const BorderSide(color: StrideTokens.accent),
                ),
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: StrideTokens.spaceMd,
                  vertical: StrideTokens.spaceSm,
                ),
                filled: true,
                fillColor: StrideTokens.bg,
              ),
            ),
          ),
          const SizedBox(width: StrideTokens.spaceSm),
          SizedBox(
            width: 44,
            height: 44,
            child: loading
                ? const Center(
                    child: SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  )
                : IconButton(
                    onPressed: onSend,
                    icon: const Icon(Icons.send_rounded),
                    color: StrideTokens.accent,
                    tooltip: '发送',
                  ),
          ),
        ],
      ),
    );
  }
}
