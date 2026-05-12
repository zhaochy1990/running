/// NutritionPrefs — corresponds to GET/PUT /api/users/me/nutrition-prefs.
library;

class NutritionPrefs {
  const NutritionPrefs({
    required this.enabled,
    required this.dietType,
    required this.allergies,
    required this.goal,
    this.bmrKcal,
    this.tdeeKcal,
    required this.macroProteinPct,
    required this.macroCarbPct,
    required this.macroFatPct,
    this.createdAt,
    this.updatedAt,
  });

  final bool enabled;

  /// "none" | "vegetarian" | "halal" | "other"
  final String dietType;
  final List<String> allergies;

  /// "bulk" | "cut" | "maintain" | "race"
  final String goal;
  final int? bmrKcal;
  final int? tdeeKcal;
  final double macroProteinPct;
  final double macroCarbPct;
  final double macroFatPct;
  final String? createdAt;
  final String? updatedAt;

  factory NutritionPrefs.fromJson(Map<String, dynamic> json) {
    return NutritionPrefs(
      enabled: (json['enabled'] as bool?) ?? false,
      dietType: (json['diet_type'] as String?) ?? 'none',
      allergies: (json['allergies'] as List<dynamic>? ?? const [])
          .map((e) => e as String)
          .toList(),
      goal: (json['goal'] as String?) ?? 'maintain',
      bmrKcal: (json['bmr_kcal'] as num?)?.toInt(),
      tdeeKcal: (json['tdee_kcal'] as num?)?.toInt(),
      macroProteinPct: (json['macro_protein_pct'] as num?)?.toDouble() ?? 30.0,
      macroCarbPct: (json['macro_carb_pct'] as num?)?.toDouble() ?? 50.0,
      macroFatPct: (json['macro_fat_pct'] as num?)?.toDouble() ?? 20.0,
      createdAt: json['created_at'] as String?,
      updatedAt: json['updated_at'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
        'enabled': enabled,
        'diet_type': dietType,
        'allergies': allergies,
        'goal': goal,
        if (bmrKcal != null) 'bmr_kcal': bmrKcal,
        if (tdeeKcal != null) 'tdee_kcal': tdeeKcal,
        'macro_protein_pct': macroProteinPct,
        'macro_carb_pct': macroCarbPct,
        'macro_fat_pct': macroFatPct,
      };

  NutritionPrefs copyWith({
    bool? enabled,
    String? dietType,
    List<String>? allergies,
    String? goal,
    Object? bmrKcal = _sentinel,
    Object? tdeeKcal = _sentinel,
    double? macroProteinPct,
    double? macroCarbPct,
    double? macroFatPct,
  }) {
    return NutritionPrefs(
      enabled: enabled ?? this.enabled,
      dietType: dietType ?? this.dietType,
      allergies: allergies ?? this.allergies,
      goal: goal ?? this.goal,
      bmrKcal: identical(bmrKcal, _sentinel) ? this.bmrKcal : bmrKcal as int?,
      tdeeKcal:
          identical(tdeeKcal, _sentinel) ? this.tdeeKcal : tdeeKcal as int?,
      macroProteinPct: macroProteinPct ?? this.macroProteinPct,
      macroCarbPct: macroCarbPct ?? this.macroCarbPct,
      macroFatPct: macroFatPct ?? this.macroFatPct,
      createdAt: createdAt,
      updatedAt: updatedAt,
    );
  }
}

const _sentinel = Object();
