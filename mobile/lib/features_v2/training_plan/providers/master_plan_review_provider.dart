/// C5 — Master plan review chat provider.
///
/// Manages the review conversation, diff ops, and confirm flow.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/api/stride_api.dart';
import '../../plan/models/plan_chat.dart';

// ── State ─────────────────────────────────────────────────────────────────────

class MasterPlanDiffOp {
  const MasterPlanDiffOp({
    required this.id,
    required this.op,
    this.phaseName,
    this.milestoneName,
    this.oldValue,
    this.newValue,
  });

  final String id;

  /// e.g. 'extend_phase', 'reduce_intensity', 'add_milestone',
  /// 'remove_milestone', 'adjust_date', 'change_volume'
  final String op;
  final String? phaseName;
  final String? milestoneName;
  final Map<String, dynamic>? oldValue;
  final Map<String, dynamic>? newValue;

  factory MasterPlanDiffOp.fromJson(Map<String, dynamic> json) =>
      MasterPlanDiffOp(
        id: json['id'] as String,
        op: json['op'] as String,
        phaseName: json['phase_name'] as String?,
        milestoneName: json['milestone_name'] as String?,
        oldValue: json['old_value'] as Map<String, dynamic>?,
        newValue: json['new_value'] as Map<String, dynamic>?,
      );
}

class MasterPlanDiff {
  const MasterPlanDiff({
    required this.diffId,
    required this.ops,
    this.aiExplanation = '',
  });

  final String diffId;
  final List<MasterPlanDiffOp> ops;
  final String aiExplanation;

  factory MasterPlanDiff.fromJson(Map<String, dynamic> json) => MasterPlanDiff(
        diffId: json['diff_id'] as String? ?? '',
        ops: (json['ops'] as List? ?? const [])
            .cast<Map<String, dynamic>>()
            .map(MasterPlanDiffOp.fromJson)
            .toList(growable: false),
        aiExplanation: json['ai_explanation'] as String? ?? '',
      );
}

class MasterPlanSummary {
  const MasterPlanSummary({
    required this.planId,
    this.startDate,
    this.endDate,
    this.totalWeeks,
    this.phaseCount,
    this.milestoneCount,
    this.status,
  });

  final String planId;
  final String? startDate;
  final String? endDate;
  final int? totalWeeks;
  final int? phaseCount;
  final int? milestoneCount;
  final String? status;

  factory MasterPlanSummary.fromJson(Map<String, dynamic> json) =>
      MasterPlanSummary(
        planId: json['plan_id'] as String? ?? json['id'] as String? ?? '',
        startDate: json['start_date'] as String?,
        endDate: json['end_date'] as String?,
        totalWeeks: (json['total_weeks'] as num?)?.toInt(),
        phaseCount: (json['phase_count'] as num?)?.toInt(),
        milestoneCount: (json['milestone_count'] as num?)?.toInt(),
        status: json['status'] as String?,
      );
}

class MasterPlanReviewState {
  const MasterPlanReviewState({
    this.summary,
    this.messages = const [],
    this.pendingDiff,
    this.acceptedOpIds = const {},
    this.loading = false,
    this.summaryLoading = false,
    this.error,
    this.confirmed = false,
  });

  final MasterPlanSummary? summary;
  final List<ChatMessage> messages;
  final MasterPlanDiff? pendingDiff;
  final Set<String> acceptedOpIds;
  final bool loading;
  final bool summaryLoading;
  final String? error;
  final bool confirmed;

  bool get hasPendingAccepted => acceptedOpIds.isNotEmpty;

  MasterPlanReviewState copyWith({
    MasterPlanSummary? Function()? summary,
    List<ChatMessage>? messages,
    MasterPlanDiff? Function()? pendingDiff,
    Set<String>? acceptedOpIds,
    bool? loading,
    bool? summaryLoading,
    String? Function()? error,
    bool? confirmed,
  }) =>
      MasterPlanReviewState(
        summary: summary != null ? summary() : this.summary,
        messages: messages ?? this.messages,
        pendingDiff: pendingDiff != null ? pendingDiff() : this.pendingDiff,
        acceptedOpIds: acceptedOpIds ?? this.acceptedOpIds,
        loading: loading ?? this.loading,
        summaryLoading: summaryLoading ?? this.summaryLoading,
        error: error != null ? error() : this.error,
        confirmed: confirmed ?? this.confirmed,
      );
}

