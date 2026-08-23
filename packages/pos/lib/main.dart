import 'package:flutter/material.dart';

import 'app.dart';
import 'auth/auth_service.dart';
import 'auth/token_store.dart';
import 'cache/order_queue.dart';
import 'cache/product_cache.dart';
import 'config/app_config.dart';
import 'graphql/graphql_service.dart';
import 'i18n/i18n_service.dart';
import 'screens/router_screen.dart';
import 'sync/connectivity.dart';
import 'sync/sync_service.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Restore persisted state before the first frame.
  await I18nService.instance.init();
  await AppConfig.instance.load();
  await TokenStore.instance.load();
  await ProductCache.instance.load();
  await OrderQueue.instance.load();

  // Wire token injection without an auth<->graphql import cycle.
  GraphQLService.instance.tokenProvider = AuthService.instance.bearerToken;
  if (AppConfig.instance.hasApiUrl) {
    GraphQLService.instance.rebuild();
  }

  // A dead session (revoked/expired refresh token) can surface deep inside any
  // operation; when it does, drop the whole stack back to login so the clerk
  // isn't stranded on a misleading "cannot reach the server" screen.
  AuthService.instance.onSessionExpired = () {
    scaffoldMessengerKey.currentState?.showSnackBar(
      const SnackBar(content: Text('Session expired — please log in again.')),
    );
    navigatorKey.currentState?.pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const RouterScreen()),
      (route) => false,
    );
  };

  await ConnectivityService.instance.start();

  // Drain any orders left queued from a previous run — even if the device was
  // never "offline" at the link level (e.g. the API was unreachable), the retry
  // loop keeps trying until they flush.
  SyncService.instance.start();

  runApp(const PosApp());
}
