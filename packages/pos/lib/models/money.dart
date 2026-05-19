import 'package:intl/intl.dart';

/// Money helpers. Retale stores every amount as an integer count of minor
/// units (see docs/design-decisions.md). The display divisor below assumes a
/// 2-decimal currency; change [minorPerMajor] for a 0-decimal currency.
class Money {
  Money._();

  /// Minor units per major unit (100 = cents). Set to 1 for IDR-style.
  static const int minorPerMajor = 100;

  static final NumberFormat _fmt = NumberFormat('#,##0.00');

  /// Format minor units for display, e.g. 12345 -> "123.45".
  static String format(num minor) =>
      _fmt.format(minor / minorPerMajor);

  /// Parse a major-unit string ("123.45") back into minor units (12345).
  static int parse(String major) {
    final value = double.tryParse(major.trim()) ?? 0;
    return (value * minorPerMajor).round();
  }
}
