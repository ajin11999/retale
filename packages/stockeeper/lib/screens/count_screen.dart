import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../widgets/common.dart';

/// What the count screen is counting and where the result goes.
class CountTarget {
  CountTarget({
    required this.title,
    this.titleWidget,
    required this.expected,
    required this.initial,
    required this.allowOverage,
    required this.qtyDecimals,
    required this.onSet,
  });

  final String title;
  final Widget? titleWidget;
  final num expected;
  final num initial;

  /// Receiving false (clamped at expected), reconcile true (amber past it).
  final bool allowOverage;

  /// Receiving 0 (server-enforced integers); reconcile per-variant.
  final int qtyDecimals;

  /// Persist an absolute qty. Throw to reject — the screen keeps the old
  /// value and shows the error.
  final Future<void> Function(num qty) onSet;
}

/// Full-screen counter: huge current/expected headline, +1/+5/+10 buttons,
/// −1, and a custom-step field that adds a box/carton qty at once (e.g. type
/// 12, then every tap on the +12 button adds a box of 12). Shared by
/// receiving and reconcile.
class CountScreen extends StatefulWidget {
  const CountScreen({super.key, required this.target});

  final CountTarget target;

  @override
  State<CountScreen> createState() => _CountScreenState();
}

class _CountScreenState extends State<CountScreen> {
  late num _current = widget.target.initial;
  final _custom = TextEditingController();
  num? _customStep;
  bool _busy = false;
  num? _pendingNext;
  num? _revertTo;

  @override
  void initState() {
    super.initState();
    _custom.addListener(_onCustomChanged);
  }

  @override
  void dispose() {
    _custom.dispose();
    super.dispose();
  }

  /// Tracks the typed custom step so the +N button label stays in sync.
  /// Resets every time the counter opens — nothing is remembered.
  void _onCustomChanged() {
    final step = num.tryParse(_custom.text.trim());
    final valid = step == null || step <= 0 ? null : step;
    if (valid != _customStep) setState(() => _customStep = valid);
  }

  String _fmt(num v) =>
      v == v.truncate() ? v.toInt().toString() : v.toString();

  Future<void> _set(num next) async {
    final t = widget.target;
    if (next < 0) next = 0;
    if (!t.allowOverage && next > t.expected) {
      next = t.expected;
      if (next == _current) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Cannot count more than is expected')));
        return;
      }
    }
    if (next == _current) return;

    _revertTo ??= _current;

    setState(() => _current = next);

    _pendingNext = next;
    if (_busy) return;

    _busy = true;

    while (_pendingNext != null) {
      final toSet = _pendingNext!;
      _pendingNext = null;

      try {
        await t.onSet(toSet);
        if (_pendingNext == null) {
          _revertTo = null;
        }
      } catch (e) {
        if (!mounted) return;
        if (_pendingNext == null) {
          final revert = _revertTo;
          _revertTo = null;
          if (revert != null) {
            setState(() => _current = revert);
          }
          ScaffoldMessenger.of(context)
              .showSnackBar(SnackBar(content: Text(describeError(e))));
        }
      }
    }

    if (mounted) {
      _busy = false;
    }
  }

  /// Adds the typed custom step (a box/carton qty) on top of the current
  /// count — an increment, not an absolute set. Clamping to `expected`
  /// follows the same rule as the fixed step buttons.
  Future<void> _addCustom() async {
    final step = _customStep;
    if (step == null) return;
    FocusScope.of(context).unfocus();
    await _set(_current + step);
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.target;
    final scheme = Theme.of(context).colorScheme;
    final over = _current > t.expected;
    final progress =
        t.expected <= 0 ? 0.0 : (_current / t.expected).clamp(0.0, 1.0);
    return Scaffold(
      appBar: AppBar(title: t.titleWidget ?? Text(t.title, maxLines: 2)),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Spacer(),
              Text.rich(
                TextSpan(children: [
                  TextSpan(
                    text: _fmt(_current),
                    style: TextStyle(
                      fontSize: 72,
                      fontWeight: FontWeight.bold,
                      color: over ? Colors.amber.shade800 : scheme.primary,
                    ),
                  ),
                  TextSpan(
                    text: ' / ${_fmt(t.expected)}',
                    style: TextStyle(
                      fontSize: 36,
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                ]),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 16),
              LinearProgressIndicator(
                value: progress,
                minHeight: 10,
                color: over ? Colors.amber.shade800 : null,
                borderRadius: BorderRadius.circular(5),
              ),
              if (over) ...[
                const SizedBox(height: 8),
                Text('Above the system quantity',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.amber.shade800)),
              ],
              const Spacer(),
              Row(
                children: [
                  for (final step in const [1, 5, 10]) ...[
                    if (step != 1) const SizedBox(width: 12),
                    Expanded(
                      child: FilledButton(
                        onPressed: () => _set(_current + step),
                        style: FilledButton.styleFrom(
                          padding: const EdgeInsets.symmetric(vertical: 20),
                          textStyle: const TextStyle(
                              fontSize: 22, fontWeight: FontWeight.bold),
                        ),
                        child: Text('+$step'),
                      ),
                    ),
                  ],
                ],
              ),
              const SizedBox(height: 12),
              OutlinedButton(
                onPressed:
                    _current <= 0 ? null : () => _set(_current - 1),
                style: OutlinedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  textStyle: const TextStyle(fontSize: 20),
                ),
                child: const Text('−1'),
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _custom,
                      keyboardType: TextInputType.numberWithOptions(
                          decimal: t.qtyDecimals > 0),
                      inputFormatters: [
                        if (t.qtyDecimals == 0)
                          FilteringTextInputFormatter.digitsOnly,
                      ],
                      decoration: const InputDecoration(
                        labelText: 'Custom step… box of 12?',
                        border: OutlineInputBorder(),
                        isDense: true,
                      ),
                      onSubmitted: (_) => _addCustom(),
                    ),
                  ),
                  const SizedBox(width: 12),
                  FilledButton.tonal(
                    onPressed: _customStep == null ? null : _addCustom,
                    child: Text(_customStep == null
                        ? '+…'
                        : '+${_fmt(_customStep!)}'),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              FilledButton(
                onPressed: () => Navigator.pop(context),
                style: FilledButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  textStyle: const TextStyle(fontSize: 18),
                ),
                child: const Text('Done'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
