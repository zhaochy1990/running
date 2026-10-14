/// GET /api/users/me/watch 的共享数据源：手表管理页的绑定态卡片与
/// 「我」页手动同步行的 last_sync 都从这一个 provider 读（#462：
/// watch 展示数据源从 home 快照改为 GET /watch）。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/api/stride_api.dart';
import '../../data/models/watch.dart';

final watchInfoProvider = FutureProvider.autoDispose<WatchInfo>((ref) {
  return ref.watch(strideApiProvider).getWatch();
});
