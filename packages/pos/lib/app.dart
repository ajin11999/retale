import 'package:flutter/material.dart';

import 'screens/router_screen.dart';

/// Global handles so non-widget code (the auth layer, on session expiry) can
/// drive navigation and surface a message without a [BuildContext].
final navigatorKey = GlobalKey<NavigatorState>();
final scaffoldMessengerKey = GlobalKey<ScaffoldMessengerState>();

/// Root widget. A single [MaterialApp]; navigation is plain [Navigator]
/// pushes back to [RouterScreen], which re-resolves the right screen.
class PosApp extends StatelessWidget {
  const PosApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Retale POS',
      navigatorKey: navigatorKey,
      scaffoldMessengerKey: scaffoldMessengerKey,
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.indigo),
        useMaterial3: true,
        visualDensity: VisualDensity.compact,
      ),
      builder: (context, child) {
        final media = MediaQuery.of(context);
        return MediaQuery(
          data: media.copyWith(textScaler: const TextScaler.linear(0.9)),
          child: child!,
        );
      },
      home: const RouterScreen(),
    );
  }
}
