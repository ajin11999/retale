import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';

/// Tracks whether the device currently has a network path to the LAN.
///
/// This is link-level only — it cannot tell whether the Retale API itself is
/// reachable. The order queue is the real safety net; this just drives the
/// online/offline banner and triggers a flush attempt when a link returns.
class ConnectivityService extends ChangeNotifier {
  ConnectivityService._();
  static final ConnectivityService instance = ConnectivityService._();

  bool _online = true;
  bool get isOnline => _online;

  StreamSubscription<List<ConnectivityResult>>? _sub;

  Future<void> start() async {
    _apply(await Connectivity().checkConnectivity());
    _sub = Connectivity().onConnectivityChanged.listen(_apply);
  }

  void _apply(List<ConnectivityResult> results) {
    final online = results.any((r) => r != ConnectivityResult.none);
    if (online != _online) {
      _online = online;
      notifyListeners();
    }
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }
}
