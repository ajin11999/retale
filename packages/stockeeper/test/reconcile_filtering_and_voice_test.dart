import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:retale_stockeeper/models/models.dart';
import 'package:retale_stockeeper/screens/reconcile/reconcile_screen.dart';
import 'package:retale_stockeeper/voice/voice_input_service.dart';

class FakeVoiceRecognizer implements VoiceRecognizer {
  bool _listening = false;
  void Function(String)? _onPartial;
  void Function(String)? _onFinal;
  void Function(String)? _onError;
  VoidCallback? _onStopped;

  int startCount = 0;
  int cancelCount = 0;

  @override
  bool get isListening => _listening;

  @override
  Future<bool> startListening({
    required void Function(String partialWords) onPartial,
    required void Function(String finalWords) onFinal,
    required void Function(String message) onError,
    required VoidCallback onStopped,
  }) async {
    startCount++;
    _listening = true;
    _onPartial = onPartial;
    _onFinal = onFinal;
    _onError = onError;
    _onStopped = onStopped;
    return true;
  }

  void emitPartial(String words) {
    _onPartial?.call(words);
  }

  void emitFinal(String words) {
    _listening = false;
    _onFinal?.call(words);
  }

  void emitError(String message) {
    _listening = false;
    _onError?.call(message);
  }

  @override
  Future<void> stop() async {
    _listening = false;
    _onStopped?.call();
  }

  @override
  Future<void> cancel() async {
    cancelCount++;
    _listening = false;
  }

  @override
  void dispose() {
    _listening = false;
  }
}

ReconcileCatalogData _sampleCatalog() {
  final categories = [
    CategoryNode(id: 'c-root', name: 'Engine Parts'),
    CategoryNode(id: 'c-filters', name: 'Filters', parentId: 'c-root'),
    CategoryNode(id: 'c-bolts', name: 'Fasteners'),
  ];

  final localRows = [
    StockLevel(
      variantId: 'v-oil-1',
      productId: 'p-oil',
      productName: 'Oil Filter Sakura',
      sku: 'SAK-C1112',
      label: 'C-1112',
      barcode: null,
      unit: 'piece',
      qtyDecimals: 0,
      onHand: 10,
      categoryId: 'c-filters',
    ),
    StockLevel(
      variantId: 'v-bolt-1',
      productId: 'p-bolt',
      productName: 'Hex Bolt M8',
      sku: 'BLT-M8-20',
      label: '20mm',
      barcode: null,
      unit: 'piece',
      qtyDecimals: 0,
      onHand: 50,
      categoryId: 'c-bolts',
    ),
  ];

  final globalVariants = [
    ...localRows,
    StockLevel(
      variantId: 'v-oil-2',
      productId: 'p-oil',
      productName: 'Oil Filter Sakura',
      sku: 'SAK-C1113',
      label: 'C-1113',
      barcode: null,
      unit: 'piece',
      qtyDecimals: 0,
      onHand: 0,
      categoryId: 'c-filters',
    ),
  ];

  final products = [
    const ProductFilterOption(
      id: 'p-bolt',
      name: 'Hex Bolt M8',
      categoryId: 'c-bolts',
      variantCount: 1,
    ),
    const ProductFilterOption(
      id: 'p-oil',
      name: 'Oil Filter Sakura',
      categoryId: 'c-filters',
      variantCount: 2,
    ),
  ];

  return ReconcileCatalogData(
    localRows: localRows,
    globalVariants: globalVariants,
    categories: categories,
    products: products,
  );
}

