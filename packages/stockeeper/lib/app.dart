import 'package:flutter/material.dart';

import 'screens/router_screen.dart';

/// Root widget. A single [MaterialApp]; navigation is plain [Navigator]
/// pushes back to [RouterScreen], which re-resolves the right screen.
///
/// Unlike the POS app there is no textScaler shrink — warehouse staff use
/// this on phones at arm's length, so the UI stays big and tappable.
class StockeeperApp extends StatelessWidget {
  const StockeeperApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Retale Stockeeper',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.green),
        useMaterial3: true,
      ),
      home: const RouterScreen(),
    );
  }
}
