import 'package:graphql_flutter/graphql_flutter.dart';
import 'package:jwt_decoder/jwt_decoder.dart';
import 'package:retale_workshop/config.dart';

const _refreshMutation = r'''
  mutation WorkshopRefresh($refreshToken: String!) {
    refreshToken(refreshToken: $refreshToken) {
      accessToken
      refreshToken
    }
  }
''';

/// Keeps the stored access token fresh. Retale access tokens live 60 minutes;
/// the session renews via rotating refresh tokens. The server treats rotation
/// reuse as theft and revokes the session, so refreshes are single-flighted —
/// concurrent requests share one in-flight refresh instead of racing.
class TokenRefresh {
  static Future<void>? _inflight;

  /// Bearer value for the GraphQL AuthLink: refreshes first when the access
  /// token is expired or within 60s of it, then returns whatever is stored.
  static Future<String?> bearerToken() async {
    await (_inflight ??= _ensureFresh().whenComplete(() => _inflight = null));
    return AppConfig.getAccessToken();
  }

  static Future<void> _ensureFresh() async {
    final access = await AppConfig.getAccessToken();
    if (access == null || !_isStale(access)) return;
    final refresh = await AppConfig.getRefreshToken();
    if (refresh == null) return;

    // Bare client, no AuthLink: the refresh mutation authenticates with the
    // refresh token itself, and this avoids recursing into [bearerToken].
    final client = GraphQLClient(
      link: HttpLink(AppConfig.graphqlEndpoint(await AppConfig.getApiUrl())),
      cache: GraphQLCache(),
    );
    final res = await client.mutate(MutationOptions(
      document: gql(_refreshMutation),
      variables: {'refreshToken': refresh},
    ));

    if (res.hasException) {
      // The server rejected the session (expired / revoked / rotation reuse):
      // wipe tokens so the app gate falls back to login. A network failure
      // keeps them — the session may still be fine when connectivity returns.
      if (res.exception!.graphqlErrors.isNotEmpty) {
        await AppConfig.clearTokens();
      }
      return;
    }

    final auth = res.data!['refreshToken'] as Map<String, dynamic>;
    await AppConfig.setTokens(
      auth['accessToken'] as String,
      auth['refreshToken'] as String,
    );
  }

  static bool _isStale(String jwt) {
    try {
      return JwtDecoder.getExpirationDate(jwt)
          .isBefore(DateTime.now().add(const Duration(seconds: 60)));
    } catch (_) {
      return true; // undecodable — treat as stale
    }
  }
}