// ── Notifier ──────────────────────────────────────────────────────────────────

class MasterPlanReviewNotifier extends StateNotifier<MasterPlanReviewState> {
  MasterPlanReviewNotifier(this._api, this._planId)
      : super(const MasterPlanReviewState()) {
    _loadSummary();
  }

  final StrideApi? _api;
  final String _planId;

  Future<void> _loadSummary() async {
    state = state.copyWith(summaryLoading: true);
    try {
      final json = await _api!.getMasterPlan(_planId);
      state = state.copyWith(
        summaryLoading: false,
        summary: () => MasterPlanSummary.fromJson(json),
      );
    } catch (e) {
      state = state.copyWith(
        summaryLoading: false,
        error: () => e.toString(),
      );
    }
  }

  Future<void> sendMessage(String text) async {
    if (text.trim().isEmpty) return;
    final userMsg = ChatMessage(role: 'user', content: text);
    state = state.copyWith(
      messages: [...state.messages, userMsg],
      loading: true,
      error: () => null,
      pendingDiff: () => null,
      acceptedOpIds: const {},
    );

    try {
      final history = state.messages
          .where((m) => m.role == 'user' || m.role == 'assistant')
          .take(state.messages.length - 1)
          .map((m) => m.toJson())
          .toList();

      final resp = await _api!.sendMasterPlanReviewMessage(
        planId: _planId,
        message: text,
        history: history,
      );

      final aiText = resp['ai_response'] as String? ?? '';
      final aiMsg = ChatMessage(role: 'assistant', content: aiText);

      MasterPlanDiff? diff;
      final rawDiff = resp['diff'];
      if (rawDiff is Map<String, dynamic>) {
        diff = MasterPlanDiff.fromJson(rawDiff);
      }

      state = state.copyWith(
        messages: [...state.messages, aiMsg],
        pendingDiff: () => diff,
        acceptedOpIds: diff != null ? {} : state.acceptedOpIds,
        loading: false,
      );
    } catch (e) {
      state = state.copyWith(
        loading: false,
        error: () => e.toString(),
      );
    }
  }

  void toggleOp(String opId) {
    final current = Set<String>.from(state.acceptedOpIds);
    if (current.contains(opId)) {
      current.remove(opId);
    } else {
      current.add(opId);
    }
    state = state.copyWith(acceptedOpIds: current);
  }

  Future<void> applyDiff() async {
    final diff = state.pendingDiff;
    if (diff == null || state.acceptedOpIds.isEmpty) return;

    state = state.copyWith(loading: true, error: () => null);
    try {
      await _api!.applyMasterPlanReviewDiff(
        planId: _planId,
        diffId: diff.diffId,
        acceptedOpIds: state.acceptedOpIds.toList(),
      );
      // Reload summary to reflect changes.
      state = state.copyWith(
        pendingDiff: () => null,
        acceptedOpIds: const {},
        loading: false,
      );
      await _loadSummary();
    } catch (e) {
      state = state.copyWith(
        loading: false,
        error: () => e.toString(),
      );
    }
  }

  Future<void> confirm() async {
    state = state.copyWith(loading: true, error: () => null);
    try {
      await _api!.confirmMasterPlan(_planId);
      state = state.copyWith(loading: false, confirmed: true);
    } catch (e) {
      state = state.copyWith(
        loading: false,
        error: () => e.toString(),
      );
    }
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

final masterPlanReviewProvider = StateNotifierProvider.family
    .autoDispose<MasterPlanReviewNotifier, MasterPlanReviewState, String>(
  (ref, planId) {
    final api = ref.watch(strideApiProvider);
    return MasterPlanReviewNotifier(api, planId);
  },
);
