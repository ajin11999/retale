import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:retale_stockeeper/models/models.dart';
import 'package:retale_stockeeper/widgets/common.dart';

void main() {
  testWidgets('ProductTitleText displays product name and greyed smaller SKU',
      (WidgetTester tester) async {
    final info = VariantInfo('Apple Juice', 'JUICE-001', '1L');

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ProductTitleText.fromVariantInfo(info),
        ),
      ),
    );

    final richTextFinder = find.byType(RichText);
    expect(richTextFinder, findsOneWidget);

    final richText = tester.widget<RichText>(richTextFinder);
    final textSpan = richText.text as TextSpan;

    // Find all text spans in the tree
    final allSpans = <TextSpan>[];
    textSpan.visitChildren((span) {
      if (span is TextSpan) allSpans.add(span);
      return true;
    });

    final nameSpan = allSpans.firstWhere((s) => s.text == 'Apple Juice');
    final labelSpan = allSpans.firstWhere((s) => s.text == ' · 1L');
    final skuSpan = allSpans.firstWhere((s) => s.text == '\nJUICE-001');

    expect(nameSpan.text, 'Apple Juice');
    expect(labelSpan.text, ' · 1L');
    expect(skuSpan.text, '\nJUICE-001');
    expect(skuSpan.style?.fontSize, 12.0);
  });
}
