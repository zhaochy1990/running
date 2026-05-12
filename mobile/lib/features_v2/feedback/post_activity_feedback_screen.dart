/// D7 — Post-Activity Feedback Screen
///
/// Full-screen (no shell). Entry points:
///   1. D8 ActivityDetailScreen "填写训练反馈" CTA → context.push(feedbackPattern, extra: activityName)
///   2. JPush notification click (type: post_activity) — future M2.2
///
/// Submits PUT /api/{user}/activities/{labelId}/feedback.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/app_typography.dart';
import '../../core/theme/pill_colors.dart';
import '../../core/theme/tokens.dart';
import '../_shared/widgets/pill.dart';
import '../_shared/widgets/top_bar.dart';
import 'providers/feedback_provider.dart';

// ── RPE descriptor text ───────────────────────────────────────────────────────

const _rpeLabels = [
  '',          // 0 — unused sentinel
  '极轻松',    // 1
  '轻松',      // 2
  '舒适',      // 3
  '偏努力',    // 4
  '中等',      // 5
  '较难',      // 6
  '难',        // 7
  '很难',      // 8
  '极限',      // 9
  '全力',      // 10
];

const _moodTagPool = [
  '腿酸', '状态好', '天气热', '天气冷',
  '心情好', '心情差', '睡眠不足', '节奏好',
  '气喘吁吁', '完成度高',
];

// ── Screen ────────────────────────────────────────────────────────────────────

class PostActivityFeedbackScreen extends ConsumerWidget {
  const PostActivityFeedbackScreen({
    super.key,
    required this.labelId,
    this.activityName,
  });

  final String labelId;
  final String? activityName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final formState = ref.watch(feedbackNotifierProvider(labelId));
    final notifier = ref.read(feedbackNotifierProvider(labelId).notifier);

    // Auto-pop on successful submit.
    ref.listen(feedbackNotifierProvider(labelId), (prev, next) {
      if (next.submitted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('反馈已记录'),
            duration: Duration(seconds: 2),
          ),
        );
        Navigator.of(context).pop();
      }
      if (next.error != null && (prev?.error != next.error)) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(next.error!),
            backgroundColor: StrideTokens.danger,
            duration: const Duration(seconds: 3),
          ),
        );
      }
    });

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        leading: const BackButton(),
        title: '训练反馈',
      ),
      body: _FeedbackBody(
        labelId: labelId,
        activityName: activityName,
        formState: formState,
        notifier: notifier,
      ),
    );
  }
}

// ── Body ──────────────────────────────────────────────────────────────────────

class _FeedbackBody extends StatelessWidget {
  const _FeedbackBody({
    required this.labelId,
    required this.activityName,
    required this.formState,
    required this.notifier,
  });

  final String labelId;
  final String? activityName;
  final FeedbackFormState formState;
  final FeedbackNotifier notifier;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.symmetric(
        horizontal: StrideTokens.spaceLg,
        vertical: StrideTokens.spaceLg,
      ),
      children: [
        // ── Activity summary card ──────────────────────────────────────
        if (activityName != null) _ActivitySummaryCard(name: activityName!),
        if (activityName != null) const SizedBox(height: StrideTokens.spaceLg),

        // ── RPE section ───────────────────────────────────────────────
        _SectionLabel('运动强度 (RPE)'),
        const SizedBox(height: StrideTokens.spaceSm),
        _RpeSelector(
          value: formState.rpe,
          onChanged: notifier.setRpe,
        ),
        const SizedBox(height: StrideTokens.spaceLg),

        // ── Mood tags section ─────────────────────────────────────────
        _SectionLabel('今天感受'),
        const SizedBox(height: StrideTokens.spaceSm),
        _MoodTagsSelector(
          selected: formState.moodTags,
          onToggle: notifier.toggleTag,
        ),
        const SizedBox(height: StrideTokens.spaceLg),

        // ── Note section ───────────────────────────────────────────────
        _SectionLabel('备注（可选）'),
        const SizedBox(height: StrideTokens.spaceSm),
        _NoteField(
          value: formState.note,
          onChanged: notifier.setNote,
        ),
        const SizedBox(height: StrideTokens.space2xl),

        // ── Submit button ──────────────────────────────────────────────
        _SubmitButton(
          canSubmit: formState.canSubmit,
          submitting: formState.submitting,
          onSubmit: notifier.submit,
        ),
        const SizedBox(height: StrideTokens.space3xl),
      ],
    );
  }
}

// ── Activity summary card ─────────────────────────────────────────────────────

class _ActivitySummaryCard extends StatelessWidget {
  const _ActivitySummaryCard({required this.name});

