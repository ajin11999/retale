import 'package:flutter/material.dart';
import 'package:retale_workshop/config.dart';
import 'package:retale_workshop/graphql/client.dart';

/// Set the Retale API base URL (e.g. `http://192.168.1.10:3000`). The GraphQL
/// endpoint is derived as `<base>/graphql`.
class ApiSettingScreen extends StatefulWidget {
  const ApiSettingScreen({
    super.key,
    this.isStart = false,
    required this.onSaved,
  });

  /// True during first-run setup (no back button / different copy).
  final bool isStart;
  final VoidCallback onSaved;

  @override
  State<ApiSettingScreen> createState() => _ApiSettingScreenState();
}

class _ApiSettingScreenState extends State<ApiSettingScreen> {
  final _controller = TextEditingController();
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    AppConfig.getApiUrl().then((url) {
      if (mounted) _controller.text = url;
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final url = _controller.text.trim();
    if (url.isEmpty) return;
    setState(() => _saving = true);
    await AppConfig.setApiUrl(url);
    AppGraphQL.configure(url);
    if (mounted) {
      setState(() => _saving = false);
      widget.onSaved();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('API endpoint'),
        automaticallyImplyLeading: !widget.isStart,
      ),
      body: Center(
        child: SizedBox(
          width: 340,
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('Retale API base URL'),
              const SizedBox(height: 8),
              TextField(
                controller: _controller,
                autofocus: true,
                keyboardType: TextInputType.url,
                decoration: const InputDecoration(
                  border: OutlineInputBorder(),
                  hintText: 'http://192.168.1.10:3000',
                ),
                onSubmitted: (_) => _save(),
              ),
              const SizedBox(height: 16),
              FilledButton(
                onPressed: _saving ? null : _save,
                child: _saving
                    ? const SizedBox(
                        height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Text('Save'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
