import 'package:graphql_flutter/graphql_flutter.dart';
import 'package:retale_workshop/schema/project.dart';
import 'package:retale_workshop/services/pos_service.dart';
import 'package:retale_workshop/util/project_calc.dart';

class OrderException implements Exception {
  OrderException(this.message);
  final String message;
  @override
  String toString() => message;
}

const _createPosOrderMutation = r'''
  mutation WorkshopCreatePosOrder(
    $posSessionId: ID!
    $items: [PosOrderItemInput!]!
    $payments: [PosOrderPaymentInput!]!
  ) {
    createPosOrder(posSessionId: $posSessionId, items: $items, payments: $payments) {
      id
    }
  }
''';

/// Submits a fully-paid workshop job to Retale as one walk-in POS order.
class OrderService {
  OrderService(this.client);
  final GraphQLClient client;

  /// Build the `PosOrderItemInput` list from a job's flattened leaves. Every
  /// leaf sends its sheet price as `priceOverrideMinor` so the API total always
  /// matches the job sheet — except bundles, where the API rejects overrides
  /// and prices from the catalog.
  List<Map<String, dynamic>> _buildItems(Project project) {
    final leaves = flattenLeaves(project.lines);
    return [
      for (final l in leaves)
        {
          'variantId': l.variantId,
          'qty': l.qty,
          if (l.variantKind != 'bundle') 'priceOverrideMinor': l.unitPriceMinor,
        },
    ];
  }

  /// Ensure an open session, then create the order. Returns the new order id.
  /// Throws [OrderException] / [PosException] with a readable message on failure.
  Future<String> submit({
    required Project project,
    required String posId,
  }) async {
    final items = _buildItems(project);
    if (items.isEmpty) {
      throw OrderException('Nothing to submit — the job has no stock/service lines.');
    }

    final sessionId = await PosService(client).ensureOpenSession(posId);
    final total = linesTotalMinor(project.lines);

    final res = await client.mutate(MutationOptions(
      document: gql(_createPosOrderMutation),
      variables: {
        'posSessionId': sessionId,
        'items': items,
        // Walk-in: must be fully paid. We settle the full total as one cash
        // payment; the local deposit history stays on the device.
        'payments': [
          {'method': 'cash', 'amountMinor': total},
        ],
      },
    ));

    if (res.hasException) {
      final e = res.exception!;
      final gql = e.graphqlErrors.isNotEmpty ? e.graphqlErrors.first.message : null;
      throw OrderException(gql ?? e.linkException?.toString() ?? 'Submit failed');
    }
    return res.data!['createPosOrder']['id'] as String;
  }
}
