import 'package:flutter/material.dart';
import 'package:retale_workshop/config.dart';
import 'package:retale_workshop/graphql/client.dart';
import 'package:retale_workshop/screen/api_setting_screen.dart';
import 'package:retale_workshop/screen/login_screen.dart';
import 'package:retale_workshop/screen/pos_selection_screen.dart';
import 'package:retale_workshop/screen/workshop_home.dart';

class _Startup {
  _Startup({required this.apiUrl, required this.hasToken, required this.posId});
  final String apiUrl;
  final bool hasToken;
  final String? posId;
}

/// Routes to the right screen based on setup progress: API URL → login →
/// pick a POS → the workshop home. Each step calls [reload] to advance.
class AppGate extends StatefulWidget {
  const AppGate({super.key});

  @override
  State<AppGate> createState() => _AppGateState();
}

class _AppGateState extends State<AppGate> {
  late Future<_Startup> _future;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<_Startup> _load() async {
    final apiUrl = await AppConfig.getApiUrl();
    if (apiUrl.isNotEmpty) AppGraphQL.configure(apiUrl);
    final token = await AppConfig.getAccessToken();
    final posId = await AppConfig.getPosId();
    return _Startup(apiUrl: apiUrl, hasToken: token != null, posId: posId);
  }

  void _reload() => setState(() => _future = _load());

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<_Startup>(
      future: _future,
      builder: (context, snapshot) {
        if (!snapshot.hasData) {
          return const Scaffold(body: Center(child: CircularProgressIndicator()));
        }
        final s = snapshot.data!;
        if (s.apiUrl.isEmpty) {
          return ApiSettingScreen(isStart: true, onSaved: _reload);
        }
        if (!s.hasToken) {
          return LoginScreen(onLoggedIn: _reload);
        }
        if (s.posId == null) {
          return PosSelectionScreen(onSelected: _reload);
        }
        return WorkshopHome(posId: s.posId!, onSignOut: _reload);
      },
    );
  }
}
