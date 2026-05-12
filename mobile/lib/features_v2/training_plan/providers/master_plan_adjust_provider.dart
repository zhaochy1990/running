/// C7 — Master plan adjust chat provider.
///
/// Manages the adjust conversation, diff ops, and apply flow for ACTIVE plans.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/api/stride_api.dart';
import '../../plan/models/plan_chat.dart';
import 'master_plan_review_provider.dart'; // reuse MasterPlanDiff / MasterPlanDiffOp / MasterPlanSummary

// ── State ─────────────────────────────────────────────────────────────────────

class MasterPlanAdjustState {
  const MasterPlanAdjustState({
    this.summary,
    this.messages = const [],
    this.pendingDiff,
    this.acceptedOpIds = const {},
    this.loading = false,
    this.summaryLoading = false,
    this.error,
    this.appliedResult,
  });

  final MasterPlanSummary? summary;
  final List<ChatMessage> messages;
  final MasterPlanDiff? pendingDiff;
  final Set<String> acceptedOpIds;
  final bool loading;
  final bool summaryLoading;
  final String? error;

  /// Non-null after a successful apply; contains affected_weeks list.
  final AdjustApplyResult? appliedResult;

  bool get hasPendingAccepted => acceptedOpIds.isNotEmpty;

  MasterPlanAdjustState copyWith({
    MasterPlanSummary? Function()? summary,
    List<ChatMessage>? messages,
    MasterPlanDiff? Function()? pendingDiff,
    Set<String>? acceptedOpIds,
    bool? loading,
    bool? summaryLoading,
    String? Function()? error,
    AdjustApplyResult? Function()? appliedResult,
  }) =>
      MasterPlanAdjustState(
        summary: summary != null ? summary() : this.summary,
        messages: messages ?? this.messages,
        pendingDiff: pendingDiff != null ? pendingDiff() : this.pendingDiff,
        acceptedOpIds: acceptedOpIds ?? this.acceptedOpIds,
        loading: loading ?? this.loading,
        summaryLoading: summaryLoading ?? this.summaryLoading,
        error: error != null ? error() : this.error,
        appliedResult:
            appliedResult != null ? appliedResult() : this.appliedResult,
      );
}

class AdjustApplyResult {
  const AdjustApplyResult({
    required this.version,
    required this.applied,
    required this.affectedWeeks,
  });

  final int version;
  final int applied;
  final List<AffectedWeek> affectedWeeks;
}

class AffectedWeek {
  const AffectedWeek({required this.folder, required this.reason});

  final String folder;
  final String reason;

  factory AffectedWeek.fromJson(Map<String, dynamic> json) => AffectedWeek(
        folder: json['folder'] as String? ?? '',
        reason: json['reason'] as String? ?? '',
      );
}

// ── Notifier ──────────────────────────────────────────────────────────────────

class MasterPlanAdjustNotifier
    extends StateNotifier<MasterPlanAdjustState> {
  MasterPlanAdjustNotifier(this._api, this._planId)
      : super(const MasterPlanAdjustState()) {
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
      appliedResult: () => null,
    );

    try {
      final history = state.messages
          .where((m) => m.role == 'user' || m.role == 'assistant')
          .take(state.messages.length - 1)
          .map((m) => m.toJson())
          .toList();

      final resp = await _api!.sendMasterPlanAdjustMessage(
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

  Future<AdjustApplyResult?> applyDiff({String? changeReason}) async {
    final diff = state.pendingDiff;
    if (diff == null || state.acceptedOpIds.isEmpty) return null;

    state = state.copyWith(loading: true, error: () => null);
    try {
      final resp = await _api!.applyMasterPlanAdjustDiff(
        planId: _planId,
        diffId: diff.diffId,
        acceptedOpIds: state.acceptedOpIds.toList(),
        changeReason: changeReason,
      );

      final weeks = (resp['affected_weeks'] as List? ?? const [])
          .cast<Map<String, dynamic>>()
          .map(AffectedWeek.fromJson)
          .toList(growable: false);

      final result = AdjustApplyResult(
        version: (resp['version'] as num?)?.toInt() ?? 0,
        applied: (resp['applied'] as num?)?.toInt() ?? 0,
        affectedWeeks: weeks,
      );

      state = state.copyWith(
        pendingDiff: () => null,
        acceptedOpIds: const {},
        loading: false,
        appliedResult: () => result,
      );
      await _loadSummary();
      return result;
    } catch (e) {
      state = state.copyWith(
        loading: false,
        error: () => e.toString(),
      );
      return null;
    }
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

final masterPlanAdjustProvider = StateNotifierProvider.family
    .autoDispose<MasterPlanAdjustNotifier, MasterPlanAdjustState, String>(
  (ref, planId) {
    final api = ref.watch(strideApiProvider);
    return MasterPlanAdjustNotifier(api, planId);
  },
);
