import 'package:flutter/material.dart';
import 'package:retale_workshop/util/money.dart';

/// One-line cost readout under a price field: "Cost Rp 30.000 · Margin Rp
/// 20.000", recomputed by the caller as the price is typed. The margin amount
/// complements the [MarginPill]'s percentage; the whole line turns the error
/// color when [priceMinor] is below [costMinor]. Mirrors the POS edit-cart
/// dialog's cost/margin preview.
class CostMarginLine extends StatelessWidget {
  const CostMarginLine({
    super.key,
    required this.costMinor,
    required this.priceMinor,
  });

  final int costMinor;
  final int priceMinor;

  @override
  Widget build(BuildContext context) {
    final margin = priceMinor - costMinor;
    final scheme = Theme.of(context).colorScheme;
    return Text(
      'Cost ${formatMinor(costMinor)} · Margin ${formatMinor(margin)}',
      style: TextStyle(
        fontSize: 12,
        color: margin < 0 ? scheme.error : scheme.onSurfaceVariant,
      ),
    );
  }
}

/// Compact margin badge: "32%" in a tinted pill, error-tinted when selling
/// below cost. Renders nothing when [fraction] is null (cost unknown / no
/// price), so callers can always include it unconditionally.
class MarginPill extends StatelessWidget {
  const MarginPill({super.key, required this.fraction});

  /// Per-unit margin as a fraction of price (0.25 = 25%); null hides the pill.
  final double? fraction;

  @override
  Widget build(BuildContext context) {
    final f = fraction;
    if (f == null) return const SizedBox.shrink();
    final scheme = Theme.of(context).colorScheme;
    final negative = f < 0;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        color: negative ? scheme.errorContainer : scheme.secondaryContainer,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        '${(f * 100).round()}%',
        style: TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w600,
          color:
              negative ? scheme.onErrorContainer : scheme.onSecondaryContainer,
        ),
      ),
    );
  }
}
