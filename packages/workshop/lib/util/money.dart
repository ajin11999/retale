import 'package:flutter/services.dart';
import 'package:intl/intl.dart';

// Retale money is the literal rupiah value (DECIMAL(19,2) on the API), carried
// here as a plain double up to 2 decimal places — the `*Minor` field names are
// legacy, the value is NOT scaled. Entry/format mirror the console's
// money-input: international grouping — comma thousands, dot decimal — so a
// price of 150000.5 displays as "Rp 150,000.5" and is typed as "150000.5".

final NumberFormat _grouped = NumberFormat('#,##0.##', 'en_US');

String formatMinor(num minor) => 'Rp ${_grouped.format(minor)}';

/// Grouped value without the "Rp" prefix, for seeding editable money fields:
/// 150000 → "150,000", 150000.5 → "150,000.5". Matches what
/// [MoneyInputFormatter] produces, so a seeded field stays stable on first edit.
String groupMinor(num minor) => _grouped.format(minor);

/// Parse a user-typed/grouped amount ("150,000.5") into a rupiah value.
/// Returns null when blank.
double? parseMinor(String s) {
  // Drop grouping commas and any stray non-money characters; keep digits + dot.
  var cleaned = s.replaceAll(RegExp(r'[^\d.]'), '');
  // Tolerate a mid-entry trailing dot ("10." while typing the fraction).
  if (cleaned.endsWith('.')) cleaned = cleaned.substring(0, cleaned.length - 1);
  if (cleaned.isEmpty) return null;
  return double.tryParse(cleaned);
}

/// Live formatter for money TextFields: international grouping as you type —
/// comma thousands, dot decimal — keeping at most one decimal point and capping
/// the fraction to 2 digits (150000.5 → "150,000.5"). The caret stays anchored
/// to the digit it was typed after. Mirrors the console's money-input so money
/// entry is consistent across the product. Replaces
/// [FilteringTextInputFormatter.digitsOnly] on price/amount fields.
class MoneyInputFormatter extends TextInputFormatter {
  const MoneyInputFormatter();

  @override
  TextEditingValue formatEditUpdate(
      TextEditingValue oldValue, TextEditingValue newValue) {
    final raw = newValue.text;
    final caret = newValue.selection.end.clamp(0, raw.length);
    // Count significant chars (digits + dot) left of the caret, to re-anchor it
    // after separators shift.
    final keptLeft =
        RegExp(r'[\d.]').allMatches(raw.substring(0, caret)).length;

    final text = _format(raw);
    if (text.isEmpty) return TextEditingValue.empty;

    final offset = _caretAfter(text, keptLeft);
    return TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: offset),
    );
  }

  /// Normalize raw input to "1,234.5" form: one decimal point, ≤2 fraction
  /// digits, comma-grouped integer part. A lone/leading dot keeps the "0."
  /// prefix so the fraction can be typed.
  static String _format(String raw) {
    final s = raw.replaceAll(RegExp(r'[^\d.]'), '');
    final dot = s.indexOf('.');
    final hasDot = dot != -1;
    var intPart = (hasDot ? s.substring(0, dot) : s).replaceAll('.', '');
    intPart = intPart.replaceFirst(RegExp(r'^0+(?=\d)'), '');
    var frac = hasDot ? s.substring(dot + 1).replaceAll('.', '') : null;
    if (frac != null && frac.length > 2) frac = frac.substring(0, 2);

    final groupedInt = intPart.isEmpty ? '' : _group(intPart);
    if (groupedInt.isEmpty && frac == null) return '';
    final intText = groupedInt.isEmpty ? '0' : groupedInt;
    return frac != null ? '$intText.$frac' : intText;
  }

  /// Comma-group a plain digit string: "150000" → "150,000".
  static String _group(String digits) {
    final buf = StringBuffer();
    for (var i = 0; i < digits.length; i++) {
      if (i > 0 && (digits.length - i) % 3 == 0) buf.write(',');
      buf.write(digits[i]);
    }
    return buf.toString();
  }

  /// Caret index just past the [keptLeft]-th significant char (digit or dot) of
  /// [text], so the cursor stays put as separators shift around it.
  static int _caretAfter(String text, int keptLeft) {
    if (keptLeft == 0) return 0;
    var seen = 0;
    for (var i = 0; i < text.length; i++) {
      final c = text.codeUnitAt(i);
      final isSig = (c >= 0x30 && c <= 0x39) || c == 0x2E; // digit or '.'
      if (isSig && ++seen == keptLeft) return i + 1;
    }
    return text.length;
  }
}
