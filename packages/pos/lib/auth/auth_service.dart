import 'package:jwt_decoder/jwt_decoder.dart';

import '../graphql/graphql_service.dart';
import '../graphql/operations.dart';
import '../models/user.dart';
import 'token_store.dart';

/// Result of a password login: either authenticated, or a pending 2FA
/// challenge the UI must complete with a TOTP / recovery code.
class LoginOutcome {
  LoginOutcome.authenticated()
      : requiresTwoFactor = false,
        challengeToken = null;
  LoginOutcome.twoFactor(this.challengeToken) : requiresTwoFactor = true;

  final bool requiresTwoFactor;
  final String? challengeToken;
}

/// Owns the auth lifecycle: login, 2FA, token refresh, logout.
class AuthService {
  AuthService._();
  static final AuthService instance = AuthService._();

  final _store = TokenStore.instance;
  final _gql = GraphQLService.instance;
  bool _refreshing = false;

  AppUser? get currentUser => _store.user;
  bool get isAuthenticated => _store.hasRefreshToken;

  /// Returns a valid bearer access token, refreshing it first if it is about
  /// to expire. Wired into [GraphQLService.tokenProvider].
  Future<String?> bearerToken() async {
    await ensureFreshToken();
    return _store.accessToken;
  }

  /// Refresh the access token if it is missing or expires within 60s.
  Future<void> ensureFreshToken() async {
    if (_refreshing) return; // re-entrancy guard (refresh mutation itself).
    final token = _store.accessToken;
    if (token == null) return;
    final stale = JwtDecoder.isExpired(token) ||
        _expiresWithin(token, const Duration(seconds: 60));
    if (stale && _store.hasRefreshToken) {
      await refresh();
    }
  }

  bool _expiresWithin(String jwt, Duration window) {
    try {
      final exp = JwtDecoder.getExpirationDate(jwt);
      return exp.isBefore(DateTime.now().add(window));
    } catch (_) {
      return true; // undecodable -> treat as stale.
    }
  }

  /// Authenticate with username + password.
  Future<LoginOutcome> login(String username, String password) async {
    final data = await _gql.mutate(Ops.login, variables: {
      'username': username,
      'password': password,
    });
    final result = data['login'] as Map<String, dynamic>;
    if (result['requiresTwoFactor'] == true) {
      return LoginOutcome.twoFactor(result['challengeToken'] as String);
    }
    await _persist(result['auth'] as Map<String, dynamic>);
    return LoginOutcome.authenticated();
  }

  /// Complete a 2FA challenge with a TOTP or recovery code.
  Future<void> completeTwoFactor(String challengeToken, String code) async {
    final data = await _gql.mutate(Ops.loginTwoFactor, variables: {
      'challengeToken': challengeToken,
      'code': code,
    });
    await _persist(data['loginTwoFactor'] as Map<String, dynamic>);
  }

  /// Rotate the token pair using the stored refresh token.
  Future<void> refresh() async {
    if (!_store.hasRefreshToken) {
      throw GraphQLAppException('Session expired. Please log in again.');
    }
    _refreshing = true;
    try {
      final data = await _gql.mutate(Ops.refreshToken, variables: {
        'refreshToken': _store.refreshToken,
      });
      await _persist(data['refreshToken'] as Map<String, dynamic>);
    } finally {
      _refreshing = false;
    }
  }

  /// Revoke the session server-side and wipe local tokens.
  Future<void> logout() async {
    final refreshToken = _store.refreshToken;
    if (refreshToken != null) {
      try {
        await _gql.mutate(Ops.logout, variables: {
          'refreshToken': refreshToken,
        });
      } catch (_) {
        // Logout is best-effort; clear locally regardless.
      }
    }
    await _store.clear();
  }

  Future<void> _persist(Map<String, dynamic> authPayload) async {
    await _store.save(
      access: authPayload['accessToken'] as String,
      refresh: authPayload['refreshToken'] as String,
      refreshExp: authPayload['refreshExpiresAt'] as String,
      authUser:
          AppUser.fromJson(authPayload['user'] as Map<String, dynamic>),
    );
  }
}
