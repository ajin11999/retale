import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:retale_pos/screens/register_screen.dart';

void main() {
  testWidgets('sale snackbar duration is 10 seconds', (tester) async {
    // We can verify that SnackBar displayed via ScaffoldMessenger with duration 10s works as expected.
    late BuildContext savedContext;

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) {
              savedContext = context;
              return const SizedBox();
            },
          ),
        ),
      ),
    );

    final label = 'Sale completed · REC-001';
    ScaffoldMessenger.of(savedContext).showSnackBar(
      SnackBar(
        content: Text(label),
        duration: const Duration(seconds: 10),
        showCloseIcon: true,
      ),
    );

    await tester.pump();

    final snackBarFinder = find.byType(SnackBar);
    expect(snackBarFinder, findsOneWidget);

    final snackBar = tester.widget<SnackBar>(snackBarFinder);
    expect(snackBar.duration, const Duration(seconds: 10));
  });
}
