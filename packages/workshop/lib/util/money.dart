import 'package:flutter/services.dart';
import 'package:intl/intl.dart';

// Retale money is integer minor units where the minor unit IS the whole rupiah
// (no decimals) — matches the console's money-input / formatMoney. So a price of
// 150000 displays as "Rp 150.000" and is entered by typing "150000".

final NumberFormat _grouped = NumberFormat.decimalPattern('id_ID');

String formatMinor(int minor) => 'Rp ${_grouped.format(minor)}';

/// Grouped digits without the "Rp" prefix, for seeding editable money fields:
/// 150000 → "150.000".
String groupMinor(int minor) => _grouped.format(minor);

/// Parse a user-typed amount (digits, optional grouping dots) into minor units.
/// Returns null when blank.
int? parseMinor(String s) {
  final digits = s.replaceAll(RegExp(r'\D'), '');
  if (digits.isEmpty) return null;
  return int.tryParse(digits);
}

/// Live formatter for money TextFields: keeps only digits and regroups with
/// id-ID thousand dots on every edit (150000 → 150.000), keeping the caret
/// anchored to the digit it was typed after. Replaces
/// [FilteringTextInputFormatter.digitsOnly] on price/amount fields.
class ThousandsInputFormatter extends TextInputFormatter {
  const ThousandsInputFormatter();

  @override
  TextEditingValue formatEditUpdate(
      TextEditingValue oldValue, TextEditingValue newValue) {
    var digits = newValue.text.replaceAll(RegExp(r'\D'), '');
    digits = digits.replaceFirst(RegExp(r'^0+(?=\d)'), '');
    if (digits.isEmpty) return TextEditingValue.empty;

    final grouped = StringBuffer();
    for (var i = 0; i < digits.length; i++) {
      if (i > 0 && (digits.length - i) % 3 == 0) grouped.write('.');
      grouped.write(digits[i]);
    }
    final text = grouped.toString();

    // Re-place the caret after the same count of digits it had to its left.
    final digitsBeforeCaret = newValue.text
        .substring(0, newValue.selection.end.clamp(0, newValue.text.length))
        .replaceAll(RegExp(r'\D'), '')
        .length
        .clamp(0, digits.length);
    var offset = 0;
    var seen = 0;
    while (offset < text.length && seen < digitsBeforeCaret) {
      if (text.codeUnitAt(offset) != 0x2E /* '.' */) seen++;
      offset++;
    }
    return TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: offset),
    );
  }
}
