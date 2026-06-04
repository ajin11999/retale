import 'package:flutter/foundation.dart';
import 'package:graphql_flutter/graphql_flutter.dart';
import 'package:retale_workshop/config.dart';

/// Builds the [GraphQLClient] for a given API base URL. The auth link reads the
/// access token from secure storage on every request, so the same client keeps
/// working across login/logout without a rebuild — only a base-URL change needs
/// a new client.
GraphQLClient buildClient(String apiUrl) {
  final httpLink = HttpLink(AppConfig.graphqlEndpoint(apiUrl));

  final authLink = AuthLink(
    getToken: () async {
      final token = await AppConfig.getAccessToken();
      return token == null ? null : 'Bearer $token';
    },
  );

  return GraphQLClient(
    link: authLink.concat(httpLink),
    // No persisted normalized cache: workshop reads are live one-shots and the
    // source of truth is the local Isar store, not the GraphQL cache.
    cache: GraphQLCache(),
    defaultPolicies: DefaultPolicies(
      query: Policies(fetch: FetchPolicy.networkOnly),
      mutate: Policies(fetch: FetchPolicy.networkOnly),
    ),
  );
}

/// A reconfigurable client holder for [GraphQLProvider]. Call [configure] after
/// the API URL is known or changes.
class AppGraphQL {
  static final ValueNotifier<GraphQLClient> notifier =
      ValueNotifier<GraphQLClient>(buildClient(''));

  static void configure(String apiUrl) {
    notifier.value = buildClient(apiUrl);
  }
}
