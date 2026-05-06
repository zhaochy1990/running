import 'package:json_annotation/json_annotation.dart';

import 'activity.dart';

part 'team.g.dart';

@JsonSerializable()
class Team {
  const Team({
    required this.id,
    required this.name,
    required this.ownerUserId,
    required this.isOpen,
    this.description,
    this.memberCount,
    this.createdAt,
  });

  factory Team.fromJson(Map<String, dynamic> json) => _$TeamFromJson(json);

  final String id;
  final String name;
  final String? description;
  @JsonKey(name: 'owner_user_id')
  final String ownerUserId;
  @JsonKey(name: 'is_open')
  final bool isOpen;
  @JsonKey(name: 'member_count')
  final int? memberCount;
  @JsonKey(name: 'created_at')
  final String? createdAt;

  Map<String, dynamic> toJson() => _$TeamToJson(this);
}

@JsonSerializable()
class MyTeam {
  const MyTeam({required this.id, required this.name, required this.role, this.joinedAt});

  factory MyTeam.fromJson(Map<String, dynamic> json) => _$MyTeamFromJson(json);

  final String id;
  final String name;
  final String role;
  @JsonKey(name: 'joined_at')
  final String? joinedAt;

  Map<String, dynamic> toJson() => _$MyTeamToJson(this);
}

@JsonSerializable()
class MyTeamsResponse {
  const MyTeamsResponse({required this.teams});

  factory MyTeamsResponse.fromJson(Map<String, dynamic> json) =>
      _$MyTeamsResponseFromJson(json);

  final List<MyTeam> teams;

  Map<String, dynamic> toJson() => _$MyTeamsResponseToJson(this);
}

@JsonSerializable()
class TeamMember {
  const TeamMember({
    required this.userId,
    required this.role,
    this.name,
    this.displayName,
    this.email,
    this.joinedAt,
  });

  factory TeamMember.fromJson(Map<String, dynamic> json) =>
      _$TeamMemberFromJson(json);

  @JsonKey(name: 'user_id')
  final String userId;
  final String? name;
  @JsonKey(name: 'display_name')
  final String? displayName;
  final String? email;
  final String role;
  @JsonKey(name: 'joined_at')
  final String? joinedAt;

  Map<String, dynamic> toJson() => _$TeamMemberToJson(this);
}

@JsonSerializable()
class TeamFeedActivity {
  const TeamFeedActivity({
    required this.activity,
    required this.userId,
    required this.displayName,
    this.likeCount,
    this.youLiked,
    this.topLikers,
  });

  /// Backend flattens activity fields + user fields into one object; we
  /// rebuild the nested Activity from the same map.
  factory TeamFeedActivity.fromJson(Map<String, dynamic> json) {
    return TeamFeedActivity(
      activity: Activity.fromJson(json),
      userId: json['user_id'] as String,
      displayName: json['display_name'] as String,
      likeCount: (json['like_count'] as num?)?.toInt(),
      youLiked: json['you_liked'] as bool?,
      topLikers: (json['top_likers'] as List?)?.cast<String>(),
    );
  }

  final Activity activity;
  final String userId;
  final String displayName;
  final int? likeCount;
  final bool? youLiked;
  final List<String>? topLikers;
}

@JsonSerializable()
class TeamFeed {
  const TeamFeed({
    required this.teamId,
    required this.memberCount,
    required this.activities,
  });

  factory TeamFeed.fromJson(Map<String, dynamic> json) {
    return TeamFeed(
      teamId: json['team_id'] as String,
      memberCount: (json['member_count'] as num).toInt(),
      activities: (json['activities'] as List)
          .cast<Map<String, dynamic>>()
          .map(TeamFeedActivity.fromJson)
          .toList(),
    );
  }

  @JsonKey(name: 'team_id')
  final String teamId;
  @JsonKey(name: 'member_count')
  final int memberCount;
  final List<TeamFeedActivity> activities;
}

@JsonSerializable()
class MileageRankingEntry {
  const MileageRankingEntry({
    required this.userId,
    required this.displayName,
    required this.totalKm,
    required this.activityCount,
  });

  factory MileageRankingEntry.fromJson(Map<String, dynamic> json) =>
      _$MileageRankingEntryFromJson(json);

  @JsonKey(name: 'user_id')
  final String userId;
  @JsonKey(name: 'display_name')
  final String displayName;
  @JsonKey(name: 'total_km')
  final num totalKm;
  @JsonKey(name: 'activity_count')
  final int activityCount;

  Map<String, dynamic> toJson() => _$MileageRankingEntryToJson(this);
}

@JsonSerializable()
class MileageLeaderboard {
  const MileageLeaderboard({
    required this.teamId,
    required this.period,
    required this.periodStart,
    required this.periodEnd,
    required this.rankings,
  });

  factory MileageLeaderboard.fromJson(Map<String, dynamic> json) =>
      _$MileageLeaderboardFromJson(json);

  @JsonKey(name: 'team_id')
  final String teamId;
  final String period;
  @JsonKey(name: 'period_start')
  final String periodStart;
  @JsonKey(name: 'period_end')
  final String periodEnd;
  final List<MileageRankingEntry> rankings;

  Map<String, dynamic> toJson() => _$MileageLeaderboardToJson(this);
}

@JsonSerializable()
class TeamsListResponse {
  const TeamsListResponse({required this.teams});

  factory TeamsListResponse.fromJson(Map<String, dynamic> json) =>
      _$TeamsListResponseFromJson(json);

  final List<Team> teams;

  Map<String, dynamic> toJson() => _$TeamsListResponseToJson(this);
}
