import 'package:json_annotation/json_annotation.dart';

part 'profile.g.dart';

@JsonSerializable()
class OnboardingState {
  const OnboardingState({
    required this.corosReady,
    required this.profileReady,
    this.completedAt,
  });

  factory OnboardingState.fromJson(Map<String, dynamic> json) =>
      _$OnboardingStateFromJson(json);

  @JsonKey(name: 'coros_ready')
  final bool corosReady;
  @JsonKey(name: 'profile_ready')
  final bool profileReady;
  @JsonKey(name: 'completed_at')
  final String? completedAt;

  Map<String, dynamic> toJson() => _$OnboardingStateToJson(this);
}

@JsonSerializable()
class MyProfile {
  const MyProfile({
    required this.id,
    required this.displayName,
    required this.onboarding,
    this.profile,
    this.provider,
  });

  factory MyProfile.fromJson(Map<String, dynamic> json) =>
      _$MyProfileFromJson(json);

  final String id;
  @JsonKey(name: 'display_name')
  final String displayName;
  final Map<String, dynamic>? profile;
  final OnboardingState onboarding;
  final String? provider;

  Map<String, dynamic> toJson() => _$MyProfileToJson(this);
}
