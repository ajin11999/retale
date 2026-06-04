import 'package:graphql_flutter/graphql_flutter.dart';

class PosOption {
  PosOption({required this.id, required this.code, required this.name});
  final String id;
  final String code;
  final String name;

  factory PosOption.fromJson(Map<String, dynamic> j) => PosOption(
        id: j['id'] as String,
        code: j['code'] as String,
        name: j['name'] as String,
      );
}

class PosException implements Exception {
  PosException(this.message);
  final String message;
  @override
  String toString() => message;
}

const _pointsOfSaleQuery = r'''
  query WorkshopPointsOfSale {
    pointsOfSale { id code name }
  }
''';

const _sessionsQuery = r'''
  query WorkshopPosSessions($posId: ID!) {
    posSessions(posId: $posId, limit: 5) { id closedAt }
  }
''';

const _openSessionMutation = r'''
  mutation WorkshopOpenSession($posId: ID!, $openingCashMinor: Float!) {
    openSession(posId: $posId, openingCashMinor: $openingCashMinor) { id }
  }
''';

class PosService {
  PosService(this.client);
  final GraphQLClient client;

  Future<List<PosOption>> listPointsOfSale() async {
    final res = await client.query(QueryOptions(
      document: gql(_pointsOfSaleQuery),
      fetchPolicy: FetchPolicy.networkOnly,
    ));
    _throwIfError(res);
    final rows = (res.data!['pointsOfSale'] as List).cast<Map<String, dynamic>>();
    return rows.map(PosOption.fromJson).toList();
  }

  /// The id of the currently open session on [posId], or null if none is open.
  Future<String?> findOpenSession(String posId) async {
    final res = await client.query(QueryOptions(
      document: gql(_sessionsQuery),
      variables: {'posId': posId},
      fetchPolicy: FetchPolicy.networkOnly,
    ));
    _throwIfError(res);
    final rows = (res.data!['posSessions'] as List).cast<Map<String, dynamic>>();
    for (final s in rows) {
      if (s['closedAt'] == null) return s['id'] as String;
    }
    return null;
  }

  Future<String> openSession(String posId, {int openingCashMinor = 0}) async {
    final res = await client.mutate(MutationOptions(
      document: gql(_openSessionMutation),
      variables: {'posId': posId, 'openingCashMinor': openingCashMinor},
    ));
    _throwIfError(res);
    return res.data!['openSession']['id'] as String;
  }

  /// Find the open session for [posId], or open a fresh one (opening cash 0).
  Future<String> ensureOpenSession(String posId) async {
    return await findOpenSession(posId) ?? await openSession(posId);
  }

  void _throwIfError(QueryResult res) {
    if (res.hasException) {
      final e = res.exception!;
      final gql = e.graphqlErrors.isNotEmpty ? e.graphqlErrors.first.message : null;
      throw PosException(gql ?? e.linkException?.toString() ?? 'POS request failed');
    }
  }
}
