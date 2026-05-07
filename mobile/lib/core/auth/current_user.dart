import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/api/stride_api.dart';
import '../../data/models/profile.dart';
import 'auth_controller.dart';

final currentUserProvider = FutureProvider<MyProfile?>((ref) async {
  final auth = ref.watch(authControllerProvider);
  if (auth is! AuthAuthenticated) return null;
  final api = ref.watch(strideApiProvider);
  return api.getMyProfile();
});

final currentUserIdProvider = Provider<String?>((ref) {
  final profile = ref.watch(currentUserProvider).valueOrNull;
  return profile?.id;
});
