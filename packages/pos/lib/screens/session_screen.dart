import 'package:flutter/material.dart';

import '../auth/auth_service.dart';
import '../cache/session_store.dart';
import '../config/app_config.dart';
import '../graphql/graphql_service.dart';
import '../graphql/operations.dart';
import '../models/money.dart';
import '../models/pos.dart';
import '../i18n/i18n_service.dart';
import '../widgets/common.dart';
import '../widgets/language_selector_button.dart';
import 'register_screen.dart';
import 'router_screen.dart';

/// Resolves whether the bound POS already has an open session. If it does,
/// jumps straight to the register; otherwise shows the open-shift form.
class SessionGate extends StatefulWidget {
  const SessionGate({super.key});

  @override
  State<SessionGate> createState() => _SessionGateState();
}

class _SessionGateState extends State<SessionGate> {
  late Future<PosSession?> _future;

  @override
  void initState() {
    super.initState();
    _future = _findOpenSession();
  }

  Future<PosSession?> _findOpenSession() async {
    final posId = AppConfig.instance.posId!;
    try {
      final data = await GraphQLService.instance
          .query(Ops.posSessions, variables: {'posId': posId});
      final sessions = (data['posSessions'] as List<dynamic>)
          .map((s) => PosSession.fromJson(s as Map<String, dynamic>));
      PosSession? open;
      for (final s in sessions) {
        if (s.isOpen) {
          open = s;
          break;
        }
      }
      // The server is reachable, so it is authoritative: cache the open shift so
      // the register can resume offline next time, or drop a stale cache when
      // the server reports none is open.
      if (open != null) {
        await SessionStore.instance.save(posId, open);
      } else {
        await SessionStore.instance.clear(posId);
      }
      return open;
    } on GraphQLAppException catch (e) {
      if (!e.isNetworkError) rethrow;
      // A rejected refresh token also surfaces as a network error here, but it
      // has already cleared the auth and redirected to login — don't resurrect
      // the register from cache in that case.
      if (!AuthService.instance.isAuthenticated) rethrow;
      // Offline: fall back to the last shift the server told us was open, so the
      // cashier reaches the register and keeps ringing into the offline queue.
      return SessionStore.instance.load(posId);
    }
  }

  Future<void> _signOut() async {
    await AuthService.instance.logout();
    if (mounted) RouterScreen.goHome(context);
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<PosSession?>(
      future: _future,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Scaffold(
              body: Center(child: CircularProgressIndicator()));
        }
        if (snapshot.hasError) {
          return Scaffold(
            body: ErrorRetry(
              message: describeError(snapshot.error!),
              onRetry: () =>
                  setState(() => _future = _findOpenSession()),
              onSignOut: _signOut,
            ),
          );
        }
        final session = snapshot.data;
        if (session != null) {
          return RegisterScreen(session: session);
        }
        return const OpenSessionScreen();
      },
    );
  }
}

/// Form to open a cashier shift with a counted opening float.
class OpenSessionScreen extends StatefulWidget {
  const OpenSessionScreen({super.key});

  @override
  State<OpenSessionScreen> createState() => _OpenSessionScreenState();
}

class _OpenSessionScreenState extends State<OpenSessionScreen> {
  final _cash = TextEditingController(text: '0');
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _cash.dispose();
    super.dispose();
  }

  Future<void> _open() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final data = await GraphQLService.instance.mutate(
        Ops.openSession,
        variables: {
          'posId': AppConfig.instance.posId,
          'openingCashMinor': Money.parse(_cash.text),
        },
      );
      final session =
          PosSession.fromJson(data['openSession'] as Map<String, dynamic>);
      // Cache the freshly-opened shift so a restart before the next online
      // SessionGate query can still resume the register offline.
      await SessionStore.instance.save(AppConfig.instance.posId!, session);
      if (mounted) {
        Navigator.of(context).pushReplacement(MaterialPageRoute(
          builder: (_) => RegisterScreen(session: session),
        ));
      }
    } on GraphQLAppException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(tr('session.title')),
        actions: const [
          LanguageSelectorButton(iconOnly: true),
        ],
      ),
      body: Center(
        child: SizedBox(
          width: 320,
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(tr('session.enterOpeningCash')),
              const SizedBox(height: 16),
              TextField(
                controller: _cash,
                keyboardType: TextInputType.number,
                inputFormatters: [ThousandsSeparatorInputFormatter()],
                decoration: InputDecoration(
                  labelText: tr('session.openingCash'),
                  border: const OutlineInputBorder(),
                ),
              ),
              if (_error != null) ...[
                const SizedBox(height: 12),
                Text(_error!, style: const TextStyle(color: Colors.red)),
              ],
              const SizedBox(height: 16),
              FilledButton(
                onPressed: _busy ? null : _open,
                child: _busy
                    ? const SizedBox(
                        height: 18,
                        width: 18,
                        child: CircularProgressIndicator(strokeWidth: 2))
                    : Text(tr('session.openShift')),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
