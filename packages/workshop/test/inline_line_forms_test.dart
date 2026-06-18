import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sembast/sembast_memory.dart';
import 'package:retale_workshop/component/inline_line_forms.dart';
import 'package:retale_workshop/db.dart';
import 'package:retale_workshop/services/catalog_repo.dart';
import 'package:retale_workshop/services/product_service.dart';

void main() {
  Widget host(Widget form) => MaterialApp(home: Scaffold(body: form));

  // The add-line form searches the local catalog cache, so it needs an
  // initialised sembast store (offline-first — no network involved).
  setUpAll(() async {
    DatabaseService.db =
        await newDatabaseFactoryMemory().openDatabase('inline_forms_test');
    await CatalogRepo().replaceAll([
      CatalogVariant(
        variantId: 'v1',
        kind: 'physical',
        name: 'Oli Mesin',
        sku: 'OLI-1',
        priceMinor: 50000,
        costMinor: 30000,
        costRatioBps: null,
        unit: 'pcs',
      ),
    ]);
  });

  group('inline form Esc-to-cancel', () {
    testWidgets('Esc in the add-line form search field cancels', (tester) async {
      var cancelled = false;
      await tester.pumpWidget(host(InlineLeafForm(
        onSubmit: (_) => fail('Esc must not submit'),
        onCancel: () => cancelled = true,
      )));
      await tester.pump(); // let the search field take its autofocus

      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      expect(cancelled, isTrue);

      // Flush the combobox's 300ms search debounce so no timer outlives the test.
      await tester.pump(const Duration(milliseconds: 400));
    });

    testWidgets('Esc from a plain field (qty) also cancels', (tester) async {
      var cancelled = false;
      await tester.pumpWidget(host(InlineLeafForm(
        onSubmit: (_) => fail('Esc must not submit'),
        onCancel: () => cancelled = true,
      )));
      await tester.pump();

      await tester.tap(find.widgetWithText(TextField, 'Qty'));
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      expect(cancelled, isTrue);

      await tester.pump(const Duration(milliseconds: 400));
    });

    testWidgets('search filters the offline catalog cache', (tester) async {
      await tester.pumpWidget(host(
        InlineLeafForm(onSubmit: (_) {}, onCancel: () {}),
      ));
      await tester.pump();

      await tester.enterText(
          find.widgetWithText(TextField, 'Search products…'), 'oli');
      await tester.pump(const Duration(milliseconds: 350)); // search debounce
      await tester.pumpAndSettle();

      // The cached product surfaces with no network involved.
      expect(find.text('Oli Mesin'), findsOneWidget);
    });

    testWidgets('Esc in the add-section form cancels', (tester) async {
      var cancelled = false;
      await tester.pumpWidget(host(InlineGroupForm(
        onSubmit: (_) => fail('Esc must not submit'),
        onCancel: () => cancelled = true,
      )));
      await tester.pump();

      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      expect(cancelled, isTrue);
    });
  });
}
