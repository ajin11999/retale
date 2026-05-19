import 'package:flutter/material.dart';

import 'app.dart';
import 'auth/auth_service.dart';
import 'auth/token_store.dart';
import 'cache/order_queue.dart';
import 'cache/product_cache.dart';
import 'config/app_config.dart';
import 'graphql/graphql_service.dart';
import 'sync/connectivity.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Restore persisted state before the first frame.
  await AppConfig.instance.load();
  await TokenStore.instance.load();
  await ProductCache.instance.load();
  await OrderQueue.instance.load();

  // Wire token injection without an auth<->graphql import cycle.
  GraphQLService.instance.tokenProvider = AuthService.instance.bearerToken;
  if (AppConfig.instance.hasApiUrl) {
    GraphQLService.instance.rebuild();
  }

  await ConnectivityService.instance.start();

  runApp(const PosApp());
}
