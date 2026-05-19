import 'package:flutter/material.dart';

import '../config/app_config.dart';
import '../graphql/graphql_service.dart';
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
      setState(() => _error = 'Enter a full URL, e.g. http://192.168.1.10:3000');
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
      body: Center(
        child: SizedBox(
          width: 360,
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('Retale POS',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
              const SizedBox(height: 4),
              const Text('Connect this register to your server',
                  textAlign: TextAlign.center),
              const SizedBox(height: 24),
              TextField(
                controller: _controller,
                autocorrect: false,
                keyboardType: TextInputType.url,
                decoration: const InputDecoration(
                  labelText: 'API base URL',
                  border: OutlineInputBorder(),
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
                    : const Text('Connect'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
