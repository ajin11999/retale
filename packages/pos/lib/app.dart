import 'package:flutter/material.dart';

import 'screens/router_screen.dart';

/// Root widget. A single [MaterialApp]; navigation is plain [Navigator]
/// pushes back to [RouterScreen], which re-resolves the right screen.
class PosApp extends StatelessWidget {
  const PosApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Retale POS',
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
