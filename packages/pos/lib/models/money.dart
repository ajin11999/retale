import 'package:flutter/services.dart';
import 'package:intl/intl.dart';

/// Money helpers. Retale stores every amount as the literal rupiah value with
/// up to 2 decimals (DECIMAL(19,2) on the API; see docs/design-decisions.md).
/// Values flow through the app as `num` — never scaled into "minor units".
class Money {
  Money._();

  /// International number formatting: "," groups thousands, "." is the decimal
  /// mark, trailing zeros trimmed. e.g. 1500000.5 -> "1,500,000.5".
  static final NumberFormat _fmt = NumberFormat('#,##0.##', 'en_US');

  /// Non-grouped form for prefilling editable fields, so it round-trips cleanly
  /// through [parse]. e.g. 75000 -> "75000", 10.5 -> "10.5".
  static final NumberFormat _plain = NumberFormat('0.##', 'en_US');

  /// Format a money value for display, e.g. 75000 -> "75,000", 10.5 -> "10.5".
  static String format(num value) => _fmt.format(value);

  /// Plain (non-grouped) major-unit text for editable fields. e.g. 75000.
  static String editText(num value) => _plain.format(value);

  /// Parse an entered string back into a money value (up to 2 decimals).
  /// Tolerates international grouping, so "1,500,000.5" and "1500000.5" both
  /// yield 1500000.5.
  static num parse(String input) {
    final s = input.trim().replaceAll(',', ''); // drop thousands grouping
    final value = double.tryParse(s) ?? 0;
    return (value * 100).round() / 100; // snap to 2 decimals
  }
}

/// Groups the integer part of a money field with "," thousands separators as the
/// user types, while allowing a single "." decimal point with up to 2 fraction
/// digits ("1500000.5" -> "1,500,000.5"). Output round-trips cleanly through
/// [Money.parse].
class ThousandsSeparatorInputFormatter extends TextInputFormatter {
  ThousandsSeparatorInputFormatter();

  static final NumberFormat _grouped = NumberFormat('#,##0', 'en_US');

  @override
  TextEditingValue formatEditUpdate(
      TextEditingValue oldValue, TextEditingValue newValue) {
    if (newValue.text.isEmpty) return newValue;
    // Keep digits and a single dot; cap the fraction to 2 digits.
    final s = newValue.text.replaceAll(RegExp(r'[^\d.]'), '');
    final dot = s.indexOf('.');
    final hasDot = dot != -1;
    final intPart = (hasDot ? s.substring(0, dot) : s).replaceAll('.', '');
    var frac = hasDot ? s.substring(dot + 1).replaceAll('.', '') : null;
    if (frac != null && frac.length > 2) frac = frac.substring(0, 2);

    final intValue = int.tryParse(intPart);
    if (intPart.isNotEmpty && intValue == null) return oldValue; // not a number
    final groupedInt = intPart.isEmpty ? '' : _grouped.format(intValue);
    final formatted =
        (groupedInt.isEmpty ? '0' : groupedInt) + (frac != null ? '.$frac' : '');
    return TextEditingValue(
      text: formatted,
      // Keep the caret at the end — simplest stable behaviour for a price field
      // that is typically retyped rather than edited mid-string.
      selection: TextSelection.collapsed(offset: formatted.length),
    );
  }
}
