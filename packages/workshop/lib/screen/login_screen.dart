import 'package:flutter/material.dart';
import 'package:graphql_flutter/graphql_flutter.dart';
import 'package:retale_workshop/config.dart';
import 'package:retale_workshop/services/auth_service.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.onLoggedIn});
  final VoidCallback onLoggedIn;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _username = TextEditingController();
  final _password = TextEditingController();
  final _code = TextEditingController();

  bool _busy = false;
  String? _error;
  String? _challengeToken; // set once a 2FA challenge is pending

  @override
  void dispose() {
    _username.dispose();
    _password.dispose();
    _code.dispose();
    super.dispose();
  }

  AuthService get _auth => AuthService(GraphQLProvider.of(context).value);

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (_challengeToken != null) {
        await _auth.loginTwoFactor(_challengeToken!, _code.text.trim());
        widget.onLoggedIn();
        return;
      }
      final outcome = await _auth.login(_username.text.trim(), _password.text);
      if (outcome.requiresTwoFactor) {
        setState(() => _challengeToken = outcome.challengeToken);
      } else {
        widget.onLoggedIn();
      }
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _changeEndpoint() async {
    await AppConfig.setApiUrl('');
    await AppConfig.clearTokens();
    widget.onLoggedIn(); // re-runs the gate → API setting screen
  }

  @override
  Widget build(BuildContext context) {
    final twoFactor = _challengeToken != null;
    return Scaffold(
      body: Center(
        child: SizedBox(
          width: 300,
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Retale Workshop',
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 24),
              if (!twoFactor) ...[
                TextField(
                  controller: _username,
                  autofocus: true,
                  decoration: const InputDecoration(
                      labelText: 'Username', border: OutlineInputBorder()),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: _password,
                  obscureText: true,
                  onSubmitted: (_) => _submit(),
                  decoration: const InputDecoration(
                      labelText: 'Password', border: OutlineInputBorder()),
                ),
              ] else ...[
                const Text('Enter your 2FA code'),
                const SizedBox(height: 8),
                TextField(
                  controller: _code,
                  autofocus: true,
                  keyboardType: TextInputType.number,
                  onSubmitted: (_) => _submit(),
                  decoration: const InputDecoration(
                      labelText: 'Code', border: OutlineInputBorder()),
                ),
              ],
              if (_error != null) ...[
                const SizedBox(height: 12),
                Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
              ],
              const SizedBox(height: 16),
              FilledButton(
                onPressed: _busy ? null : _submit,
                child: _busy
                    ? const SizedBox(
                        height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
                    : Text(twoFactor ? 'Verify' : 'Log in'),
              ),
              const SizedBox(height: 8),
              TextButton(
                onPressed: _busy ? null : _changeEndpoint,
                child: const Text('Change API endpoint'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
