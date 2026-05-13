/// ActivityFeedback — model for POST /api/{user}/activities/{id}/feedback.
library;

class ActivityFeedback {

  factory ActivityFeedback.fromJson(Map<String, dynamic> json) {
    final rawTags = json['mood_tags'];
    List<String>? tags;
    if (rawTags is List) {
      tags = rawTags.cast<String>();
    }
    return ActivityFeedback(
      labelId: json['label_id'] as String? ?? '',
      rpe: (json['rpe'] as num?)?.toInt(),
      moodTags: tags,
      note: json['note'] as String?,
      updatedAt: json['updated_at'] as String?,
    );
  }
  const ActivityFeedback({
    required this.labelId,
    this.rpe,
    this.moodTags,
    this.note,
    this.updatedAt,
  });

  final String labelId;
  final int? rpe;
  final List<String>? moodTags;
  final String? note;
  final String? updatedAt;

  Map<String, dynamic> toJson() => {
        'rpe': rpe,
        'mood_tags': moodTags ?? [],
        'note': note,
      };

  /// Returns true when the user has submitted feedback (rpe is present).
  bool get hasData => rpe != null;
}
