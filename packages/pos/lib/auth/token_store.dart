import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../models/user.dart';

/// Persists the JWT token pair and the cached user in the OS secure store.
class TokenStore {
  TokenStore._();
  static final TokenStore instance = TokenStore._();

  static const _storage = FlutterSecureStorage();
  static const _kAccess = 'access_token';
  static const _kRefresh = 'refresh_token';
  static const _kRefreshExp = 'refresh_expires_at';
  static const _kUser = 'auth_user';

  String? accessToken;
  String? refreshToken;
  String? refreshExpiresAt;
  AppUser? user;

  bool get hasRefreshToken =>
      refreshToken != null && refreshToken!.isNotEmpty;

  /// Load tokens into memory on startup.
  Future<void> load() async {
    accessToken = await _storage.read(key: _kAccess);
    refreshToken = await _storage.read(key: _kRefresh);
    refreshExpiresAt = await _storage.read(key: _kRefreshExp);
    final userJson = await _storage.read(key: _kUser);
    if (userJson != null) {
      user = AppUser.fromJson(jsonDecode(userJson) as Map<String, dynamic>);
    }
  }

  Future<void> save({
    required String access,
    required String refresh,
    required String refreshExp,
    required AppUser authUser,
  }) async {
    accessToken = access;
    refreshToken = refresh;
    refreshExpiresAt = refreshExp;
    user = authUser;
    await _storage.write(key: _kAccess, value: access);
    await _storage.write(key: _kRefresh, value: refresh);
    await _storage.write(key: _kRefreshExp, value: refreshExp);
    await _storage.write(key: _kUser, value: jsonEncode(authUser.toJson()));
  }

  Future<void> clear() async {
    accessToken = null;
    refreshToken = null;
    refreshExpiresAt = null;
    user = null;
    await _storage.deleteAll();
  }
}
