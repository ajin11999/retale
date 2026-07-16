/// Raw GraphQL documents for the Stockeeper flows.
///
/// graphql_flutter takes hand-written document strings; these are the only
/// operations the app issues. Deliberately NO commitReceivingCheck — counts
/// stage into the draft check and the commit happens in the web console
/// after freight / cost lines are added to the delivery's cost tree.
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

  // ── Receiving ────────────────────────────────────────────────────────────

  /// Open purchase orders for the receiving list.
  static const openPurchases = '''
    query OpenPurchases {
      purchases(status: open) {
        id snapshotVendorName date
        items { id variantId description qtyOrdered qtyDelivered unitCostMinor }
      }
    }
  ''';

  /// The open draft check for a purchase, or null — the resume path.
  static const openReceivingCheck = '''
    query OpenReceivingCheck(\$purchaseId: ID!) {
      openReceivingCheck(purchaseId: \$purchaseId) {
        id targetLocationId status
      }
    }
  ''';

  /// Start (or resume) the one draft check per purchase; location fixed up front.
  static const startReceivingCheck = '''
    mutation StartReceivingCheck(\$purchaseId: ID!, \$targetLocationId: ID!) {
      startReceivingCheck(purchaseId: \$purchaseId, targetLocationId: \$targetLocationId) {
        id targetLocationId status
      }
    }
  ''';

  /// Every purchase line with ordered / delivered / remaining and the draft qty.
  static const receivingCheckLines = '''
    query ReceivingCheckLines(\$purchaseId: ID!) {
      receivingCheckLines(purchaseId: \$purchaseId) {
        purchaseItem { id variantId description }
        qtyOrdered qtyDelivered remaining qtyInCheck status provisionalStatus
      }
    }
  ''';

  /// Upsert one counted line; qty 0 deletes. Save-as-you-go.
  static const setReceivingCheckLine = '''
    mutation SetReceivingCheckLine(\$deliveryId: ID!, \$purchaseItemId: ID!, \$qty: Float!) {
      setReceivingCheckLine(deliveryId: \$deliveryId, purchaseItemId: \$purchaseItemId, qty: \$qty) {
        id
      }
    }
  ''';

  /// Barcode / SKU / vendor code → the purchase line(s) it counts against.
  static const resolveReceivingScan = '''
    query ResolveReceivingScan(\$purchaseId: ID!, \$code: String!) {
      resolveReceivingScan(purchaseId: \$purchaseId, code: \$code) {
        id
      }
    }
  ''';

  /// Variant labels for purchase lines (PurchaseItem carries no variant label).
  /// Archived products included so old PO lines still resolve.
  static const productLabels = '''
    query ProductLabels {
      products(includeArchived: true) {
        id name
        variants { id sku label barcode unit qtyDecimals }
      }
    }
  ''';

  // ── Transfers ────────────────────────────────────────────────────────────

  static const openTransfers = '''
    query OpenTransfers {
      stockTransfers {
        id sourceLocationId targetLocationId createdAt notes status
        items { id variantId qty }
      }
    }
  ''';

  static const receiveStockTransfer = '''
    mutation ReceiveStockTransfer(\$id: ID!) {
      receiveStockTransfer(id: \$id) {
        id status
      }
    }
  ''';

  // ── Shared ───────────────────────────────────────────────────────────────

  /// Active locations for the picker (receiving target / reconcile scope).
  static const locations = '''
    query Locations {
      locations(includeArchived: false) {
        id name parentId
      }
    }
  ''';

  // ── Reconcile ────────────────────────────────────────────────────────────

  /// Every variant stocked at a location, including zero-onHand rows.
  static const locationStockLevels = '''
    query LocationStockLevels(\$locationId: ID) {
      locationStockLevels(locationId: \$locationId) {
        variantId productId productName sku label barcode unit qtyDecimals onHand
      }
    }
  ''';

  /// Reconcile counted lines to absolute values in one transaction.
  /// Only touched lines are sent; returns how many actually changed.
  static const bulkAdjustStock = '''
    mutation BulkAdjustStock(\$locationId: ID, \$reason: String!, \$lines: [BulkStockCountInput!]!) {
      bulkAdjustStock(locationId: \$locationId, reason: \$reason, lines: \$lines)
    }
  ''';
}
