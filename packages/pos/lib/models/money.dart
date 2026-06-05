import 'package:intl/intl.dart';

/// Money helpers. Retale stores every amount as an integer count of minor
/// units (see docs/design-decisions.md). The display divisor below assumes a
/// 0-decimal currency (IDR); change [minorPerMajor] for a currency with cents.
class Money {
  Money._();

  /// Minor units per major unit. IDR has no minor unit, so 1. Set to 100 for a
  /// 2-decimal currency (cents).
  static const int minorPerMajor = 1;

  /// id-ID number formatting: "." groups thousands, "," is the decimal mark.
  /// With [minorPerMajor] == 1 there are no decimals, so 75000 -> "75.000".
  static final NumberFormat _fmt =
      NumberFormat('#,##0${minorPerMajor > 1 ? '.00' : ''}', 'id_ID');

  /// Format minor units for display, e.g. 75000 -> "75.000".
  static String format(num minor) => _fmt.format(minor / minorPerMajor);

  /// Plain (non-grouped) major-unit text for prefilling editable fields, so it
  /// round-trips cleanly through [parse]. e.g. 75000 -> "75000".
  static String editText(num minor) {
    final major = minor / minorPerMajor;
    return minorPerMajor > 1 ? major.toStringAsFixed(2) : major.round().toString();
  }

  /// Parse a major-unit string back into minor units. Tolerates id-ID grouping,
  /// so both "75000" and "75.000" yield 75000.
  static int parse(String major) {
    var s = major.trim().replaceAll('.', ''); // drop thousands grouping
    s = s.replaceAll(',', '.'); // id-ID decimal mark -> parseable
    final value = double.tryParse(s) ?? 0;
    return (value * minorPerMajor).round();
  }
}
