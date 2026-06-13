import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:graphql_flutter/graphql_flutter.dart';
import 'package:retale_workshop/component/inline_line_forms.dart';
import 'package:retale_workshop/component/job_lines.dart';
import 'package:retale_workshop/component/line_dialogs.dart';
import 'package:retale_workshop/component/margin_pill.dart';
import 'package:retale_workshop/schema/project.dart';
import 'package:retale_workshop/util/project_calc.dart';

/// A GraphQL link that answers every request with the same canned payload —
/// lets the add-line form's product search run for real in widget tests.
class _CannedLink extends Link {
  _CannedLink(this.data);
  final Map<String, dynamic> data;

  @override
  Stream<Response> request(Request request, [NextLink? forward]) =>
      Stream.value(Response(data: data, response: const {}));
}

Widget _withClient(Widget child) {
  final client = ValueNotifier(GraphQLClient(
    // __typename everywhere: the client adds it to the query and the cache
    // write rejects responses missing it.
    link: _CannedLink({
      '__typename': 'Query',
      'products': [
        {
          '__typename': 'Product',
          'name': 'Oli Mesin',
          'kind': 'physical',
          'costRatioBps': null,
          'variants': [
            {
              '__typename': 'ProductVariant',
              'id': 'v1',
              'sku': 'OLI-1',
              'label': '',
              'priceMinor': 50000,
              'costMinor': 30000,
              'unit': 'pcs',
            },
          ],
        },
      ],
    }),
    cache: GraphQLCache(store: InMemoryStore()),
  ));
  return GraphQLProvider(
    client: client,
    child: MaterialApp(home: Scaffold(body: child)),
  );
}

