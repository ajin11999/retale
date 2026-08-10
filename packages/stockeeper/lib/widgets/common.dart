import 'package:flutter/material.dart';

import '../graphql/graphql_service.dart';
import '../models/models.dart';

/// Turn any thrown error into a human-readable line.
String describeError(Object error) =>
    error is GraphQLAppException ? error.message : error.toString();

/// Centred error message with a retry button.
class ErrorRetry extends StatelessWidget {
  const ErrorRetry({super.key, required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.error_outline, size: 40, color: Colors.redAccent),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 16),
            FilledButton(onPressed: onRetry, child: const Text('Retry')),
          ],
        ),
      ),
    );
  }
}

/// Renders a product title where the SKU is greyed out and smaller
/// than the main product/variant name.
class ProductTitleText extends StatelessWidget {
  const ProductTitleText({
    super.key,
    required this.productName,
    this.sku,
    this.label,
    this.fallbackDescription,
    this.fontSize = 15.0,
    this.skuFontSize = 12.0,
    this.maxLines,
    this.overflow,
  });

  final String? productName;
  final String? sku;
  final String? label;
  final String? fallbackDescription;
  final double fontSize;
  final double skuFontSize;
  final int? maxLines;
  final TextOverflow? overflow;

  factory ProductTitleText.fromVariantInfo(
    VariantInfo? info, {
    String? fallbackDescription,
    double fontSize = 15.0,
    double skuFontSize = 12.0,
    int? maxLines,
    TextOverflow? overflow,
  }) {
    return ProductTitleText(
      productName: info?.productName,
      sku: info?.sku,
      label: info?.label,
      fallbackDescription: fallbackDescription,
      fontSize: fontSize,
      skuFontSize: skuFontSize,
      maxLines: maxLines,
      overflow: overflow,
    );
  }

  factory ProductTitleText.fromStockLevel(
    StockLevel level, {
    double fontSize = 15.0,
    double skuFontSize = 12.0,
    int? maxLines,
    TextOverflow? overflow,
  }) {
    return ProductTitleText(
      productName: level.productName,
      sku: level.sku,
      label: level.label,
      fontSize: fontSize,
      skuFontSize: skuFontSize,
      maxLines: maxLines,
      overflow: overflow,
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final hasProduct = productName != null && productName!.isNotEmpty;
    final mainName =
        hasProduct ? productName! : (fallbackDescription ?? '(unnamed line)');
    final hasLabel = label != null && label!.isNotEmpty;
    final hasSku = sku != null && sku!.trim().isNotEmpty;

    final mainStyle = TextStyle(
      fontSize: fontSize,
      color: theme.colorScheme.onSurface,
    );

    final skuStyle = TextStyle(
      fontSize: skuFontSize,
      color: theme.colorScheme.outline,
      fontWeight: FontWeight.normal,
    );

    final spans = <InlineSpan>[];

    // Main product name
    spans.add(TextSpan(text: mainName, style: mainStyle));

    // Variant label if present
    if (hasLabel) {
      spans.add(TextSpan(text: ' · $label', style: mainStyle));
    }

    // Greyed and smaller SKU placed under the product/variant title
    if (hasSku) {
      spans.add(TextSpan(text: '\n${sku!.trim()}', style: skuStyle));
    }

    return Text.rich(
      TextSpan(children: spans),
      maxLines: maxLines,
      overflow: overflow,
    );
  }
}
