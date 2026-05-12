/// PbRecordsProvider — fetches /pbs for E6 screen.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../models/pb_record.dart';

final pbRecordsProvider =
    FutureProvider.autoDispose<PbsResponse>((ref) async {
  final api = ref.watch(strideApiProvider);
  final userId = ref.watch(currentUserIdProvider);
  if (userId == null) throw Exception('用户未登录');

  final json = await api.getPbs(userId);
  return PbsResponse.fromJson(json);
});
