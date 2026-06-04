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
