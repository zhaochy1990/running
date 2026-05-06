import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'auth_models.dart';
import 'auth_repository.dart';

final authRepositoryProvider = Provider<AuthRepository>((_) => AuthRepository());

/// High-level auth state.
sealed class AuthState {
  const AuthState();
}

class AuthLoading extends AuthState {
  const AuthLoading();
}

class AuthAuthenticated extends AuthState {
  const AuthAuthenticated(this.tokens);
  final TokenSet tokens;
}

class AuthUnauthenticated extends AuthState {
  const AuthUnauthenticated([this.message]);
  final String? message;
}

class AuthController extends StateNotifier<AuthState> {
  AuthController(this._repo) : super(const AuthLoading()) {
    _hydrate();
  }

  final AuthRepository _repo;

  Future<void> _hydrate() async {
    final tokens = await _repo.currentTokens();
    if (tokens == null) {
      state = const AuthUnauthenticated();
      return;
    }
    if (tokens.isExpired) {
      try {
        final refreshed = await _repo.refresh(tokens);
        state = AuthAuthenticated(refreshed);
      } catch (e) {
        state = AuthUnauthenticated(e is AuthException ? e.message : null);
      }
      return;
    }
    state = AuthAuthenticated(tokens);
  }

  Future<void> login(String email, String password) async {
    state = const AuthLoading();
    try {
      final tokens = await _repo.login(email: email, password: password);
      state = AuthAuthenticated(tokens);
    } on AuthException catch (e) {
      state = AuthUnauthenticated(e.message);
      rethrow;
    } catch (_) {
      state = const AuthUnauthenticated('网络错误，请稍后重试');
      rethrow;
    }
  }

  Future<void> logout() async {
    await _repo.logout();
    state = const AuthUnauthenticated();
  }
}

final authControllerProvider =
    StateNotifierProvider<AuthController, AuthState>((ref) {
  return AuthController(ref.watch(authRepositoryProvider));
});
