import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// App configuration + credentials. Non-secret settings (API base URL, the
/// selected POS) live in shared_preferences; tokens live in secure storage.
class AppConfig {
  static const _kApiUrl = 'api_url';
  static const _kPosId = 'pos_id';
  static const _kAccessToken = 'access_token';
  static const _kRefreshToken = 'refresh_token';

  static const _secure = FlutterSecureStorage();

  // --- API base URL ---

  static Future<String> getApiUrl() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_kApiUrl) ?? '';
  }

  static Future<void> setApiUrl(String url) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kApiUrl, url.trim());
  }

  /// The GraphQL endpoint derived from the base URL (Retale serves `/graphql`).
  static String graphqlEndpoint(String apiUrl) {
    final base = apiUrl.trim().replaceAll(RegExp(r'/+$'), '');
    return '$base/graphql';
  }

  // --- Selected POS (which register workshop sales land in) ---

  static Future<String?> getPosId() async {
    final prefs = await SharedPreferences.getInstance();
    final v = prefs.getString(_kPosId);
    return (v == null || v.isEmpty) ? null : v;
  }

  static Future<void> setPosId(String posId) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kPosId, posId);
  }

  static Future<void> clearPosId() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_kPosId);
  }

  // --- Tokens ---

  static Future<String?> getAccessToken() => _secure.read(key: _kAccessToken);
  static Future<String?> getRefreshToken() => _secure.read(key: _kRefreshToken);

  static Future<void> setTokens(String access, String refresh) async {
    await _secure.write(key: _kAccessToken, value: access);
    await _secure.write(key: _kRefreshToken, value: refresh);
  }

  static Future<void> clearTokens() async {
    await _secure.delete(key: _kAccessToken);
    await _secure.delete(key: _kRefreshToken);
  }
}
