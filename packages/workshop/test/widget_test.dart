import 'package:flutter_test/flutter_test.dart';
import 'package:retale_workshop/schema/project.dart';
import 'package:retale_workshop/util/money.dart';
import 'package:retale_workshop/util/project_calc.dart';

void main() {
  group('money', () {
    test('formats whole-rupiah minor units with id-ID grouping', () {
      expect(formatMinor(150000), 'Rp 150.000');
      expect(formatMinor(0), 'Rp 0');
    });

    test('parses typed amounts (ignoring grouping) to minor units', () {
      expect(parseMinor('150.000'), 150000);
      expect(parseMinor('150000'), 150000);
      expect(parseMinor(''), isNull);
    });
  });

  group('project_calc', () {
    test('totals leaves and recurses into groups; flattens leaves', () {
      final leaf = WorkLine()
        ..variantId = 'v1'
        ..variantKind = 'service'
        ..qty = 2
        ..unitPriceMinor = 5000;
      final grouped = WorkLine()
        ..variantId = 'v2'
        ..variantKind = 'physical'
        ..qty = 3
        ..unitPriceMinor = 1000;
      final group = WorkLine()
        ..isGroup = true
        ..snapshotName = 'Section'
        ..children = [grouped];

      final lines = [leaf, group];
      expect(linesTotalMinor(lines), 2 * 5000 + 3 * 1000);
      expect(flattenLeaves(lines).map((l) => l.variantId), ['v1', 'v2']);
    });

    test('a group with no leaves contributes nothing', () {
      final empty = WorkLine()
        ..isGroup = true
        ..children = <WorkLine>[];
      expect(linesTotalMinor([empty]), 0);
      expect(flattenLeaves([empty]), isEmpty);
    });
  });
}
