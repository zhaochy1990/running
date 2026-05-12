import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/api/stride_api.dart';
import '../models/onboarding_defaults.dart';

/// Fetches RHR / MaxHR suggestions for the B4 basic-info screen.
///
/// `autoDispose` so we don't hold the body forever — the screen is a
/// one-shot onboarding step. If the call fails, the screen falls back
/// to fully blank inputs.
final onboardingDefaultsProvider =
    FutureProvider.autoDispose<OnboardingDefaults>((ref) async {
  final api = ref.watch(strideApiProvider);
  return api.getOnboardingDefaults();
});
