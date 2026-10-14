/// Coach structured-artifact card registry — port of the miniprogram's
/// `utils/coachCards.ts` (race-strategy only).
///
/// The backend attaches `done.card = {$type, data}` envelopes; this registry
/// translates an envelope into the notification-card view shown in the chat
/// bubble. Unknown `$type` / shape mismatch → null (degrade to markdown).
/// App note: master-plan/weekly-plan cards degrade to markdown until those
/// domains land (PR-8/#466+); extend the registry here when they do.
///
/// History self-heal: before the backend's defensive parsing shipped, a weak
/// model once wrote the envelope JSON itself into the conversation history;
/// [parseLeakedRaceStrategyEnvelope] recovers such texts back into card
/// envelopes. [looksLikeJsonText] swaps in a neutral placeholder while a
/// leaked envelope is still streaming in.
library;

import 'dart:convert';

/// done.card wire shape (`$type` = renderer key).
class CoachCardWire {
  const CoachCardWire({required this.type, required this.data});

  factory CoachCardWire.fromJson(Map<String, dynamic> json) => CoachCardWire(
        type: json[r'$type'] as String? ?? '',
        data: json['data'],
      );

  final String type;
  final Object? data;
}

/// Notification-card view (all display props decided here; widgets only render).
class CoachCardView {
  const CoachCardView({
    required this.type,
    required this.title,
    required this.subtitle,
    required this.badge,
    required this.buttonText,
    required this.data,
  });

  final String type; // e.g. 'race-strategy'
  final String title;
  final String subtitle;
  final String badge; // empty → not shown
  final String buttonText; // empty → no CTA
  final Object? data; // artifact handed to the target page
}

/// Draft handoff payload for the strategy report page (one-shot read).
class PendingStrategyDraft {
  const PendingStrategyDraft({required this.raceId, required this.strategy});

  final int raceId;
  final Map<String, dynamic> strategy;
}

/// done.card → card view; null when unknown/shape-mismatched (markdown fallback).
CoachCardView? buildCoachCard(Object? card) {
  if (card is! Map<String, dynamic>) return null;
  final wire = CoachCardWire.fromJson(card);
  if (wire.type.isEmpty) return null;
  if (wire.type == 'race-strategy') {
    final data = wire.data;
    if (data is! Map<String, dynamic> || !_isRaceStrategyLike(data)) return null;
    final segments = data['pace_segments'] as List<Object?>;
    return CoachCardView(
      type: wire.type,
      title: '比赛策略已生成',
      subtitle:
          '${data['race_name']} · 目标 ${data['target_finish_time']}，含 ${segments.length} 段配速与补给计划',
      badge: '初稿',
      // 「查看并应用」会让用户以为点击即应用——实际是进报告页查看，应用在报告页内确认
      buttonText: '查看详情',
      data: data,
    );
  }
  return null;
}

/// Duck-typed RaceStrategy shape check (numeric ranges are the backend's zod
/// job; history rows are shown as-is).
bool _isRaceStrategyLike(Map<String, dynamic> v) {
  final raceName = v['race_name'];
  final itemType = v['item_type'];
  final target = v['target_finish_time'];
  return raceName is String &&
      raceName.isNotEmpty &&
      itemType is String &&
      itemType.isNotEmpty &&
      target is String &&
      v['pace_segments'] is List &&
      (v['pace_segments'] as List<Object?>).isNotEmpty;
}

/// History self-heal: recover a leaked **race-strategy** envelope from
/// assistant text (bare `{` or a whole ```json fence). Same shape rules as
/// the backend's parser — shape check only, no numeric re-validation.
CoachCardWire? parseLeakedRaceStrategyEnvelope(String content) {
  var text = content.trim();
  final fence = RegExp(r'^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$').firstMatch(text);
  text = (fence?.group(1) ?? text).trim();
  if (!text.startsWith('{')) return null;
  try {
    final parsed = jsonDecode(text);
    if (parsed is Map<String, dynamic>) {
      // Tool-direct wrapper shape: {disposition: return_direct, content: {...}}.
      final content = parsed['content'];
      if (parsed['disposition'] == 'return_direct' && content != null) {
        return CoachCardWire(type: 'race-strategy', data: content);
      }
      return CoachCardWire(type: 'race-strategy', data: parsed);
    }
  } catch (_) {
    // Not a whole JSON text — treat as normal markdown.
  }
  return null;
}

/// Whether the streaming body text looks like a leaked JSON envelope
/// (presentation placeholder only; done/card + history self-heal take over).
bool looksLikeJsonText(String text) {
  final trimmed = text.trimLeft();
  if (trimmed.startsWith('{')) return true;
  if (trimmed.startsWith('Returning structured response:')) return true;
  return trimmed.substring(0, trimmed.length.clamp(0, 120)).contains('"disposition"');
}
