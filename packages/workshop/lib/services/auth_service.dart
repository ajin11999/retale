import 'package:graphql_flutter/graphql_flutter.dart';
import 'package:retale_workshop/config.dart';

/// Outcome of a password login: either complete (tokens stored) or a pending
/// 2FA challenge the caller must finish with [AuthService.loginTwoFactor].
class LoginOutcome {
  LoginOutcome.done()
      : requiresTwoFactor = false,
        challengeToken = null;
  LoginOutcome.twoFactor(this.challengeToken) : requiresTwoFactor = true;

  final bool requiresTwoFactor;
  final String? challengeToken;
}

class AuthException implements Exception {
  AuthException(this.message);
  final String message;
  @override
  String toString() => message;
}

const _loginMutation = r'''
  mutation WorkshopLogin($username: String!, $password: String!) {
    login(username: $username, password: $password) {
      requiresTwoFactor
      challengeToken
      auth { accessToken refreshToken }
    }
  }
''';

const _loginTwoFactorMutation = r'''
  mutation WorkshopLoginTwoFactor($challengeToken: String!, $code: String!) {
    loginTwoFactor(challengeToken: $challengeToken, code: $code) {
      accessToken
      refreshToken
    }
  }
''';

class AuthService {
  AuthService(this.client);
  final GraphQLClient client;

  Future<LoginOutcome> login(String username, String password) async {
    final res = await client.mutate(MutationOptions(
      document: gql(_loginMutation),
      variables: {'username': username, 'password': password},
    ));
    _throwIfError(res);

    final login = res.data!['login'] as Map<String, dynamic>;
    if (login['requiresTwoFactor'] == true) {
      return LoginOutcome.twoFactor(login['challengeToken'] as String);
    }
    await _storeAuth(login['auth'] as Map<String, dynamic>);
    return LoginOutcome.done();
  }

  Future<void> loginTwoFactor(String challengeToken, String code) async {
    final res = await client.mutate(MutationOptions(
      document: gql(_loginTwoFactorMutation),
      variables: {'challengeToken': challengeToken, 'code': code},
    ));
    _throwIfError(res);
    await _storeAuth(res.data!['loginTwoFactor'] as Map<String, dynamic>);
  }

  Future<void> _storeAuth(Map<String, dynamic> auth) async {
    await AppConfig.setTokens(
      auth['accessToken'] as String,
      auth['refreshToken'] as String,
    );
  }

  void _throwIfError(QueryResult res) {
    if (res.hasException) {
      final e = res.exception!;
      final gql = e.graphqlErrors.isNotEmpty ? e.graphqlErrors.first.message : null;
      throw AuthException(gql ?? e.linkException?.toString() ?? 'Login failed');
    }
  }
}