  final String name;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Text(
        name,
        style: const TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: StrideTokens.fs15,
          fontWeight: FontWeight.w600,
          color: StrideTokens.fg,
        ),
      ),
    );
  }
}

// ── Section label ─────────────────────────────────────────────────────────────

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: const TextStyle(
        fontFamily: AppTypography.fontSans,
        fontSize: StrideTokens.fs13,
        fontWeight: FontWeight.w500,
        color: StrideTokens.muted,
      ),
    );
  }
}

// ── RPE selector ──────────────────────────────────────────────────────────────

class _RpeSelector extends StatelessWidget {
  const _RpeSelector({required this.value, required this.onChanged});

  final int value;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    final hasValue = value >= 1 && value <= 10;

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: StrideTokens.spaceLg,
        vertical: StrideTokens.spaceXl,
      ),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          // Large value display
          Text(
            hasValue ? '$value' : '—',
            style: TextStyle(
              fontFamily: AppTypography.fontMono,
              fontSize: StrideTokens.fsDisplay48,
              fontWeight: FontWeight.w700,
              color: hasValue ? StrideTokens.accent : StrideTokens.muted2,
              height: 1.0,
            ),
          ),
          const SizedBox(height: StrideTokens.spaceXs),
          Text(
            hasValue ? _rpeLabels[value] : '滑动选择强度',
            style: const TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs13,
              color: StrideTokens.muted,
            ),
          ),
          const SizedBox(height: StrideTokens.spaceMd),
          // Emoji endpoints + slider
          Row(
            children: [
              const Text('😊', style: TextStyle(fontSize: 20)),
              Expanded(
                child: Slider(
                  value: value.toDouble().clamp(1, 10),
                  min: 1,
                  max: 10,
                  divisions: 9,
                  activeColor: StrideTokens.accent,
                  inactiveColor: StrideTokens.border,
                  onChanged: (v) => onChanged(v.round()),
                ),
              ),
              const Text('🔥', style: TextStyle(fontSize: 20)),
            ],
          ),
        ],
      ),
    );
  }
}

// ── Mood tags selector ────────────────────────────────────────────────────────

class _MoodTagsSelector extends StatelessWidget {
  const _MoodTagsSelector({
    required this.selected,
    required this.onToggle,
  });

  final List<String> selected;
  final void Function(String) onToggle;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: StrideTokens.spaceSm,
      runSpacing: StrideTokens.spaceSm,
      children: _moodTagPool.map((tag) {
        final isSelected = selected.contains(tag);
        return GestureDetector(
          onTap: () => onToggle(tag),
          child: StridePill(
            text: tag,
            variant: isSelected ? PillVariant.green : PillVariant.muted,
          ),
        );
      }).toList(),
    );
  }
}

// ── Note field ────────────────────────────────────────────────────────────────

class _NoteField extends StatelessWidget {
  const _NoteField({required this.value, required this.onChanged});

  final String value;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return TextField(
      maxLength: 200,
      maxLines: 3,
      minLines: 2,
      onChanged: onChanged,
      style: const TextStyle(
        fontFamily: AppTypography.fontSans,
        fontSize: StrideTokens.fs14,
        color: StrideTokens.fg,
      ),
      decoration: InputDecoration(
        hintText: '今天感受如何？（可选）',
        hintStyle: const TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: StrideTokens.fs14,
          color: StrideTokens.muted2,
        ),
        fillColor: StrideTokens.surface,
        filled: true,
        contentPadding: const EdgeInsets.all(StrideTokens.spaceLg),
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
          borderSide: const BorderSide(color: StrideTokens.accent, width: 1.5),
        ),
        counterStyle: const TextStyle(
          fontSize: StrideTokens.fs11,
          color: StrideTokens.muted2,
        ),
      ),
    );
  }
}

// ── Submit button ─────────────────────────────────────────────────────────────

class _SubmitButton extends StatelessWidget {
  const _SubmitButton({
    required this.canSubmit,
    required this.submitting,
    required this.onSubmit,
  });

  final bool canSubmit;
  final bool submitting;
  final VoidCallback onSubmit;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      height: 48,
      child: ElevatedButton(
        onPressed: canSubmit ? onSubmit : null,
        style: ElevatedButton.styleFrom(
          backgroundColor: StrideTokens.accent,
          disabledBackgroundColor: StrideTokens.border,
          foregroundColor: Colors.white,
          disabledForegroundColor: StrideTokens.muted2,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
          ),
          elevation: 0,
        ),
        child: submitting
            ? const SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: Colors.white,
                ),
              )
            : const Text(
                '提交反馈',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs15,
                  fontWeight: FontWeight.w600,
                ),
              ),
      ),
    );
  }
}
