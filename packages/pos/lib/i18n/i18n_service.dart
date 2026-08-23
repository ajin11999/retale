import 'dart:convert';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Service managing active translation packs and reactive localization.
class I18nService extends ChangeNotifier {
  I18nService._();
  static final I18nService instance = I18nService._();

  static const String _kLocaleKey = 'retale_pos_locale';
  static const String defaultLocale = 'en';

  static const Map<String, String> supportedLocales = {
    'en': 'English',
    'id': 'Bahasa Indonesia',
  };

  String _currentLocale = defaultLocale;
  Map<String, String> _translations = {};
  Map<String, String> _fallbackTranslations = {};

  String get currentLocale => _currentLocale;
  String get currentLocaleName =>
      supportedLocales[_currentLocale] ?? _currentLocale;

  /// Load persisted language choice and parse asset JSON files.
  Future<void> init() async {
    final prefs = await SharedPreferences.getInstance();
    _currentLocale = prefs.getString(_kLocaleKey) ?? defaultLocale;
    await _loadTranslations();
  }

  /// Change active translation pack at runtime and notify listening widgets.
  Future<void> setLocale(String localeCode) async {
    if (!supportedLocales.containsKey(localeCode)) return;
    if (_currentLocale == localeCode && _translations.isNotEmpty) return;
    _currentLocale = localeCode;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kLocaleKey, localeCode);
    await _loadTranslations();
    notifyListeners();
  }

  Future<void> _loadTranslations() async {
    try {
      final fallbackRaw = await rootBundle.loadString('assets/i18n/en.json');
      final decoded = json.decode(fallbackRaw);
      if (decoded is Map) {
        _fallbackTranslations = decoded.map((k, v) => MapEntry(k.toString(), v.toString()));
      }
    } catch (_) {}

    if (_currentLocale == 'en') {
      _translations = _fallbackTranslations;
    } else {
      try {
        final raw = await rootBundle.loadString('assets/i18n/$_currentLocale.json');
        final decoded = json.decode(raw);
        if (decoded is Map) {
          _translations = decoded.map((k, v) => MapEntry(k.toString(), v.toString()));
        } else {
          _translations = _fallbackTranslations;
        }
      } catch (_) {
        _translations = _fallbackTranslations;
      }
    }
  }

  /// Look up a translation key with fallback and parameter interpolation.
  String translate(String key, [Map<String, dynamic>? params]) {
    String value = _translations[key] ?? _fallbackTranslations[key] ?? key;
    if (params != null && params.isNotEmpty) {
      params.forEach((paramKey, paramVal) {
        value = value.replaceAll('{$paramKey}', paramVal.toString());
      });
    }
    return value;
  }
}

/// Global convenience helper for translating strings.
String tr(String key, [Map<String, dynamic>? params]) =>
    I18nService.instance.translate(key, params);

/// Context extension for translating strings.
extension I18nExtension on BuildContext {
  String tr(String key, [Map<String, dynamic>? params]) =>
      I18nService.instance.translate(key, params);
}
