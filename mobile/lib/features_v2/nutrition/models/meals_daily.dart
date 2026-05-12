/// MealsDaily — corresponds to GET /api/{user}/nutrition/meals?date=YYYY-MM-DD
/// and POST /api/{user}/nutrition/meals response.
library;

class MealItem {
  const MealItem({
    required this.name,
    required this.kcal,
    required this.proteinG,
    required this.carbG,
    required this.fatG,
  });

  final String name;
  final double kcal;
  final double proteinG;
  final double carbG;
  final double fatG;

  factory MealItem.fromJson(Map<String, dynamic> json) {
    return MealItem(
      name: (json['name'] as String?) ?? '',
      kcal: (json['kcal'] as num?)?.toDouble() ?? 0,
      proteinG: (json['protein_g'] as num?)?.toDouble() ?? 0,
      carbG: (json['carb_g'] as num?)?.toDouble() ?? 0,
      fatG: (json['fat_g'] as num?)?.toDouble() ?? 0,
    );
  }

  Map<String, dynamic> toJson() => {
        'name': name,
        'kcal': kcal,
        'protein_g': proteinG,
        'carb_g': carbG,
        'fat_g': fatG,
      };
}

class Meal {
  const Meal({
    required this.mealId,
    required this.mealType,
    required this.items,
    this.notes,
  });

  /// "breakfast" | "lunch" | "dinner" | "snack"
  final String mealId;
  final String mealType;
  final List<MealItem> items;
  final String? notes;

  factory Meal.fromJson(Map<String, dynamic> json) {
    final rawItems =
        (json['items'] as List<dynamic>? ?? const []).cast<Map<String, dynamic>>();
    return Meal(
      mealId: (json['meal_id'] as String?) ?? '',
      mealType: (json['meal_type'] as String?) ?? 'breakfast',
      items: rawItems.map(MealItem.fromJson).toList(),
      notes: json['notes'] as String?,
    );
  }
}

class MealTotals {
  const MealTotals({
    required this.kcal,
    required this.proteinG,
    required this.carbG,
    required this.fatG,
  });

  final double kcal;
  final double proteinG;
  final double carbG;
  final double fatG;

  factory MealTotals.fromJson(Map<String, dynamic> json) {
    return MealTotals(
      kcal: (json['kcal'] as num?)?.toDouble() ?? 0,
      proteinG: (json['protein_g'] as num?)?.toDouble() ?? 0,
      carbG: (json['carb_g'] as num?)?.toDouble() ?? 0,
      fatG: (json['fat_g'] as num?)?.toDouble() ?? 0,
    );
  }

  static const zero = MealTotals(kcal: 0, proteinG: 0, carbG: 0, fatG: 0);
}

class MealsDaily {
  const MealsDaily({
    required this.date,
    required this.meals,
    required this.dailyTotals,
  });

  final String date;
  final List<Meal> meals;
  final MealTotals dailyTotals;

  factory MealsDaily.fromJson(Map<String, dynamic> json) {
    final rawMeals =
        (json['meals'] as List<dynamic>? ?? const []).cast<Map<String, dynamic>>();
    return MealsDaily(
      date: (json['date'] as String?) ?? '',
      meals: rawMeals.map(Meal.fromJson).toList(),
      dailyTotals: MealTotals.fromJson(
          (json['daily_totals'] as Map<String, dynamic>?) ?? {}),
    );
  }
}
