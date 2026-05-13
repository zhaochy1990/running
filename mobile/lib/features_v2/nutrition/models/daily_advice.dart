/// DailyAdvice — corresponds to GET /api/{user}/nutrition/daily?date=YYYY-MM-DD.
library;

class NutritionMacros {

  factory NutritionMacros.fromJson(Map<String, dynamic> json) {
    return NutritionMacros(
      proteinG: (json['protein_g'] as num?)?.toDouble() ?? 0,
      carbG: (json['carb_g'] as num?)?.toDouble() ?? 0,
      fatG: (json['fat_g'] as num?)?.toDouble() ?? 0,
    );
  }
  const NutritionMacros({
    required this.proteinG,
    required this.carbG,
    required this.fatG,
  });

  final double proteinG;
  final double carbG;
  final double fatG;
}

class NutritionAdvice {

  factory NutritionAdvice.fromJson(Map<String, dynamic> json) {
    return NutritionAdvice(
      pre: json['pre'] as String?,
      intra: json['intra'] as String?,
      post: json['post'] as String?,
    );
  }
  const NutritionAdvice({this.pre, this.intra, this.post});

  final String? pre;
  final String? intra;
  final String? post;
}

class DailyAdvice {

  factory DailyAdvice.fromJson(Map<String, dynamic> json) {
    return DailyAdvice(
      userId: (json['user_id'] as String?) ?? '',
      date: (json['date'] as String?) ?? '',
      isTrainingDay: (json['is_training_day'] as bool?) ?? false,
      targetKcal: (json['target_kcal'] as num?)?.toInt() ?? 0,
      macros: NutritionMacros.fromJson(
          (json['macros'] as Map<String, dynamic>?) ?? {}),
      advice: NutritionAdvice.fromJson(
          (json['advice'] as Map<String, dynamic>?) ?? {}),
    );
  }
  const DailyAdvice({
    required this.userId,
    required this.date,
    required this.isTrainingDay,
    required this.targetKcal,
    required this.macros,
    required this.advice,
  });

  final String userId;
  final String date;
  final bool isTrainingDay;
  final int targetKcal;
  final NutritionMacros macros;
  final NutritionAdvice advice;
}
