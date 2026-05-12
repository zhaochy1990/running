/// FeedbackNotifier — manages D7 form state and submit flow.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../models/activity_feedback.dart';

// ── Form state ────────────────────────────────────────────────────────────────

class FeedbackFormState {
  const FeedbackFormState({
    this.rpe = 0,
    this.moodTags = const [],
    this.note = '',
    this.submitting = false,
    this.error,
    this.submitted = false,
  });

  final int rpe;
  final List<String> moodTags;
  final String note;
  final bool submitting;
  final String? error;
  final bool submitted;

  bool get canSubmit => rpe >= 1 && rpe <= 10 && !submitting;

  FeedbackFormState copyWith({
    int? rpe,
    List<String>? moodTags,
    String? note,
    bool? submitting,
    String? error,
    bool? submitted,
  }) =>
      FeedbackFormState(
        rpe: rpe ?? this.rpe,
        moodTags: moodTags ?? this.moodTags,
        note: note ?? this.note,
        submitting: submitting ?? this.submitting,
        error: error,              // explicit null clears error
        submitted: submitted ?? this.submitted,
      );
}

// ── Notifier ──────────────────────────────────────────────────────────────────

class FeedbackNotifier extends StateNotifier<FeedbackFormState> {
  FeedbackNotifier({
    required this.labelId,
    required this.api,
    required this.userId,
  }) : super(const FeedbackFormState());

  final String labelId;
  final StrideApi api;
  final String userId;

  static const int maxTags = 5;

  void setRpe(int value) {
    if (value < 1 || value > 10) return;
    state = state.copyWith(rpe: value, error: null);
  }

  void toggleTag(String tag) {
    final current = List<String>.from(state.moodTags);
    if (current.contains(tag)) {
      current.remove(tag);
      state = state.copyWith(moodTags: current, error: null);
    } else {
      if (current.length >= maxTags) {
        state = state.copyWith(error: '最多选 $maxTags 个');
        return;
      }
      current.add(tag);
      state = state.copyWith(moodTags: current, error: null);
    }
  }

  void setNote(String value) {
    state = state.copyWith(note: value, error: null);
  }

  Future<void> submit() async {
    if (!state.canSubmit) return;
    state = state.copyWith(submitting: true, error: null);
    try {
      await api.putActivityFeedback(
        userId: userId,
        labelId: labelId,
        rpe: state.rpe,
        moodTags: state.moodTags,
        note: state.note.trim().isEmpty ? null : state.note.trim(),
      );
      state = state.copyWith(submitting: false, submitted: true);
    } catch (e) {
      state = state.copyWith(
        submitting: false,
        error: '提交失败：${e.toString()}',
      );
    }
  }
}

// ── Provider family ───────────────────────────────────────────────────────────

/// Family parameter is the `labelId`.
final feedbackNotifierProvider = StateNotifierProvider.autoDispose
    .family<FeedbackNotifier, FeedbackFormState, String>((ref, labelId) {
  final api = ref.watch(strideApiProvider);
  final userId = ref.watch(currentUserIdProvider) ?? '';
  return FeedbackNotifier(labelId: labelId, api: api, userId: userId);
});

/// Read-only GET — loads existing feedback for a label (used by D8 CTA check).
final activityFeedbackProvider =
    FutureProvider.autoDispose.family<ActivityFeedback, String>((ref, labelId) async {
  final api = ref.watch(strideApiProvider);
  final userId = ref.watch(currentUserIdProvider);
  if (userId == null) throw Exception('用户未登录');
  return api.getActivityFeedback(userId, labelId);
});
