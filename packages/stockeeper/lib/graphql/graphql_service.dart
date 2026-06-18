import 'dart:io';

import 'package:flutter/services.dart' show rootBundle;
import 'package:graphql_flutter/graphql_flutter.dart';
import 'package:http/io_client.dart';

import '../config/app_config.dart';

/// Thrown when a GraphQL operation fails — network error or server `errors[]`.
class GraphQLAppException implements Exception {
  GraphQLAppException(this.message, {this.isNetworkError = false});
  final String message;
  final bool isNetworkError;
  @override
  String toString() => message;
}

/// Wraps a [GraphQLClient] and centralises auth + error handling.
///
/// The client is rebuilt whenever the API URL changes. Token injection is
/// delegated to [tokenProvider], wired up by `main()` so this file does not
/// import the auth layer (avoids an import cycle).
class GraphQLService {
  GraphQLService._();
  static final GraphQLService instance = GraphQLService._();

  /// Returns a bearer token (already refreshed if needed), or null if anon.
  Future<String?> Function()? tokenProvider;

  /// TLS context that trusts the bundled Caddy local-CA root on top of the
  /// system roots. Null until [loadTrustedCertificate] runs.
  SecurityContext? _securityContext;

  /// Load the bundled Caddy local-CA root into a [SecurityContext]. Call once
  /// at startup, before the first [rebuild].
  ///
  /// The prod API is served by Caddy's self-signed local CA over HTTPS. Dart's
  /// `HttpClient` (which graphql_flutter uses via `package:http`) verifies TLS
  /// with BoringSSL against its own trust store — it does NOT consult Android's
  /// `network_security_config.xml` or user-installed CAs. So the only way to
  /// make the app accept Caddy's cert is to add the CA to the SecurityContext
  /// here. `withTrustedRoots: true` keeps the system roots too, so a real cert
  /// (or plain-HTTP dev) keeps working.
  Future<void> loadTrustedCertificate() async {
    final caBytes = await rootBundle.load('assets/retale_ca.crt');
    final context = SecurityContext(withTrustedRoots: true);
    context.setTrustedCertificatesBytes(caBytes.buffer.asUint8List());
    _securityContext = context;
  }

  GraphQLClient? _client;
  GraphQLClient get client {
    final c = _client;
    if (c == null) {
      throw StateError('GraphQLService.rebuild() not called yet');
    }
    return c;
  }

  /// (Re)build the client against the current [AppConfig] endpoint.
  void rebuild() {
    final ioClient = IOClient(HttpClient(context: _securityContext));
    final httpLink = HttpLink(
      AppConfig.instance.graphqlEndpoint,
      httpClient: ioClient,
    );
    final authLink = AuthLink(getToken: () async {
      final token = await tokenProvider?.call();
      return token == null ? null : 'Bearer $token';
    });
    _client = GraphQLClient(
      link: authLink.concat(httpLink),
      cache: GraphQLCache(store: InMemoryStore()),
      defaultPolicies: DefaultPolicies(
        query: Policies(fetch: FetchPolicy.networkOnly),
        mutate: Policies(fetch: FetchPolicy.networkOnly),
      ),
    );
  }

  /// Run a query, returning the `data` map. Throws [GraphQLAppException].
  Future<Map<String, dynamic>> query(
    String document, {
    Map<String, dynamic> variables = const {},
  }) async {
    final result = await client.query(QueryOptions(
      document: gql(document),
      variables: variables,
      fetchPolicy: FetchPolicy.networkOnly,
    ));
    return _unwrap(result);
  }

  /// Run a mutation, returning the `data` map. Throws [GraphQLAppException].
  Future<Map<String, dynamic>> mutate(
    String document, {
    Map<String, dynamic> variables = const {},
  }) async {
    final result = await client.mutate(MutationOptions(
      document: gql(document),
      variables: variables,
    ));
    return _unwrap(result);
  }

  Map<String, dynamic> _unwrap(QueryResult result) {
    if (result.hasException) {
      final ex = result.exception!;
      if (ex.linkException != null) {
        throw GraphQLAppException(
          'Cannot reach the server. Check the connection.',
          isNetworkError: true,
        );
      }
      final msg = ex.graphqlErrors.isNotEmpty
          ? ex.graphqlErrors.map((e) => e.message).join('; ')
          : 'Unknown server error';
      throw GraphQLAppException(msg);
    }
    return result.data ?? const <String, dynamic>{};
  }
}
