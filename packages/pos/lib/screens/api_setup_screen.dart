import 'package:flutter/material.dart';

import '../config/app_config.dart';
import '../graphql/graphql_service.dart';
import '../i18n/i18n_service.dart';
import '../widgets/language_selector_button.dart';
import 'router_screen.dart';

/// First-run screen: bind this device to a Retale API endpoint.
class ApiSetupScreen extends StatefulWidget {
  const ApiSetupScreen({super.key});

  @override
  State<ApiSetupScreen> createState() => _ApiSetupScreenState();
}

class _ApiSetupScreenState extends State<ApiSetupScreen> {
  final _controller = TextEditingController(
    text: AppConfig.instance.apiUrl ?? 'http://',
  );
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final url = _controller.text.trim();
    if (url.isEmpty || !url.startsWith('http')) {
      setState(() => _error = tr('setup.enterApiUrl'));
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await AppConfig.instance.setApiUrl(url);
      GraphQLService.instance.rebuild();
      // Probe the endpoint so a typo is caught here, not on the login screen.
      await GraphQLService.instance.query('{ health }');
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
      body: Stack(
        children: [
          Positioned(
            top: 16,
            right: 16,
            child: const LanguageSelectorButton(),
          ),
          Center(
            child: SizedBox(
              width: 360,
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Image.asset('assets/logo.png', height: 56),
                  const SizedBox(height: 12),
                  const Text('Retale POS',
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 4),
                  Text(tr('setup.title'),
                      textAlign: TextAlign.center),
                  const SizedBox(height: 24),
                  TextField(
                    controller: _controller,
                    autocorrect: false,
                    keyboardType: TextInputType.url,
                    decoration: InputDecoration(
                      labelText: tr('setup.apiUrl'),
                      border: const OutlineInputBorder(),
                    ),
                    onSubmitted: (_) => _save(),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 12),
                    Text(_error!,
                        style: const TextStyle(color: Colors.red)),
                  ],
                  const SizedBox(height: 16),
                  FilledButton(
                    onPressed: _busy ? null : _save,
                    child: _busy
                        ? const SizedBox(
                            height: 18,
                            width: 18,
                            child: CircularProgressIndicator(strokeWidth: 2))
                        : Text(tr('setup.saveAndConnect')),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
