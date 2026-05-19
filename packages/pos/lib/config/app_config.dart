import 'package:shared_preferences/shared_preferences.dart';

/// Runtime configuration that survives restarts: the API base URL and the
/// id of the point-of-sale this device is bound to.
///
/// The token pair lives in [TokenStore] (secure storage), not here.
class AppConfig {
  AppConfig._();
  static final AppConfig instance = AppConfig._();

  static const _kApiUrl = 'api_url';
  static const _kPosId = 'pos_id';

  String? _apiUrl;
  String? _posId;

  /// API base URL, e.g. `http://192.168.1.10:3000`. Null until set.
  String? get apiUrl => _apiUrl;

  /// GraphQL endpoint derived from [apiUrl].
  String get graphqlEndpoint => '${_apiUrl!.replaceAll(RegExp(r'/+$'), '')}/graphql';

  /// The POS this device rings sales against. Null until the clerk picks one.
  String? get posId => _posId;

  bool get hasApiUrl => _apiUrl != null && _apiUrl!.isNotEmpty;
  bool get hasPos => _posId != null && _posId!.isNotEmpty;

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    _apiUrl = prefs.getString(_kApiUrl);
    _posId = prefs.getString(_kPosId);
  }

  Future<void> setApiUrl(String url) async {
    _apiUrl = url.trim();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kApiUrl, _apiUrl!);
  }

  Future<void> setPosId(String? id) async {
    _posId = id;
    final prefs = await SharedPreferences.getInstance();
    if (id == null) {
      await prefs.remove(_kPosId);
    } else {
      await prefs.setString(_kPosId, id);
    }
  }
}
