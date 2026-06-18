import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:retale_workshop/schema/project.dart';
import 'package:retale_workshop/util/money.dart';
import 'package:retale_workshop/util/project_calc.dart';

void main() {
  group('money', () {
    test('formats rupiah with comma grouping and up to 2 decimals', () {
      expect(formatMinor(150000), 'Rp 150,000');
      expect(formatMinor(150000.5), 'Rp 150,000.5');
      expect(formatMinor(150000.55), 'Rp 150,000.55');
      expect(formatMinor(0), 'Rp 0');
    });

    test('parses typed amounts (dropping grouping) to rupiah values', () {
      expect(parseMinor('150,000'), 150000);
      expect(parseMinor('150000'), 150000);
      expect(parseMinor('1,500.50'), 1500.5);
      expect(parseMinor('10.'), 10); // mid-entry trailing dot
      expect(parseMinor(''), isNull);
    });
  });

  group('MoneyInputFormatter', () {
    TextEditingValue fmt(String text, int caret) =>
        const MoneyInputFormatter().formatEditUpdate(
          TextEditingValue.empty,
          TextEditingValue(
              text: text, selection: TextSelection.collapsed(offset: caret)),
        );

    test('comma-groups digits as typed and keeps the caret at the end', () {
      final v = fmt('150000', 6);
      expect(v.text, '150,000');
      expect(v.selection.baseOffset, 7);
    });

    test('mid-string insert keeps the caret anchored to its digit', () {
      // '159|0000' (just typed the 9) regroups to '1,59|0,000'.
      final v = fmt('1590000', 3);
      expect(v.text, '1,590,000');
      expect(v.selection.baseOffset, 4);
    });

    test('keeps one dot decimal, capped at 2 fraction digits', () {
      expect(fmt('1500.5', 6).text, '1,500.5');
      expect(fmt('1500.567', 8).text, '1,500.56');
      expect(fmt('10.', 3).text, '10.'); // trailing dot kept mid-entry
    });

    test('strips other punctuation and leading zeros; blank stays blank', () {
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
