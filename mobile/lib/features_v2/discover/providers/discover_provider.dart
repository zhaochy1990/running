import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/api/stride_api.dart';
import '../../../data/models/team.dart';

/// My joined groups — `GET /api/users/me/teams`.
///
/// autoDispose so a fresh list loads each time the 发现 tab is opened.
final myTeamsProvider = FutureProvider.autoDispose<MyTeamsResponse>((ref) async {
  final api = ref.watch(strideApiProvider);
  return api.getMyTeams();
});
