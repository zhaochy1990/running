import 'package:flutter/material.dart';

Widget _ph(String name) =>
    Scaffold(body: Center(child: Text('$name placeholder')));

class OnboardingBrandPlaceholder extends StatelessWidget {
  const OnboardingBrandPlaceholder({super.key});
  @override
  Widget build(BuildContext context) => _ph('onboarding_brand');
}

class OnboardingCorosPlaceholder extends StatelessWidget {
  const OnboardingCorosPlaceholder({super.key});
  @override
  Widget build(BuildContext context) => _ph('onboarding_coros');
}

class OnboardingSyncPlaceholder extends StatelessWidget {
  const OnboardingSyncPlaceholder({super.key});
  @override
  Widget build(BuildContext context) => _ph('onboarding_sync');
}

class OnboardingBasicInfoPlaceholder extends StatelessWidget {
  const OnboardingBasicInfoPlaceholder({super.key});
  @override
  Widget build(BuildContext context) => _ph('onboarding_basic_info');
}

class OnboardingBlockedPlaceholder extends StatelessWidget {
  const OnboardingBlockedPlaceholder({super.key});
  @override
  Widget build(BuildContext context) => _ph('onboarding_blocked');
}
