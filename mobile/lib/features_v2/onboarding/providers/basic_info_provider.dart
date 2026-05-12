import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';

/// Form state for B4 basic-info screen.
class BasicInfoForm {
  const BasicInfoForm({
    this.sex,
    this.birthYear,
    this.heightCm,
    this.weightKg,
    this.restingHr,
    this.maxHr,
    this.submitting = false,
    this.error,
  });

  /// 'male' | 'female' (we only expose 2 segments in v1; backend also accepts 'other').
  final String? sex;
  final int? birthYear;
  final double? heightCm;
  final double? weightKg;
  final int? restingHr;
  final int? maxHr;
  final bool submitting;
  final String? error;

  bool get isComplete =>
      sex != null &&
      birthYear != null &&
      heightCm != null &&
      weightKg != null &&
      restingHr != null &&
      maxHr != null;

  BasicInfoForm copyWith({
    String? sex,
    int? birthYear,
    double? heightCm,
    double? weightKg,
    int? restingHr,
    int? maxHr,
    bool? submitting,
    Object? error = _sentinel,
  }) {
    return BasicInfoForm(
      sex: sex ?? this.sex,
      birthYear: birthYear ?? this.birthYear,
      heightCm: heightCm ?? this.heightCm,
      weightKg: weightKg ?? this.weightKg,
      restingHr: restingHr ?? this.restingHr,
      maxHr: maxHr ?? this.maxHr,
      submitting: submitting ?? this.submitting,
      error: identical(error, _sentinel) ? this.error : error as String?,
    );
  }
}

const _sentinel = Object();

class BasicInfoController extends StateNotifier<BasicInfoForm> {
  BasicInfoController(this._ref) : super(const BasicInfoForm());

  final Ref _ref;

  void setSex(String? v) => state = state.copyWith(sex: v);
  void setBirthYear(int? v) => state = state.copyWith(birthYear: v);
  void setHeightCm(double? v) => state = state.copyWith(heightCm: v);
  void setWeightKg(double? v) => state = state.copyWith(weightKg: v);
  void setRestingHr(int? v) => state = state.copyWith(restingHr: v);
  void setMaxHr(int? v) => state = state.copyWith(maxHr: v);

  /// Submit profile patch + onboarding complete. Returns true on success.
  /// On failure, [BasicInfoForm.error] is populated and false is returned.
  Future<bool> submit() async {
    if (!state.isComplete || state.submitting) return false;
    state = state.copyWith(submitting: true, error: null);

    final api = _ref.read(strideApiProvider);
    try {
      // birth_year → ISO `dob` (Jan 1st of that year). Backend's
      // ProfilePatch model only knows `dob: date`. The day/month is
      // best-effort placeholder; user can refine later in G1.
      final dob = '${state.birthYear!.toString().padLeft(4, '0')}-01-01';
      await api.patchProfile(
        sex: state.sex,
        dob: dob,
        heightCm: state.heightCm,
        weightKg: state.weightKg,
      );
      // Best-effort onboarding complete. If it fails (e.g. coros_ready
      // not yet true), we still treat the basic-info step as done — the
      // backend tracks `profile_ready` separately via the PATCH above.
      try {
        await api.completeOnboarding();
      } catch (_) {
        // swallow — caller still navigates home
      }
      // Refresh the cached profile so the router redirect sees the new
      // `completed_at` / `profile_ready`.
      // ignore: unused_result
      _ref.refresh(currentUserProvider);
      state = state.copyWith(submitting: false);
      return true;
    } catch (e) {
      state = state.copyWith(submitting: false, error: e.toString());
      return false;
    }
  }
}

final basicInfoControllerProvider =
    StateNotifierProvider.autoDispose<BasicInfoController, BasicInfoForm>(
        (ref) => BasicInfoController(ref));
