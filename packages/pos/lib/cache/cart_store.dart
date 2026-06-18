import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../models/cart.dart';

/// Durable, per-POS persistence of the register's open carts.
///
/// The cashier's in-progress sales are parked work, not committed orders, so
/// they survive a shift close and an app restart. Stored as a JSON string in
/// shared_preferences (uniform on Windows, Linux and web), keyed by POS id so
/// each register resumes its own carts.
class CartStore {
  CartStore._();
  static final CartStore instance = CartStore._();

  static String _keyFor(String posId) => 'register_carts_$posId';

  // Bursts of edits (e.g. tapping a qty stepper) collapse into ordered writes:
  // each call captures the latest state synchronously, but only one write runs
  // at a time, so a slower earlier write can never land on top of a newer one.
  String? _pendingJson;
  String? _pendingPosId;
  bool _writing = false;

  /// Restore the saved register for [posId], or null when there is nothing
  /// worth restoring — no save, a corrupt entry, or just a single empty cart.
  Future<Register?> load(String posId) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_keyFor(posId));
      if (raw == null) return null;
      final register =
          Register.fromJson(jsonDecode(raw) as Map<String, dynamic>);
      return register.isPristine ? null : register;
    } catch (_) {
      return null;
    }
  }

  /// Persist [register] for [posId]. The state is serialised immediately (so it
  /// reflects this moment), then written; concurrent calls collapse to a single
  /// trailing write that reflects the most recent state.
  Future<void> save(String posId, Register register) async {
    _pendingPosId = posId;
    _pendingJson = jsonEncode(register.toJson());
    if (_writing) return;
    _writing = true;
    try {
      final prefs = await SharedPreferences.getInstance();
      while (_pendingJson != null) {
        final json = _pendingJson!;
        final key = _keyFor(_pendingPosId!);
        _pendingJson = null;
        await prefs.setString(key, json);
      }
    } finally {
      _writing = false;
    }
  }
}
