import 'package:intl/intl.dart';

// Retale money is integer minor units where the minor unit IS the whole rupiah
// (no decimals) — matches the console's money-input / formatMoney. So a price of
// 150000 displays as "Rp 150.000" and is entered by typing "150000".

final NumberFormat _grouped = NumberFormat.decimalPattern('id_ID');

String formatMinor(int minor) => 'Rp ${_grouped.format(minor)}';

/// Parse a user-typed amount (digits, optional grouping dots) into minor units.
/// Returns null when blank.
int? parseMinor(String s) {
  final digits = s.replaceAll(RegExp(r'\D'), '');
  if (digits.isEmpty) return null;
  return int.tryParse(digits);
}
