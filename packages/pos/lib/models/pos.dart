/// A point of sale — a register the clerk binds this device to.
class PointOfSale {
  PointOfSale({
    required this.id,
    required this.code,
    required this.name,
    required this.locationId,
  });

  final String id;
  final String code;
  final String name;
  final String locationId;

  factory PointOfSale.fromJson(Map<String, dynamic> j) => PointOfSale(
        id: j['id'] as String,
        code: j['code'] as String,
        name: j['name'] as String,
        locationId: j['locationId'] as String,
      );
}

/// A cashier shift. The POS flow needs an open one before it can ring sales.
class PosSession {
  PosSession({
    required this.id,
    required this.posId,
    required this.openingCashMinor,
    required this.openedAt,
    required this.closedAt,
  });

  final String id;
  final String posId;
  final int openingCashMinor;
  final String openedAt;
  final String? closedAt;

  bool get isOpen => closedAt == null;

  factory PosSession.fromJson(Map<String, dynamic> j) => PosSession(
        id: j['id'] as String,
        posId: j['posId'] as String,
        openingCashMinor: (j['openingCashMinor'] as num).round(),
        openedAt: j['openedAt'] as String,
        closedAt: j['closedAt'] as String?,
      );
}
