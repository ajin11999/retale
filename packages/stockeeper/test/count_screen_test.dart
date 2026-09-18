import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:retale_stockeeper/screens/count_screen.dart';

/// Pumps a CountScreen with a recording onSet. Returns the recorded qtys.
Future<List<num>> pumpCounter(
  WidgetTester tester, {
  num expected = 100,
  num initial = 0,
  bool allowOverage = false,
}) async {
  final calls = <num>[];
  await tester.pumpWidget(
    MaterialApp(
      home: CountScreen(
        target: CountTarget(
          title: 'Test item',
          expected: expected,
          initial: initial,
          allowOverage: allowOverage,
          qtyDecimals: 0,
          onSet: (qty) async => calls.add(qty),
        ),
      ),
    ),
  );
  return calls;
}

Future<void> typeCustomStep(WidgetTester tester, String value) async {
  final field = find.widgetWithText(TextField, 'Custom step… box of 12?');
  expect(field, findsOneWidget);
  await tester.enterText(field, value);
  await tester.pump();
}

void main() {
  testWidgets('custom step adds a box qty per tap (12 → 24)', (tester) async {
    final calls = await pumpCounter(tester);

    await typeCustomStep(tester, '12');
    await tester.tap(find.text('+12'));
    await tester.pumpAndSettle();
    expect(calls, [12]);

    await tester.tap(find.text('+12'));
    await tester.pumpAndSettle();
    expect(calls, [12, 24]);
    // Headline is a Text.rich span tree — match on its plain text.
    final headlines = tester
        .widgetList<RichText>(find.byType(RichText))
        .map((w) => w.text.toPlainText());
    expect(headlines.any((t) => t.contains('24')), isTrue);
  });

  testWidgets('custom step clamps at expected when overage is off', (tester) async {
    final calls = await pumpCounter(tester, expected: 20, initial: 18);

    await typeCustomStep(tester, '12');
    await tester.tap(find.text('+12'));
    await tester.pumpAndSettle();
    // 18 + 12 would overshoot; the counter clamps to the expected 20.
    expect(calls, [20]);
  });

  testWidgets('custom step allows overage when the target permits it', (tester) async {
    final calls = await pumpCounter(tester,
        expected: 20, initial: 18, allowOverage: true);

    await typeCustomStep(tester, '12');
    await tester.tap(find.text('+12'));
    await tester.pumpAndSettle();
    expect(calls, [30]);
  });

  testWidgets('custom step button is disabled without a valid value', (tester) async {
    await pumpCounter(tester);

    // Empty field → placeholder label, tapping does nothing.
    expect(find.text('+…'), findsOneWidget);

    await typeCustomStep(tester, '0');
    expect(find.text('+…'), findsOneWidget);
  });
}
