/// HomeData — mirrors `GET /api/{user}/home` response schema.
///
/// Per `.omc/plans/stride-mobile-m1.md` §3.1.1.
library;

/// Coerce any JSON scalar to a String. The backend occasionally serializes a
/// nominally-string field as a number (e.g. an activity `name` that is purely
/// numeric), so a raw `as String?` cast would throw
/// `type 'int' is not a subtype of type 'String?'`. Normalizing at the parse
/// boundary keeps the home screen resilient to that variance.
String? _s(Object? v) => v?.toString();

/// STRIDE-computed training load only (no vendor fatigue / load-state scores).
class StatusRing {

  factory StatusRing.fromJson(Map<String, dynamic> json) {
    return StatusRing(
      tsb: (json['tsb'] as num?)?.toDouble() ?? 0.0,
      tsbBand: _s(json['tsb_band']) ?? 'productive',
      loadRatio: (json['load_ratio'] as num?)?.toDouble() ?? 1.0,
      chronicLoad: (json['chronic_load'] as num?)?.toDouble(),
      acuteLoad: (json['acute_load'] as num?)?.toDouble(),
    );
  }
  const StatusRing({
    required this.tsb,
    required this.tsbBand,
    required this.loadRatio,
    this.chronicLoad,
    this.acuteLoad,
  });

  final double tsb; // STRIDE form = chronic − acute
  final String tsbBand; // race_ready|transitional|productive|overload|detraining
  final double loadRatio; // STRIDE acute/chronic
  final double? chronicLoad; // STRIDE chronic load (CTL)
  final double? acuteLoad; // STRIDE acute load (ATL)
}

class HomeActivity {

  factory HomeActivity.fromJson(Map<String, dynamic> json) {
    return HomeActivity(
      labelId: _s(json['label_id']) ?? '',
      date: _s(json['date']) ?? '',
      name: _s(json['name']) ?? '',
      sportType: _s(json['sport_type']) ?? 'running',
      distanceKm: (json['distance_km'] as num?)?.toDouble() ?? 0.0,
      durationSec: (json['duration_sec'] as num?)?.toInt() ?? 0,
      avgPaceSecPerKm: (json['avg_pace_sec_per_km'] as num?)?.toInt(),
      avgHr: (json['avg_hr'] as num?)?.toInt(),
      calories: (json['calories'] as num?)?.toInt(),
      commentaryExcerpt: _s(json['commentary_excerpt']),
      commentaryGeneratedBy: _s(json['commentary_generated_by']),
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
      weekStart: _s(json['week_start']) ?? '',
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
      brand: _s(json['brand']),
      lastSyncAt: _s(json['last_sync_at']),
    );
  }
  const WatchInfo({this.brand, this.lastSyncAt});

  final String? brand; // coros|garmin|null
  final String? lastSyncAt;
}

class HomeData {

  factory HomeData.fromJson(Map<String, dynamic> json) {
    return HomeData(
      userId: _s(json['user_id']) ?? '',
      date: _s(json['date']) ?? '',
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
      planState: _s(json['plan_state']) ?? 'none',
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
  final String planState; // none|active_no_week|active (src/stride_server/routes/home.py)
  final WatchInfo? watch;
}
