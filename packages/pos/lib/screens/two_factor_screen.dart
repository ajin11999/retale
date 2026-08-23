import 'package:flutter/material.dart';

import '../auth/auth_service.dart';
import '../graphql/graphql_service.dart';
import '../i18n/i18n_service.dart';
import 'router_screen.dart';

/// Completes a 2FA login with a TOTP code or a one-time recovery code.
class TwoFactorScreen extends StatefulWidget {
  const TwoFactorScreen({super.key, required this.challengeToken});

  final String challengeToken;

  @override
  State<TwoFactorScreen> createState() => _TwoFactorScreenState();
}

class _TwoFactorScreenState extends State<TwoFactorScreen> {
  final _code = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _verify() async {
    if (_code.text.trim().isEmpty) {
      setState(() => _error = tr('auth.enterValidOtp'));
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await AuthService.instance
          .completeTwoFactor(widget.challengeToken, _code.text.trim());
      if (mounted) RouterScreen.goHome(context);
    } on GraphQLAppException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(tr('auth.twoFactorTitle'))),
      body: Center(
        child: SizedBox(
          width: 320,
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(tr('auth.twoFactorSubtitle')),
              const SizedBox(height: 16),
              TextField(
                controller: _code,
                autofocus: true,
                keyboardType: TextInputType.text,
                onSubmitted: (_) => _verify(),
                decoration: InputDecoration(
                  labelText: tr('auth.twoFactorTitle'),
                  border: const OutlineInputBorder(),
                ),
              ),
              if (_error != null) ...[
                const SizedBox(height: 12),
                Text(_error!, style: const TextStyle(color: Colors.red)),
              ],
              const SizedBox(height: 16),
              FilledButton(
                onPressed: _busy ? null : _verify,
                child: _busy
                    ? const SizedBox(
                        height: 18,
                        width: 18,
                        child: CircularProgressIndicator(strokeWidth: 2))
                    : Text(tr('auth.verify')),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
