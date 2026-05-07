import 'package:json_annotation/json_annotation.dart';

part 'notifications.g.dart';

@JsonSerializable()
class NotificationPrefs {
  const NotificationPrefs({
    required this.likesEnabled,
    required this.planReminderEnabled,
    required this.planReminderTime,
    this.updatedAt,
  });

  factory NotificationPrefs.fromJson(Map<String, dynamic> json) =>
      _$NotificationPrefsFromJson(json);

  @JsonKey(name: 'likes_enabled')
  final bool likesEnabled;
  @JsonKey(name: 'plan_reminder_enabled')
  final bool planReminderEnabled;
  @JsonKey(name: 'plan_reminder_time')
  final String planReminderTime;
  @JsonKey(name: 'updated_at')
  final String? updatedAt;

  Map<String, dynamic> toJson() => _$NotificationPrefsToJson(this);
}
