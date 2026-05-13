/// Nutrition prefs providers.
///
/// [nutritionPrefsProvider]  — async loader (GET); returns null on 404.
/// [nutritionPrefsFormProvider] — form editing state + submit logic.
library;

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/api/stride_api.dart';
import '../models/nutrition_prefs.dart';

// ── Loader ────────────────────────────────────────────────────────────────────

final nutritionPrefsProvider =
    FutureProvider.autoDispose<NutritionPrefs?>((ref) async {
  final api = ref.watch(strideApiProvider);
  return api.getNutritionPrefs();
});

// ── Form state ────────────────────────────────────────────────────────────────

class NutritionPrefsForm {
  const NutritionPrefsForm({
    this.enabled = true,
    this.dietType = 'none',
    this.allergies = const [],
    this.goal = 'maintain',
    this.bmrKcal,
    this.tdeeKcal,
    this.macroProteinPct = 30.0,
    this.macroCarbPct = 50.0,
    this.macroFatPct = 20.0,
    this.submitting = false,
    this.error,
  });

  final bool enabled;
  final String dietType;
  final List<String> allergies;
  final String goal;
  final int? bmrKcal;
  final int? tdeeKcal;
  final double macroProteinPct;
  final double macroCarbPct;
  final double macroFatPct;
  final bool submitting;
  final String? error;

  NutritionPrefsForm copyWith({
    bool? enabled,
    String? dietType,
    List<String>? allergies,
    String? goal,
    Object? bmrKcal = _sentinel,
    Object? tdeeKcal = _sentinel,
    double? macroProteinPct,
    double? macroCarbPct,
    double? macroFatPct,
    bool? submitting,
    Object? error = _sentinel,
  }) {
    return NutritionPrefsForm(
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
      submitting: submitting ?? this.submitting,
      error: identical(error, _sentinel) ? this.error : error as String?,
    );
  }

  Map<String, dynamic> toBody() => {
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
}

const _sentinel = Object();

// ── Notifier ──────────────────────────────────────────────────────────────────

class NutritionPrefsNotifier extends StateNotifier<NutritionPrefsForm> {
  NutritionPrefsNotifier(this._ref) : super(const NutritionPrefsForm());

  final Ref _ref;

  void loadFrom(NutritionPrefs prefs) {
    state = NutritionPrefsForm(
      enabled: prefs.enabled,
      dietType: prefs.dietType,
      allergies: List.of(prefs.allergies),
      goal: prefs.goal,
      bmrKcal: prefs.bmrKcal,
      tdeeKcal: prefs.tdeeKcal,
      macroProteinPct: prefs.macroProteinPct,
      macroCarbPct: prefs.macroCarbPct,
      macroFatPct: prefs.macroFatPct,
    );
  }

  void setEnabled(bool v) => state = state.copyWith(enabled: v);
  void setDietType(String v) => state = state.copyWith(dietType: v);
  void setGoal(String v) => state = state.copyWith(goal: v);
  void setBmrKcal(int? v) => state = state.copyWith(bmrKcal: v);
  void setTdeeKcal(int? v) => state = state.copyWith(tdeeKcal: v);

  void addAllergy(String a) {
    final updated = List<String>.of(state.allergies);
    if (!updated.contains(a)) updated.add(a);
    state = state.copyWith(allergies: updated);
  }

  void removeAllergy(String a) {
    final updated = List<String>.of(state.allergies)..remove(a);
    state = state.copyWith(allergies: updated);
  }

  /// Drag protein slider; redistribute remainder proportionally between
  /// carb and fat, clamping each to [0, 100].
  void setProteinPct(double protein) {
    protein = protein.clamp(0.0, 100.0);
    final remaining = 100.0 - protein;
    final oldOther = state.macroCarbPct + state.macroFatPct;
    double carb, fat;
    if (oldOther <= 0) {
      carb = remaining / 2;
      fat = remaining / 2;
    } else {
      carb = (state.macroCarbPct / oldOther) * remaining;
      fat = (state.macroFatPct / oldOther) * remaining;
    }
    state = state.copyWith(
      macroProteinPct: _r(protein),
      macroCarbPct: _r(carb),
      macroFatPct: _r(fat),
    );
  }

  /// Drag carb slider; redistribute remainder between protein and fat.
  void setCarbPct(double carb) {
    carb = carb.clamp(0.0, 100.0);
    final remaining = 100.0 - carb;
    final oldOther = state.macroProteinPct + state.macroFatPct;
    double protein, fat;
    if (oldOther <= 0) {
      protein = remaining / 2;
      fat = remaining / 2;
    } else {
      protein = (state.macroProteinPct / oldOther) * remaining;
      fat = (state.macroFatPct / oldOther) * remaining;
    }
    state = state.copyWith(
      macroProteinPct: _r(protein),
      macroCarbPct: _r(carb),
      macroFatPct: _r(fat),
    );
  }

  /// Drag fat slider; redistribute remainder between protein and carb.
  void setFatPct(double fat) {
    fat = fat.clamp(0.0, 100.0);
    final remaining = 100.0 - fat;
    final oldOther = state.macroProteinPct + state.macroCarbPct;
    double protein, carb;
    if (oldOther <= 0) {
      protein = remaining / 2;
      carb = remaining / 2;
    } else {
      protein = (state.macroProteinPct / oldOther) * remaining;
      carb = (state.macroCarbPct / oldOther) * remaining;
    }
    state = state.copyWith(
      macroProteinPct: _r(protein),
      macroCarbPct: _r(carb),
      macroFatPct: _r(fat),
    );
  }

  /// Round to 1 decimal place.
  static double _r(double v) => (v * 10).round() / 10;

  Future<bool> submit() async {
    if (state.submitting) return false;
    state = state.copyWith(submitting: true, error: null);
    final api = _ref.read(strideApiProvider);
    try {
      await api.putNutritionPrefs(state.toBody());
      state = state.copyWith(submitting: false);
      _ref.invalidate(nutritionPrefsProvider);
      return true;
    } on DioException catch (e) {
      final data = e.response?.data;
      final detail =
          data is Map<String, dynamic> ? data['detail']?.toString() : null;
      state = state.copyWith(
        submitting: false,
        error: detail ?? e.message,
      );
      return false;
    } catch (e) {
      state = state.copyWith(submitting: false, error: e.toString());
      return false;
    }
  }
}

final nutritionPrefsFormProvider =
    StateNotifierProvider.autoDispose<NutritionPrefsNotifier, NutritionPrefsForm>(
  (ref) => NutritionPrefsNotifier(ref),
);
