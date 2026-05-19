import 'package:graphql_flutter/graphql_flutter.dart';

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
    final httpLink = HttpLink(AppConfig.instance.graphqlEndpoint);
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
