/// Onboarding defaults model — mirrors the T17 backend response.
///
/// Endpoint: `GET /api/users/me/onboarding/defaults`
/// Response shape (per `.omc/plans/stride-mobile-m1.md` §3.1.3):
/// ```
/// {
///   "suggested_rhr": int|null,
///   "rhr_source": "health"|null,
///   "suggested_max_hr": int|null,
///   "max_hr_source": "formula"|"health"|null
/// }
/// ```
class OnboardingDefaults {
  factory OnboardingDefaults.fromJson(Map<String, dynamic> json) {
    return OnboardingDefaults(
      suggestedRhr: (json['suggested_rhr'] as num?)?.toInt(),
      rhrSource: json['rhr_source'] as String?,
      suggestedMaxHr: (json['suggested_max_hr'] as num?)?.toInt(),
      maxHrSource: json['max_hr_source'] as String?,
    );
  }
  const OnboardingDefaults({
    this.suggestedRhr,
    this.rhrSource,
    this.suggestedMaxHr,
    this.maxHrSource,
  });

  final int? suggestedRhr;
  final String? rhrSource;
  final int? suggestedMaxHr;
  final String? maxHrSource;
}
