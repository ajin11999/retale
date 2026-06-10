import 'package:flutter/material.dart';

import 'app.dart';
import 'auth/auth_service.dart';
import 'auth/token_store.dart';
import 'config/app_config.dart';
import 'graphql/graphql_service.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Restore persisted state before the first frame.
  await AppConfig.instance.load();
  await TokenStore.instance.load();

  // Wire token injection without an auth<->graphql import cycle.
  GraphQLService.instance.tokenProvider = AuthService.instance.bearerToken;
  if (AppConfig.instance.hasApiUrl) {
    GraphQLService.instance.rebuild();
  }

  runApp(const StockeeperApp());
}
