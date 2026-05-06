import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/auth_controller.dart';
import '../env/env.dart';
import 'auth_interceptor.dart';

/// Shared Dio client for `/api/*` against the STRIDE backend.
///
/// Auth interceptor:
///   - Attaches `Authorization: Bearer <access>` on every request
///   - Silent-refreshes once on 401, retries
///   - Calls back to AuthController on second 401 to log out
class ApiClient {
  ApiClient._(this.dio);

  final Dio dio;

  static ApiClient build(Ref ref) {
    final dio = Dio(BaseOptions(
      baseUrl: Env.apiBaseUrl,
      connectTimeout: const Duration(seconds: 15),
      receiveTimeout: const Duration(seconds: 30),
      headers: {'Accept': 'application/json'},
      validateStatus: (s) => s != null && s < 500,
    ));

    final authRepo = ref.read(authRepositoryProvider);
    final interceptor = AuthInterceptor(
      authRepository: authRepo,
      onUnauthorizedAfterRefresh: () {
        // ignore: avoid_dynamic_calls
        Future<void>(() => ref.read(authControllerProvider.notifier).logout());
      },
    );
    dio.interceptors.add(interceptor);

    return ApiClient._(dio);
  }
}

final apiClientProvider = Provider<ApiClient>((ref) => ApiClient.build(ref));