void main() {
  group('Category tree helpers', () {
    test('collectCategoryAndDescendants traverses nested subcategories safely',
        () {
      final cats = [
        CategoryNode(id: 'root', name: 'Root'),
        CategoryNode(id: 'child', name: 'Child', parentId: 'root'),
        CategoryNode(id: 'grand', name: 'Grand', parentId: 'child'),
        CategoryNode(id: 'other', name: 'Other'),
      ];

      expect(
        collectCategoryAndDescendants('root', cats),
        {'root', 'child', 'grand'},
      );
      expect(
        collectCategoryAndDescendants('child', cats),
        {'child', 'grand'},
      );
    });

    test('buildCategoryTreeEntries preserves parent-child order and depth', () {
      final cats = [
        CategoryNode(id: 'c2', name: 'Filters', parentId: 'c1'),
        CategoryNode(id: 'c1', name: 'Engine'),
        CategoryNode(id: 'c3', name: 'Archived', archivedAt: '2026-01-01'),
      ];

      final entries = buildCategoryTreeEntries(cats);
      expect(entries.length, 2);
      expect(entries[0].category.id, 'c1');
      expect(entries[0].depth, 0);
      expect(entries[1].category.id, 'c2');
      expect(entries[1].depth, 1);
      expect(entries[1].pathLabel, 'Engine › Filters');
    });
  });

  group('ReconcileScreen voice & filtering', () {
    testWidgets('search + voice button sets counted qty on variant',
        (tester) async {
      final fakeVoice = FakeVoiceRecognizer();
      await tester.pumpWidget(
        MaterialApp(
          home: ReconcileScreen(
            location: LocationNode(id: 'loc1', name: 'Main', parentId: null),
            voiceRecognizer: fakeVoice,
            loadCatalog: (_) async => _sampleCatalog(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Search for "oil filter sakura" -> reveals both stocked and unstocked variants
      await tester.enterText(
        find.widgetWithText(TextField, 'Filter products or variants'),
        'oil filter sakura',
      );
      await tester.pumpAndSettle();

      expect(find.text('Hex Bolt M8'), findsNothing);
      expect(find.byKey(const Key('voice-btn-v-oil-1')), findsOneWidget);
      expect(find.byKey(const Key('voice-btn-v-oil-2')), findsOneWidget);

      // Tap mic button on v-oil-1 and speak "twenty four"
      await tester.tap(find.byKey(const Key('voice-btn-v-oil-1')));
      await tester.pump();

      expect(fakeVoice.startCount, 1);
      expect(find.textContaining('Listening (English):'), findsOneWidget);

      fakeVoice.emitPartial('twenty');
      await tester.pump();
      expect(find.text('"twenty"'), findsOneWidget);

      fakeVoice.emitFinal('twenty four');
      await tester.pumpAndSettle();

      expect(find.text('system 10 · counted 24'), findsOneWidget);
      expect(find.text('Review 1 counted line'), findsOneWidget);

      // Tap mic on v-oil-2 (global variant) and speak "zero"
      await tester.tap(find.byKey(const Key('voice-btn-v-oil-2')));
      await tester.pump();
      fakeVoice.emitFinal('zero');
      await tester.pumpAndSettle();

      expect(find.text('system 0 · counted 0'), findsOneWidget);
      expect(find.text('Review 2 counted lines'), findsOneWidget);

      // Invalid speech does not add or alter a count
      await tester.tap(find.byKey(const Key('voice-btn-v-oil-1')));
      await tester.pump();
      fakeVoice.emitFinal('hello');
      await tester.pumpAndSettle();

      expect(find.text('system 10 · counted 24'), findsOneWidget);
    });

    testWidgets('category and product filter sheets filter variants',
        (tester) async {
      final fakeVoice = FakeVoiceRecognizer();
      await tester.pumpWidget(
        MaterialApp(
          home: ReconcileScreen(
            location: LocationNode(id: 'loc1', name: 'Main', parentId: null),
            voiceRecognizer: fakeVoice,
            loadCatalog: (_) async => _sampleCatalog(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Open Category sheet and pick parent "Engine Parts"
      await tester.tap(find.widgetWithText(InputChip, 'Category'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Engine Parts'));
      await tester.pumpAndSettle();

      // Only Oil Filter Sakura variants (child category Filters) remain visible
      expect(find.byKey(const Key('voice-btn-v-oil-1')), findsOneWidget);
      expect(find.byKey(const Key('voice-btn-v-oil-2')), findsOneWidget);
      expect(find.byKey(const Key('voice-btn-v-bolt-1')), findsNothing);

      // Clear filters restores location stock rows
      await tester.tap(find.widgetWithText(ActionChip, 'Clear'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('voice-btn-v-bolt-1')), findsOneWidget);

      // Open Product sheet and pick "Oil Filter Sakura"
      await tester.tap(find.widgetWithText(InputChip, 'Product'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Oil Filter Sakura'));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('voice-btn-v-oil-1')), findsOneWidget);
      expect(find.byKey(const Key('voice-btn-v-oil-2')), findsOneWidget);
      expect(find.byKey(const Key('voice-btn-v-bolt-1')), findsNothing);
    });
  });
}
