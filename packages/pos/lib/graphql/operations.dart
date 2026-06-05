/// Raw GraphQL documents for the POS core flow.
///
/// graphql_flutter (the chosen client) takes hand-written document strings;
/// these are the only operations the POS app issues.
class Ops {
  Ops._();

  static const _authPayload = '''
    accessToken
    refreshToken
    refreshExpiresAt
    user { id username name isRoot }
  ''';

  /// Password login. May return a 2FA challenge instead of tokens.
  static const login = '''
    mutation Login(\$username: String!, \$password: String!) {
      login(username: \$username, password: \$password) {
        requiresTwoFactor
        challengeToken
        auth { $_authPayload }
      }
    }
  ''';

  /// Complete a 2FA login with a TOTP or recovery code.
  static const loginTwoFactor = '''
    mutation LoginTwoFactor(\$challengeToken: String!, \$code: String!) {
      loginTwoFactor(challengeToken: \$challengeToken, code: \$code) {
        $_authPayload
      }
    }
  ''';

  /// Rotate the refresh token for a fresh pair.
  static const refreshToken = '''
    mutation RefreshToken(\$refreshToken: String!) {
      refreshToken(refreshToken: \$refreshToken) {
        $_authPayload
      }
    }
  ''';

  /// Revoke a refresh token. Idempotent.
  static const logout = '''
    mutation Logout(\$refreshToken: String!) {
      logout(refreshToken: \$refreshToken)
    }
  ''';

  /// Every point of sale the device may bind to.
  static const pointsOfSale = '''
    query PointsOfSale {
      pointsOfSale {
        id code name locationId
      }
    }
  ''';

  /// Recent sessions for a POS — used to find the open one, if any.
  static const posSessions = '''
    query PosSessions(\$posId: ID!) {
      posSessions(posId: \$posId, limit: 5) {
        id posId openingCashMinor openedAt closedAt
      }
    }
  ''';

  static const openSession = '''
    mutation OpenSession(\$posId: ID!, \$openingCashMinor: Float!) {
      openSession(posId: \$posId, openingCashMinor: \$openingCashMinor) {
        id posId openingCashMinor openedAt closedAt
      }
    }
  ''';

  static const closeSession = '''
    mutation CloseSession(\$id: ID!, \$closingCashMinor: Float!) {
      closeSession(id: \$id, closingCashMinor: \$closingCashMinor) {
        id closedAt closingCashMinor varianceMinor
      }
    }
  ''';

  /// Product lookup. `search` null returns the whole active catalog — used to
  /// warm the offline cache.
  static const products = '''
    query Products(\$search: String) {
      products(search: \$search) {
        id name publicDisplayName kind costRatioBps
        variants {
          id sku barcode label unit priceMinor costMinor totalQty
        }
      }
    }
  ''';

  /// Orders rung on a POS session, newest first — the register history view.
  static const sessionOrders = '''
    query SessionOrders(\$posSessionId: ID!, \$limit: Int) {
      orders(posSessionId: \$posSessionId, limit: \$limit) {
        id displayNumber status totalMinor createdAt
      }
    }
  ''';

  /// Recent orders across every session — the history view's "All orders"
  /// scope, used to find a sale (often another clerk's) to return against.
  static const recentOrders = '''
    query RecentOrders(\$limit: Int) {
      orders(limit: \$limit) {
        id displayNumber status totalMinor createdAt
      }
    }
  ''';

  /// Full detail of one order — lines and payments — for the detail view.
  /// Carries the attached customer (if any) so a receipt can be sent to them.
  static const orderDetail = '''
    query OrderDetail(\$id: ID!) {
      order(id: \$id) {
        id displayNumber status totalMinor createdAt closedAt returnOfOrderId
        snapshotCustomerName
        customer { id name phone }
        items {
          id displayName qty discountMinor
          snapshotPriceMinor lineTotalMinor voidedAt
        }
        payments { method amountMinor }
      }
    }
  ''';

  /// Name/phone search over active customers, for attaching one to a POS sale.
  static const posCustomerSearch = '''
    query PosCustomerSearch(\$search: String, \$limit: Int) {
      posCustomerSearch(search: \$search, limit: \$limit) {
        id name phone
      }
    }
  ''';

  /// Business name + logo for the receipt header.
  static const businessReceiptInfo = '''
    query BusinessReceiptInfo {
      businessReceiptInfo { name logoUrl }
    }
  ''';

  /// Reverse part of a closed order. Refund as cash or store credit; rung
  /// against the returning clerk's own open session.
  static const createReturn = '''
    mutation CreateReturn(
      \$originalOrderId: ID!,
      \$posSessionId: ID!,
      \$items: [ReturnItemInput!]!,
      \$refundMethod: RefundMethod!
    ) {
      createReturn(
        originalOrderId: \$originalOrderId,
        posSessionId: \$posSessionId,
        items: \$items,
        refundMethod: \$refundMethod
      ) {
        id displayNumber totalMinor
      }
    }
  ''';

  /// Ring an atomic POS sale. Closed on create against an open session.
  static const createPosOrder = '''
    mutation CreatePosOrder(
      \$posSessionId: ID!,
      \$customerId: ID,
      \$items: [PosOrderItemInput!]!,
      \$payments: [PosOrderPaymentInput!]!
    ) {
      createPosOrder(
        posSessionId: \$posSessionId,
        customerId: \$customerId,
        items: \$items,
        payments: \$payments
      ) {
        id displayNumber status totalMinor closedAt
      }
    }
  ''';
}
