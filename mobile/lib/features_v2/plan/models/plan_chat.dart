/// Data models for D4 plan chat (T32).
library;

// ── ChatMessage ───────────────────────────────────────────────────────────────

class ChatMessage {

  factory ChatMessage.fromJson(Map<String, dynamic> json) => ChatMessage(
        role: json['role'] as String,
        content: json['content'] as String,
      );
  const ChatMessage({required this.role, required this.content});

  /// 'user' or 'assistant'
  final String role;
  final String content;

  Map<String, dynamic> toJson() => {'role': role, 'content': content};
}

// ── DiffOpView ────────────────────────────────────────────────────────────────

class DiffOpView {

  factory DiffOpView.fromJson(Map<String, dynamic> json) => DiffOpView(
        id: json['id'] as String,
        op: json['op'] as String,
        date: json['date'] as String? ?? '',
        sessionIndex: (json['session_index'] as num?)?.toInt() ?? 0,
        oldValue: json['old_value'] as Map<String, dynamic>?,
        newValue: json['new_value'] as Map<String, dynamic>?,
        specPatch: json['spec_patch'] as Map<String, dynamic>?,
        accepted: json['accepted'] as bool?,
      );
  const DiffOpView({
    required this.id,
    required this.op,
    required this.date,
    required this.sessionIndex,
    this.oldValue,
    this.newValue,
    this.specPatch,
    this.accepted,
  });

  final String id;

  /// e.g. 'replace_kind', 'move_session', 'replace_distance', etc.
  final String op;
  final String date;
  final int sessionIndex;
  final Map<String, dynamic>? oldValue;
  final Map<String, dynamic>? newValue;

  /// The actual change payload the backend applies. Carried through verbatim so
  /// the orchestrator's stateless apply (which re-validates the whole PlanDiff)
  /// receives a faithful round-trip.
  final Map<String, dynamic>? specPatch;

  /// null = pending, true = accepted, false = rejected
  final bool? accepted;

  Map<String, dynamic> toJson() => {
        'id': id,
        'op': op,
        'date': date,
        'session_index': sessionIndex,
        'old_value': oldValue,
        'new_value': newValue,
        'spec_patch': specPatch,
        'accepted': accepted,
      };

  DiffOpView copyWith({bool? accepted}) => DiffOpView(
        id: id,
        op: op,
        date: date,
        sessionIndex: sessionIndex,
        oldValue: oldValue,
        newValue: newValue,
        specPatch: specPatch,
        accepted: accepted ?? this.accepted,
      );
}

// ── PlanDiffView ──────────────────────────────────────────────────────────────

class PlanDiffView {

  factory PlanDiffView.fromJson(Map<String, dynamic> json) => PlanDiffView(
        diffId: json['diff_id'] as String,
        folder: json['folder'] as String,
        ops: (json['ops'] as List? ?? const [])
            .cast<Map<String, dynamic>>()
            .map(DiffOpView.fromJson)
            .toList(growable: false),
        aiExplanation: json['ai_explanation'] as String? ?? '',
        createdAt: json['created_at'] as String? ?? '',
      );
  const PlanDiffView({
    required this.diffId,
    required this.folder,
    required this.ops,
    required this.aiExplanation,
    required this.createdAt,
  });

  final String diffId;
  final String folder;
  final List<DiffOpView> ops;
  final String aiExplanation;
  final String createdAt;

  Map<String, dynamic> toJson() => {
        'diff_id': diffId,
        'folder': folder,
        'ops': ops.map((o) => o.toJson()).toList(),
        'ai_explanation': aiExplanation,
        'created_at': createdAt,
      };
}
