import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/api/stride_api.dart';
import '../../data/models/profile.dart';
import 'auth_controller.dart';

/// Lazily-loaded current user profile.
///
/// Returns null when unauthenticated. Cached for the lifetime of the
/// authenticated session; logging out invalidates the provider scope.
final currentUserProvider = FutureProvider<MyProfile?>((ref) async {
  final auth = ref.watch(authControllerProvider);
  if (auth is! AuthAuthenticated) return null;
  final api = ref.watch(strideApiProvider);
  return api.getMyProfile();
});

/// Convenience: current user's id (UUID) for path-prefixed endpoints.
final currentUserIdProvider = Provider<String?>((ref) {
  final profile = ref.watch(currentUserProvider).valueOrNull;
  return profile?.id;
});
