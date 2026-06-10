import 'package:shared_preferences/shared_preferences.dart';

/// Runtime configuration that survives restarts: the API base URL.
///
/// The token pair lives in [TokenStore] (secure storage), not here.
class AppConfig {
  AppConfig._();
  static final AppConfig instance = AppConfig._();

  static const _kApiUrl = 'api_url';

  String? _apiUrl;

  /// API base URL, e.g. `http://192.168.1.10:3000`. Null until set.
  String? get apiUrl => _apiUrl;

  /// GraphQL endpoint derived from [apiUrl].
  String get graphqlEndpoint => '${_apiUrl!.replaceAll(RegExp(r'/+$'), '')}/graphql';

  bool get hasApiUrl => _apiUrl != null && _apiUrl!.isNotEmpty;

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    _apiUrl = prefs.getString(_kApiUrl);
  }

  Future<void> setApiUrl(String url) async {
    _apiUrl = url.trim();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kApiUrl, _apiUrl!);
  }
}
