import 'package:json_annotation/json_annotation.dart';

part 'profile.g.dart';

@JsonSerializable()
class OnboardingState {
  const OnboardingState({
    required this.watchReady,
    required this.profileReady,
    this.completedAt,
  });

  factory OnboardingState.fromJson(Map<String, dynamic> json) =>
      _$OnboardingStateFromJson(json);

  @JsonKey(name: 'watch_ready')
  final bool watchReady;
  @JsonKey(name: 'profile_ready')
  final bool profileReady;
  @JsonKey(name: 'completed_at')
  final String? completedAt;

  Map<String, dynamic> toJson() => _$OnboardingStateToJson(this);
}

/// 部署侧特性开关（GET /api/users/me/profile 的 `features`，只取用到的）。
/// 字段缺失按"关"处理：宁可不动 24 分钟的 pipeline，也不在开关未知时乱触发。
@JsonSerializable()
class FeatureFlags {
  const FeatureFlags({this.syncDataAtOnboarding = false});

  factory FeatureFlags.fromJson(Map<String, dynamic> json) =>
      _$FeatureFlagsFromJson(json);

  @JsonKey(name: 'sync_data_at_onboarding')
  final bool syncDataAtOnboarding;

  Map<String, dynamic> toJson() => _$FeatureFlagsToJson(this);
}

@JsonSerializable()
class MyProfile {
  const MyProfile({
    required this.id,
    required this.displayName,
    required this.onboarding,
    this.profile,
    this.provider,
    this.features,
  });

  factory MyProfile.fromJson(Map<String, dynamic> json) =>
      _$MyProfileFromJson(json);

  final String id;
  @JsonKey(name: 'display_name')
  final String displayName;
  final Map<String, dynamic>? profile;
  final OnboardingState onboarding;
  final String? provider;

  /// 部署开关；旧响应可能缺失，用 [syncDataAtOnboarding] 安全读取。
  final FeatureFlags? features;

  bool get syncDataAtOnboarding => features?.syncDataAtOnboarding ?? false;

  Map<String, dynamic> toJson() => _$MyProfileToJson(this);
}