void main() {
  group('WorkLineMargin', () {
    test('physical lines use the snapshotted unit cost', () {
      final l = WorkLine()
        ..variantKind = 'physical'
        ..unitPriceMinor = 50000
        ..unitCostMinor = 30000;
      expect(l.marginFraction, closeTo(0.4, 1e-9));
    });

    test('open-price lines derive cost from the price via the ratio', () {
      final l = WorkLine()
        ..variantKind = 'open_price'
        ..unitPriceMinor = 10000
        ..unitCostMinor = 0
        ..costRatioBps = 6000; // cost = 60% of price
      expect(l.marginFraction, closeTo(0.4, 1e-9));
      l.unitPriceMinor = 20000; // ratio tracks the new price
      expect(l.marginFraction, closeTo(0.4, 1e-9));
    });

    test('legacy lines (no cost snapshot) and zero price give null', () {
      expect((WorkLine()..unitPriceMinor = 5000).marginFraction, isNull);
      expect(
        (WorkLine()
              ..unitPriceMinor = 0
              ..unitCostMinor = 100)
            .marginFraction,
        isNull,
      );
    });
  });

  group('margin pill in job lines', () {
    testWidgets('shows next to the line price; hidden on legacy lines',
        (tester) async {
      final withCost = WorkLine()
        ..variantId = 'v1'
        ..variantKind = 'physical'
        ..snapshotName = 'Part'
        ..qty = 2
        ..unitPriceMinor = 10000
        ..unitCostMinor = 7500;
      final legacy = WorkLine()
        ..variantId = 'v2'
        ..variantKind = 'physical'
        ..snapshotName = 'Old line'
        ..qty = 1
        ..unitPriceMinor = 5000;
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: JobLines(
              lines: [withCost, legacy], onChanged: (_) {}, readOnly: true),
        ),
      ));

      expect(find.text('25%'), findsOneWidget);
      // The legacy row renders its pill empty — exactly one percentage shows.
      expect(
        find.descendant(
            of: find.byType(MarginPill), matching: find.byType(Text)),
        findsOneWidget,
      );
    });

    testWidgets('negative margin renders (error-tinted) pill', (tester) async {
      final belowCost = WorkLine()
        ..variantId = 'v1'
        ..variantKind = 'physical'
        ..snapshotName = 'Loss leader'
        ..qty = 1
        ..unitPriceMinor = 8000
        ..unitCostMinor = 10000;
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body:
              JobLines(lines: [belowCost], onChanged: (_) {}, readOnly: true),
        ),
      ));
      expect(find.text('-25%'), findsOneWidget);
    });
  });

  group('margin pill in the edit dialog price field', () {
    testWidgets('previews live as the price is retyped', (tester) async {
      final line = WorkLine()
        ..variantId = 'v1'
        ..variantKind = 'physical'
        ..snapshotName = 'Part'
        ..qty = 1
        ..unitPriceMinor = 50000
        ..unitCostMinor = 30000;
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showLeafEditor(context, existing: line),
              child: const Text('open'),
            ),
          ),
        ),
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      expect(find.text('40%'), findsOneWidget);

      await tester.enterText(find.widgetWithText(TextField, 'Price'), '25000');
      await tester.pump();
      // (25.000 − 30.000) / 25.000
      expect(find.text('-20%'), findsOneWidget);
      expect(find.text('40%'), findsNothing);
    });
  });

  group('margin pill in the add-line form price field', () {
    testWidgets('appears on pick and tracks the typed price', (tester) async {
      await tester.pumpWidget(_withClient(
        InlineLeafForm(onSubmit: (_) {}, onCancel: () {}),
      ));
      await tester.pump();

      // Search and pick the canned product.
      await tester.enterText(
          find.widgetWithText(TextField, 'Search products…'), 'oli');
      await tester.pump(const Duration(milliseconds: 350)); // search debounce
      await tester.pumpAndSettle();
      await tester.tap(find.text('Oli Mesin').last);
      await tester.pump(const Duration(milliseconds: 350)); // re-query debounce
      await tester.pumpAndSettle();

      // Price seeded from the catalog: (50.000 − 30.000) / 50.000.
      expect(find.text('40%'), findsOneWidget);

      await tester.enterText(find.widgetWithText(TextField, 'Price'), '40000');
      await tester.pump();
      // (40.000 − 30.000) / 40.000
      expect(find.text('25%'), findsOneWidget);
      expect(find.text('40%'), findsNothing);
    });

    testWidgets('submitted line carries the cost snapshot', (tester) async {
      WorkLine? submitted;
      await tester.pumpWidget(_withClient(
        InlineLeafForm(onSubmit: (l) => submitted = l, onCancel: () {}),
      ));
      await tester.pump();

      await tester.enterText(
          find.widgetWithText(TextField, 'Search products…'), 'oli');
      await tester.pump(const Duration(milliseconds: 350));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Oli Mesin').last);
      await tester.pump(const Duration(milliseconds: 350));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Add'));
      await tester.pump();

      expect(submitted, isNotNull);
      expect(submitted!.unitCostMinor, 30000);
      expect(submitted!.costRatioBps, isNull);
      expect(submitted!.marginFraction, closeTo(0.4, 1e-9));
    });
  });

  group('cost line in the edit dialog', () {
    testWidgets('shows cost and margin under the price, live', (tester) async {
      final line = WorkLine()
        ..variantId = 'v1'
        ..variantKind = 'physical'
        ..snapshotName = 'Part'
        ..qty = 1
        ..unitPriceMinor = 50000
        ..unitCostMinor = 30000;
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showLeafEditor(context, existing: line),
              child: const Text('open'),
            ),
          ),
        ),
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      // 50.000 price − 30.000 cost = 20.000 margin.
      expect(find.textContaining('Cost Rp 30.000'), findsOneWidget);
      expect(find.textContaining('Margin Rp 20.000'), findsOneWidget);

      await tester.enterText(find.widgetWithText(TextField, 'Price'), '25000');
      await tester.pump();
      // Physical cost is fixed; margin goes negative below cost.
      expect(find.textContaining('Cost Rp 30.000'), findsOneWidget);
      expect(find.textContaining('Margin Rp -5.000'), findsOneWidget);
    });

    testWidgets('legacy line (no cost snapshot) shows no cost line',
        (tester) async {
      final legacy = WorkLine()
        ..variantId = 'v2'
        ..variantKind = 'physical'
        ..snapshotName = 'Old line'
        ..qty = 1
        ..unitPriceMinor = 5000;
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showLeafEditor(context, existing: legacy),
              child: const Text('open'),
            ),
          ),
        ),
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Cost'), findsNothing);
    });
  });

  group('cost line in the add-line form', () {
    testWidgets('appears on pick with the catalog cost', (tester) async {
      await tester.pumpWidget(_withClient(
        InlineLeafForm(onSubmit: (_) {}, onCancel: () {}),
      ));
      await tester.pump();

      await tester.enterText(
          find.widgetWithText(TextField, 'Search products…'), 'oli');
      await tester.pump(const Duration(milliseconds: 350));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Oli Mesin').last);
      await tester.pump(const Duration(milliseconds: 350));
      await tester.pumpAndSettle();

      // Catalog cost 30.000 against the seeded 50.000 price.
      expect(find.textContaining('Cost Rp 30.000'), findsOneWidget);
      expect(find.textContaining('Margin Rp 20.000'), findsOneWidget);
    });
  });
}
