import 'package:flutter_test/flutter_test.dart';
import 'package:retale_pos/models/money.dart';

void main() {
  group('Money', () {
    test('formats the literal rupiah value (international grouping, trimmed)', () {
      expect(Money.format(12345), '12,345');
      expect(Money.format(1500000.5), '1,500,000.5');
      expect(Money.format(10.55), '10.55');
      expect(Money.format(0), '0');
    });

    test('parses an entered string into a money value (≤2 decimals)', () {
      expect(Money.parse('1,234.5'), 1234.5);
      expect(Money.parse('  10  '), 10);
      expect(Money.parse('10.555'), 10.56); // snaps to 2 decimals
      expect(Money.parse('not a number'), 0);
    });
  });
}
