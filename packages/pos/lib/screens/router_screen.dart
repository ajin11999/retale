import 'package:flutter/material.dart';

import '../auth/auth_service.dart';
import '../config/app_config.dart';
import 'api_setup_screen.dart';
import 'login_screen.dart';
import 'pos_selection_screen.dart';
import 'session_screen.dart';

/// Decides which screen to show based on how far setup has progressed:
/// API URL -> login -> POS binding -> open session -> register.
///
/// Screens re-route by calling [RouterScreen.goHome], which rebuilds this.
class RouterScreen extends StatelessWidget {
  const RouterScreen({super.key});

  /// Drop the whole stack and re-resolve from scratch.
  static void goHome(BuildContext context) {
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const RouterScreen()),
      (route) => false,
    );
  }

  @override
  Widget build(BuildContext context) {
    final config = AppConfig.instance;
    if (!config.hasApiUrl) return const ApiSetupScreen();
    if (!AuthService.instance.isAuthenticated) return const LoginScreen();
    if (!config.hasPos) return const PosSelectionScreen();
    return const SessionGate();
  }
}
