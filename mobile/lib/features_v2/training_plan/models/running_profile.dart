/// C2 — Running profile model.
///
/// Serialises to/from the `/api/users/me/running-profile` JSON contract.
library;

enum RunningAge { lt6m, sixMonthsTo1Year, oneToThreeYears, threePlus }

enum WeeklyKm { lt20, twentyToForty, fortyToSixty, sixtyPlus }

// ── JSON helpers ──────────────────────────────────────────────────────────────

RunningAge _runningAgeFromJson(String v) => switch (v) {
      'lt6m' => RunningAge.lt6m,
      '6m_1y' => RunningAge.sixMonthsTo1Year,
      '1y_3y' => RunningAge.oneToThreeYears,
      '3y_plus' => RunningAge.threePlus,
      _ => RunningAge.lt6m,
    };

String _runningAgeToJson(RunningAge a) => switch (a) {
      RunningAge.lt6m => 'lt6m',
      RunningAge.sixMonthsTo1Year => '6m_1y',
      RunningAge.oneToThreeYears => '1y_3y',
      RunningAge.threePlus => '3y_plus',
    };

WeeklyKm _weeklyKmFromJson(String v) => switch (v) {
      'lt20' => WeeklyKm.lt20,
      '20_40' => WeeklyKm.twentyToForty,
      '40_60' => WeeklyKm.fortyToSixty,
      '60_plus' => WeeklyKm.sixtyPlus,
      _ => WeeklyKm.lt20,
    };

String _weeklyKmToJson(WeeklyKm k) => switch (k) {
      WeeklyKm.lt20 => 'lt20',
      WeeklyKm.twentyToForty => '20_40',
      WeeklyKm.fortyToSixty => '40_60',
      WeeklyKm.sixtyPlus => '60_plus',
    };

// ── Sub-models ────────────────────────────────────────────────────────────────

class PB {
  const PB({required this.distance, required this.time});

  /// One of "5K", "10K", "HM", "FM".
  final String distance;

  /// H:MM:SS format, e.g. "3:45:00".
  final String time;

  Map<String, dynamic> toJson() => {'distance': distance, 'time': time};

  factory PB.fromJson(Map<String, dynamic> json) => PB(
        distance: json['distance'] as String,
        time: json['time'] as String,
      );
}

// ── Model ─────────────────────────────────────────────────────────────────────

class RunningProfile {
  const RunningProfile({
    this.profileId,
    required this.runningAge,
    required this.currentWeeklyKm,
    required this.pbs,
    required this.injuries,
  });

  final String? profileId;
  final RunningAge runningAge;
  final WeeklyKm currentWeeklyKm;

  /// PB entries; may be empty.
  final List<PB> pbs;

  /// Injury tags, e.g. ["knee", "ankle"]. Empty list means none.
  final List<String> injuries;

  Map<String, dynamic> toJson() => {
        if (profileId != null) 'profile_id': profileId,
        'running_age': _runningAgeToJson(runningAge),
        'current_weekly_km': _weeklyKmToJson(currentWeeklyKm),
        'pbs': pbs.map((p) => p.toJson()).toList(),
        'injuries': injuries,
      };

  factory RunningProfile.fromJson(Map<String, dynamic> json) {
    final rawPbs =
        (json['pbs'] as List? ?? const []).cast<Map<String, dynamic>>();
    return RunningProfile(
      profileId: json['profile_id'] as String?,
      runningAge:
          _runningAgeFromJson(json['running_age'] as String? ?? 'lt6m'),
      currentWeeklyKm:
          _weeklyKmFromJson(json['current_weekly_km'] as String? ?? 'lt20'),
      pbs: rawPbs.map(PB.fromJson).toList(),
      injuries: (json['injuries'] as List? ?? const []).cast<String>(),
    );
  }

  RunningProfile copyWith({
    String? profileId,
    RunningAge? runningAge,
    WeeklyKm? currentWeeklyKm,
    List<PB>? pbs,
    List<String>? injuries,
  }) {
    return RunningProfile(
      profileId: profileId ?? this.profileId,
      runningAge: runningAge ?? this.runningAge,
      currentWeeklyKm: currentWeeklyKm ?? this.currentWeeklyKm,
      pbs: pbs ?? this.pbs,
      injuries: injuries ?? this.injuries,
    );
  }
}
