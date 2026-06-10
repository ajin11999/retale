import 'package:flutter/material.dart';

import '../auth/auth_service.dart';
import '../config/app_config.dart';
import '../graphql/graphql_service.dart';
import 'router_screen.dart';
import 'two_factor_screen.dart';

/// Password login. Routes into the 2FA screen when the server challenges.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _username = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _username.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _login() async {
    if (_username.text.isEmpty || _password.text.isEmpty) {
      setState(() => _error = 'Enter a username and password');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final outcome = await AuthService.instance
          .login(_username.text.trim(), _password.text);
      if (!mounted) return;
      if (outcome.requiresTwoFactor) {
        Navigator.of(context).push(MaterialPageRoute(
          builder: (_) =>
              TwoFactorScreen(challengeToken: outcome.challengeToken!),
        ));
      } else {
        RouterScreen.goHome(context);
      }
    } on GraphQLAppException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _changeEndpoint() async {
    await AppConfig.instance.setApiUrl('');
    if (mounted) RouterScreen.goHome(context);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: SizedBox(
          width: 320,
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Image.asset('assets/logo.png', height: 56),
              const SizedBox(height: 12),
              const Text('Sign in',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
              const SizedBox(height: 24),
              TextField(
                controller: _username,
                autocorrect: false,
                textInputAction: TextInputAction.next,
                decoration: const InputDecoration(
                  labelText: 'Username',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _password,
                obscureText: true,
                onSubmitted: (_) => _login(),
                decoration: const InputDecoration(
                  labelText: 'Password',
                  border: OutlineInputBorder(),
                ),
              ),
              if (_error != null) ...[
                const SizedBox(height: 12),
                Text(_error!, style: const TextStyle(color: Colors.red)),
              ],
              const SizedBox(height: 16),
              FilledButton(
                onPressed: _busy ? null : _login,
                child: _busy
                    ? const SizedBox(
                        height: 18,
                        width: 18,
                        child: CircularProgressIndicator(strokeWidth: 2))
                    : const Text('Log in'),
              ),
              const SizedBox(height: 8),
              TextButton(
                onPressed: _busy ? null : _changeEndpoint,
                child: const Text('Change server'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
