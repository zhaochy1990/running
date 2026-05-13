/// HomeData — mirrors `GET /api/{user}/home` response schema.
///
/// Per `.omc/plans/stride-mobile-m1.md` §3.1.1.
library;

class StatusRing { // COROS label e.g. Optimal

  factory StatusRing.fromJson(Map<String, dynamic> json) {
    return StatusRing(
      fatigue: (json['fatigue'] as num?)?.toInt() ?? 0,
      fatigueBand: (json['fatigue_band'] as String?) ?? 'normal',
      tsb: (json['tsb'] as num?)?.toDouble() ?? 0.0,
      tsbBand: (json['tsb_band'] as String?) ?? 'productive',
      loadRatio: (json['load_ratio'] as num?)?.toDouble() ?? 1.0,
      loadState: (json['load_state'] as String?) ?? '',
    );
  }
  const StatusRing({
    required this.fatigue,
    required this.fatigueBand,
    required this.tsb,
    required this.tsbBand,
    required this.loadRatio,
    required this.loadState,
  });

  final int fatigue;
  final String fatigueBand; // recovered|normal|fatigued|high
  final double tsb;
  final String tsbBand; // race_ready|transitional|productive|overload|detraining
  final double loadRatio;
  final String loadState;
}

class HomeActivity {

  factory HomeActivity.fromJson(Map<String, dynamic> json) {
    return HomeActivity(
      labelId: json['label_id'] as String,
      date: json['date'] as String,
      name: (json['name'] as String?) ?? '',
      sportType: (json['sport_type'] as String?) ?? 'running',
      distanceKm: (json['distance_km'] as num?)?.toDouble() ?? 0.0,
      durationSec: (json['duration_sec'] as num?)?.toInt() ?? 0,
      avgPaceSecPerKm: (json['avg_pace_sec_per_km'] as num?)?.toInt(),
      avgHr: (json['avg_hr'] as num?)?.toInt(),
      calories: (json['calories'] as num?)?.toInt(),
      commentaryExcerpt: json['commentary_excerpt'] as String?,
      commentaryGeneratedBy: json['commentary_generated_by'] as String?,
    );
  }
  const HomeActivity({
    required this.labelId,
    required this.date,
    required this.name,
    required this.sportType,
    required this.distanceKm,
    required this.durationSec,
    this.avgPaceSecPerKm,
    this.avgHr,
    this.calories,
    this.commentaryExcerpt,
    this.commentaryGeneratedBy,
  });

  final String labelId;
  final String date;
  final String name;
  final String sportType; // running|strength|cycling|other
  final double distanceKm;
  final int durationSec;
  final int? avgPaceSecPerKm;
  final int? avgHr;
  final int? calories;
  final String? commentaryExcerpt; // <= 60 chars
  final String? commentaryGeneratedBy;
}

class WeeklyStats {

  factory WeeklyStats.fromJson(Map<String, dynamic> json) {
    return WeeklyStats(
      weekStart: (json['week_start'] as String?) ?? '',
      totalDistanceKm: (json['total_distance_km'] as num?)?.toDouble() ?? 0.0,
      totalDurationSec: (json['total_duration_sec'] as num?)?.toInt() ?? 0,
      sessionCount: (json['session_count'] as num?)?.toInt() ?? 0,
      longRunKm: (json['long_run_km'] as num?)?.toDouble(),
    );
  }
  const WeeklyStats({
    required this.weekStart,
    required this.totalDistanceKm,
    required this.totalDurationSec,
    required this.sessionCount,
    this.longRunKm,
  });

  final String weekStart;
  final double totalDistanceKm;
  final int totalDurationSec;
  final int sessionCount;
  final double? longRunKm;
}

class LifetimeStats {

  factory LifetimeStats.fromJson(Map<String, dynamic> json) {
    return LifetimeStats(
      totalDistanceKm: (json['total_distance_km'] as num?)?.toDouble() ?? 0.0,
      totalActivities: (json['total_activities'] as num?)?.toInt() ?? 0,
    );
  }
  const LifetimeStats({
    required this.totalDistanceKm,
    required this.totalActivities,
  });

  final double totalDistanceKm;
  final int totalActivities;
}

class WatchInfo {

  factory WatchInfo.fromJson(Map<String, dynamic> json) {
    return WatchInfo(
      brand: json['brand'] as String?,
      lastSyncAt: json['last_sync_at'] as String?,
    );
  }
  const WatchInfo({this.brand, this.lastSyncAt});

  final String? brand; // coros|garmin|null
  final String? lastSyncAt;
}

class HomeData {

  factory HomeData.fromJson(Map<String, dynamic> json) {
    return HomeData(
      userId: (json['user_id'] as String?) ?? '',
      date: (json['date'] as String?) ?? '',
      statusRing: StatusRing.fromJson(
        (json['status_ring'] as Map<String, dynamic>?) ?? {},
      ),
      recentActivities: ((json['recent_activities'] as List?) ?? [])
          .cast<Map<String, dynamic>>()
          .map(HomeActivity.fromJson)
          .toList(growable: false),
      weeklyStats: WeeklyStats.fromJson(
        (json['weekly_stats'] as Map<String, dynamic>?) ?? {},
      ),
      lifetimeStats: LifetimeStats.fromJson(
        (json['lifetime_stats'] as Map<String, dynamic>?) ?? {},
      ),
      planState: (json['plan_state'] as String?) ?? 'none',
      watch: json['watch'] != null
          ? WatchInfo.fromJson(json['watch'] as Map<String, dynamic>)
          : null,
    );
  }
  const HomeData({
    required this.userId,
    required this.date,
    required this.statusRing,
    required this.recentActivities,
    required this.weeklyStats,
    required this.lifetimeStats,
    required this.planState,
    this.watch,
  });

  final String userId;
  final String date;
  final StatusRing statusRing;
  final List<HomeActivity> recentActivities;
  final WeeklyStats weeklyStats;
  final LifetimeStats lifetimeStats;
  final String planState; // none|active|generating
  final WatchInfo? watch;
}
