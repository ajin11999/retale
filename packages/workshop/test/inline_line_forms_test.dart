import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:graphql_flutter/graphql_flutter.dart';
import 'package:retale_workshop/component/inline_line_forms.dart';

/// A GraphQL link whose every response is an error — simulates an expired
/// session / unreachable API for the product search.
class _FailingLink extends Link {
  @override
  Stream<Response> request(Request request, [NextLink? forward]) =>
      Stream.value(Response(
        errors: const [GraphQLError(message: 'Authentication required')],
        response: const {},
      ));
}

void main() {
  Widget host(Widget form) => MaterialApp(home: Scaffold(body: form));

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

    testWidgets('search failure shows a snackbar, not a silent empty dropdown',
        (tester) async {
      final client = ValueNotifier(GraphQLClient(
        link: _FailingLink(),
        cache: GraphQLCache(store: InMemoryStore()),
      ));
      await tester.pumpWidget(GraphQLProvider(
        client: client,
        child: host(InlineLeafForm(onSubmit: (_) {}, onCancel: () {})),
      ));
      await tester.pump();

      await tester.enterText(
          find.widgetWithText(TextField, 'Search products…'), 'oli');
      await tester.pump(const Duration(milliseconds: 350)); // search debounce
      await tester.pumpAndSettle();

      expect(
        find.textContaining('Product search failed'),
        findsOneWidget,
      );

      // Let the snackbar's display timer elapse so no timer outlives the test.
      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();
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
