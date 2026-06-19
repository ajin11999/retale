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

  /// Set only while the refresh mutation itself is in flight, so its own token
  /// fetch doesn't recurse back into another refresh.
  bool _refreshing = false;

  /// The single in-flight rotation. Concurrent callers share it so the rotating
  /// refresh token is spent exactly once — a double-spend reads as token reuse
  /// (theft) on the server and revokes the whole session.
  Future<void>? _refreshInFlight;

  /// Invoked when a refresh is rejected as `SESSION_INVALID` (the session was
  /// revoked or expired server-side). The token store is already cleared by the
  /// time this fires; `main()` wires it to drop the UI back to the login screen.
  void Function()? onSessionExpired;

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
    // Coalesce onto an already-running rotation instead of starting a second.
    final inFlight = _refreshInFlight;
    if (inFlight != null) {
      await inFlight;
      return;
    }
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

  /// Rotate the token pair using the stored refresh token. Single-flighted:
  /// concurrent callers await the same rotation rather than each spending the
  /// (rotating) refresh token, which the server would treat as reuse.
  Future<void> refresh() {
    final existing = _refreshInFlight;
    if (existing != null) return existing;
    final future = _doRefresh();
    _refreshInFlight = future;
    return future.whenComplete(() => _refreshInFlight = null);
  }

  Future<void> _doRefresh() async {
    if (!_store.hasRefreshToken) {
      throw GraphQLAppException('Session expired. Please log in again.');
    }
    _refreshing = true;
    try {
      final data = await _gql.mutate(Ops.refreshToken, variables: {
        'refreshToken': _store.refreshToken,
      });
      await _persist(data['refreshToken'] as Map<String, dynamic>);
    } on GraphQLAppException catch (e) {
      // The server rejected the refresh token: the session is dead (revoked or
      // expired). Clear it so the app falls back to login, and tell the UI to
      // redirect there now — otherwise this surfaces as a misleading
      // "cannot reach the server" inside whatever operation triggered it.
      if (e.code == 'SESSION_INVALID') {
        await _store.clear();
        onSessionExpired?.call();
      }
      rethrow;
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
