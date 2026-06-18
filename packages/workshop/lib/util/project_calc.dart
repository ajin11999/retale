import 'package:retale_workshop/schema/project.dart';

/// Recursively sum a line tree: a leaf contributes `qty × unitPriceMinor`, a
/// group contributes the sum of its children. Groups are organisational only.
int linesTotalMinor(List<WorkLine>? lines) {
  if (lines == null) return 0;
  var sum = 0;
  for (final l in lines) {
    if (l.isGroup) {
      sum += linesTotalMinor(l.children);
    } else {
      sum += l.qty * l.unitPriceMinor;
    }
  }
  return sum;
}

int paymentsTotalMinor(List<WorkPayment>? payments) {
  if (payments == null) return 0;
  return payments.fold(0, (sum, p) => sum + p.amountMinor);
}

int remainingMinor(Project p) =>
    linesTotalMinor(p.lines) - paymentsTotalMinor(p.payments);

/// Margin math over a [WorkLine]'s cost snapshot. Lives here (not on the model
/// class) so the computed values stay out of the stored document.
extension WorkLineMargin on WorkLine {
  /// Per-unit cost at a hypothetical [priceMinor]: open-price lines derive
  /// cost from the price via the snapshotted ratio (the API's snapshot rule);
  /// everything else uses the cost captured at pick time. Null when the line
  /// predates cost snapshots.
  int? unitCostAt(int priceMinor) {
    final ratio = costRatioBps;
    if (variantKind == 'open_price' && ratio != null) {
      return (priceMinor * ratio / 10000).round();
    }
    return unitCostMinor;
  }

  /// Per-unit margin as a fraction of unit price (0.25 = 25%). Null when the
  /// cost is unknown or there is no price to measure against.
  double? get marginFraction {
    final cost = unitCostAt(unitPriceMinor);
    if (cost == null || unitPriceMinor <= 0) return null;
    return (unitPriceMinor - cost) / unitPriceMinor;
  }
}

/// All leaf (non-group) lines anywhere in the tree, depth-first — the flattened
/// form submitted to the API.
List<WorkLine> flattenLeaves(List<WorkLine>? lines) {
  final out = <WorkLine>[];
  void walk(List<WorkLine>? ls) {
    if (ls == null) return;
    for (final l in ls) {
      if (l.isGroup) {
        walk(l.children);
      } else if (l.variantId != null) {
        out.add(l);
      }
    }
  }

  walk(lines);
  return out;
}
