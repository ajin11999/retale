import 'package:flutter_test/flutter_test.dart';
import 'package:retale_stockeeper/voice/voice_quantity_parser.dart';

void main() {
  group('VoiceQuantityParser', () {
    test('parses plain digits and zero', () {
      expect(VoiceQuantityParser.parse('0', qtyDecimals: 0).value, 0);
      expect(VoiceQuantityParser.parse('12', qtyDecimals: 0).value, 12);
      expect(VoiceQuantityParser.parse('1,000', qtyDecimals: 0).value, 1000);
      expect(VoiceQuantityParser.parse('24.', qtyDecimals: 0).value, 24);
    });

    test('parses English number words', () {
      expect(VoiceQuantityParser.parse('zero', qtyDecimals: 0).value, 0);
      expect(VoiceQuantityParser.parse('twelve', qtyDecimals: 0).value, 12);
      expect(
          VoiceQuantityParser.parse('twenty five', qtyDecimals: 0).value, 25);
      expect(
          VoiceQuantityParser.parse('twenty-five', qtyDecimals: 0).value, 25);
      expect(
          VoiceQuantityParser.parse('a hundred', qtyDecimals: 0).value, 100);
      expect(
        VoiceQuantityParser.parse('one hundred and twenty', qtyDecimals: 0)
            .value,
        120,
      );
      expect(
        VoiceQuantityParser.parse('two thousand five hundred', qtyDecimals: 0)
            .value,
        2500,
      );
    });

    test('strips common filler and unit words', () {
      expect(
          VoiceQuantityParser.parse('set 15', qtyDecimals: 0).value, 15);
      expect(
        VoiceQuantityParser.parse('count twenty four pieces', qtyDecimals: 0)
            .value,
        24,
      );
      expect(
          VoiceQuantityParser.parse('qty is 8 pcs', qtyDecimals: 0).value, 8);
      expect(
          VoiceQuantityParser.parse('set to 1,200 units', qtyDecimals: 0)
              .value,
          1200);
    });

    test('handles decimals when qtyDecimals > 0 and rejects when 0', () {
      expect(VoiceQuantityParser.parse('2.5', qtyDecimals: 1).value, 2.5);
      expect(
        VoiceQuantityParser.parse('two point five', qtyDecimals: 1).value,
        2.5,
      );
      expect(
        VoiceQuantityParser.parse('zero point zero five', qtyDecimals: 2).value,
        0.05,
      );
      expect(
        VoiceQuantityParser.parse('point five', qtyDecimals: 1).value,
        0.5,
      );

      final wholeOnly =
          VoiceQuantityParser.parse('two point five', qtyDecimals: 0);
      expect(wholeOnly.isSuccess, isFalse);

      final tooManyDecimals =
          VoiceQuantityParser.parse('2.25', qtyDecimals: 1);
      expect(tooManyDecimals.isSuccess, isFalse);
    });

    test('rejects empty, negative, non-numeric, and ambiguous utterances', () {
      expect(VoiceQuantityParser.parse('   ', qtyDecimals: 0).isSuccess,
          isFalse);
      expect(VoiceQuantityParser.parse('-5', qtyDecimals: 0).isSuccess,
          isFalse);
      expect(VoiceQuantityParser.parse('minus 3', qtyDecimals: 0).isSuccess,
          isFalse);
      expect(
          VoiceQuantityParser.parse('hello world', qtyDecimals: 0).isSuccess,
          isFalse);
      expect(VoiceQuantityParser.parse('ten twenty', qtyDecimals: 0).isSuccess,
          isFalse);
      expect(VoiceQuantityParser.parse('10 20', qtyDecimals: 0).isSuccess,
          isFalse);
    });
  });
}
