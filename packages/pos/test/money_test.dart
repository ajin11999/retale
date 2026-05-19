import 'package:flutter_test/flutter_test.dart';
import 'package:retale_pos/models/money.dart';

void main() {
  group('Money', () {
    test('formats minor units as a 2-decimal major amount', () {
      expect(Money.format(12345), '123.45');
      expect(Money.format(0), '0.00');
      expect(Money.format(99), '0.99');
    });

    test('parses a major-unit string back into minor units', () {
      expect(Money.parse('123.45'), 12345);
      expect(Money.parse('  10  '), 1000);
      expect(Money.parse('not a number'), 0);
    });
  });
}
