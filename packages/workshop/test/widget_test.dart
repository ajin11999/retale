import 'package:flutter/services.dart';
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

  group('ThousandsInputFormatter', () {
    TextEditingValue fmt(String text, int caret) =>
        const ThousandsInputFormatter().formatEditUpdate(
          TextEditingValue.empty,
          TextEditingValue(
              text: text, selection: TextSelection.collapsed(offset: caret)),
        );

    test('groups digits as typed and keeps the caret at the end', () {
      final v = fmt('150000', 6);
      expect(v.text, '150.000');
      expect(v.selection.baseOffset, 7);
    });

    test('mid-string insert keeps the caret anchored to its digit', () {
      // '159|0000' (just typed the 9) regroups to '1.59|0.000'.
      final v = fmt('1590000', 3);
      expect(v.text, '1.590.000');
      expect(v.selection.baseOffset, 4);
    });

    test('strips non-digits and leading zeros; blank stays blank', () {
      expect(fmt('0042', 4).text, '42');
      expect(fmt('12a3', 4).text, '123');
      expect(fmt('', 0).text, '');
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
