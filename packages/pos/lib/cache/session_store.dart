import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../models/pos.dart';

/// Durable, per-POS cache of the register's currently-open shift.
///
/// The register is the only screen that works offline (it rings sales into the
/// [OrderQueue]), but reaching it normally needs a live `posSessions` query.
/// Caching the open session lets [SessionGate] resume the register after a
/// restart while the server is unreachable, instead of dead-ending on a
/// connection error.
///
/// The server stays authoritative: this is only consulted when the network call
/// fails, and is refreshed (or cleared) whenever the server is reachable.
class SessionStore {
  SessionStore._();
  static final SessionStore instance = SessionStore._();

  static String _keyFor(String posId) => 'open_session_$posId';

  /// The last shift the server told us was open for [posId], or null when none
  /// is cached, the entry is unreadable, or the cached shift is already closed.
  Future<PosSession?> load(String posId) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_keyFor(posId));
      if (raw == null) return null;
      final session =
          PosSession.fromJson(jsonDecode(raw) as Map<String, dynamic>);
      return session.isOpen ? session : null;
    } catch (_) {
      return null;
    }
  }

  /// Remember [session] as the open shift for [posId].
  Future<void> save(String posId, PosSession session) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_keyFor(posId), jsonEncode(session.toJson()));
  }

  /// Forget any cached shift for [posId] — the shift closed, or the server says
  /// none is open.
  Future<void> clear(String posId) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_keyFor(posId));
  }
}
