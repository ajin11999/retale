import 'dart:typed_data';

import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;

import '../models/money.dart';
import 'receipt.dart';

const _mm = PdfPageFormat.mm;
const _receiptWidth = 80 * _mm; // a receipt is a fixed 80mm column

/// Render [receipt] to PDF bytes. A receipt is always laid out as a fixed
/// 80mm-wide column — the width of a thermal roll — regardless of [format]:
///
///  * Width is fixed at 80mm, never the sheet width. On web the print path can
///    only render once at a default (≈A4/Letter) format and then lets the
///    browser rescale for the chosen paper; filling that width made the receipt
///    A4-wide and overflow horizontally when printed on smaller paper (e.g.
///    A5). A narrow column sits comfortably on any sheet and on an 80mm roll.
///  * Height: on a fixed-size page (A4, A5, …) the body flows across pages via
///    [pw.MultiPage], so a long sale never overflows a single page. On a roll
///    (infinite height) it stays a single continuous page.
///
/// The styling mirrors the ProDuck POS receipt: a centred logo (or the store
/// name), a bordered item list — single-quantity lines collapse to name +
/// total, multi-quantity lines show `N <unit> x price` — then the total, cash
/// tendered and change, with the date centred at the foot.
///
/// The built-in Helvetica fonts cover Latin-1 only; [_latin1] folds the
/// typographic characters the receipt uses into that range. Bundle a Unicode
/// TTF here if names in other scripts ever need to print.
Future<Uint8List> buildReceiptPdf(
  Receipt receipt,
  PdfPageFormat format, {
  pw.ImageProvider? logo,
}) async {
  final doc = pw.Document();
  final regular = pw.Font.helvetica();
  final bold = pw.Font.helveticaBold();

  final pageFormat = PdfPageFormat(
    _receiptWidth,
    format.height,
    marginAll: 5 * _mm,
  );

  // A label/amount line (TOTAL, Cash, CHANGE). [strong] enlarges and bolds it,
  // matching ProDuck's emphasis on the total and change.
  pw.Widget costRow(String label, int minor, {bool strong = false}) {
    final font = strong ? bold : regular;
    final size = strong ? 13.0 : 11.0;
    return pw.Padding(
      padding: const pw.EdgeInsets.symmetric(vertical: 1),
      child: pw.Row(
        mainAxisAlignment: pw.MainAxisAlignment.spaceBetween,
        children: [
          pw.Text(label, style: pw.TextStyle(font: font, fontSize: size)),
          pw.Text(Money.format(minor),
              style: pw.TextStyle(font: font, fontSize: size)),
        ],
      ),
    );
  }

  // One item. Quantity 1 collapses to a single name/total row; higher
  // quantities add a `N Units x unitPrice` line beneath the name.
  pw.Widget itemBlock(ReceiptLine line) {
    final name = pw.Text(_latin1(line.name),
        style: pw.TextStyle(font: regular, fontSize: 11));
    final total = pw.Text(Money.format(line.lineTotalMinor),
        style: pw.TextStyle(font: regular, fontSize: 11));

    if (line.qty == 1) {
      return pw.Padding(
        padding: const pw.EdgeInsets.only(bottom: 4),
        child: pw.Row(
          crossAxisAlignment: pw.CrossAxisAlignment.start,
          children: [
            pw.Expanded(child: name),
            pw.SizedBox(width: 8),
            total,
          ],
        ),
      );
    }

    return pw.Padding(
      padding: const pw.EdgeInsets.only(bottom: 4),
      child: pw.Column(
        crossAxisAlignment: pw.CrossAxisAlignment.stretch,
        children: [
          name,
          pw.Row(
            mainAxisAlignment: pw.MainAxisAlignment.spaceBetween,
            children: [
              pw.Text(
                  '  ${line.qty} ${line.unit ?? 'Units'} x ${Money.format(line.unitPriceMinor)}',
                  style: pw.TextStyle(font: regular, fontSize: 9)),
              total,
            ],
          ),
        ],
      ),
    );
  }

  final body = <pw.Widget>[
    pw.Center(
      child: logo != null
          // A real logo replaces the store-name header; cap its height so a
          // tall image can't push the whole receipt down the page.
          ? pw.Image(logo, height: 60, fit: pw.BoxFit.contain)
          : pw.Text(_latin1(receipt.store.name),
              style: pw.TextStyle(font: bold, fontSize: 15)),
    ),
    if (_has(receipt.customerName))
      pw.Padding(
        padding: const pw.EdgeInsets.only(top: 4),
        child: pw.Center(
          child: pw.Text('Customer: ${_latin1(receipt.customerName!)}',
              style: pw.TextStyle(font: bold, fontSize: 10)),
        ),
      ),
    pw.Divider(height: 14),
    for (final line in receipt.lines) itemBlock(line),
    pw.Divider(height: 14),
    costRow('TOTAL', receipt.totalMinor, strong: true),
    if (receipt.paidMinor != null) costRow('Cash', receipt.paidMinor!),
    if (receipt.changeMinor != null && receipt.changeMinor! > 0)
      costRow('CHANGE', receipt.changeMinor!, strong: true),
    if (receipt.onAccountMinor != null && receipt.onAccountMinor! > 0)
      costRow('ON ACCOUNT', receipt.onAccountMinor!, strong: true),
    pw.SizedBox(height: 14),
    if (receipt.displayNumber != null)
      pw.Center(
        child: pw.Text('Receipt ${_latin1(receipt.displayNumber!)}',
            style: pw.TextStyle(font: regular, fontSize: 9)),
      ),
    if (receipt.createdAt != null)
      pw.Center(
        child: pw.Text(Receipt.formatDate(receipt.createdAt!),
            style: pw.TextStyle(font: bold, fontSize: 10)),
      ),
  ];

  // A fixed-size sheet (A4/A5) has a finite height, so flow the body across
  // pages to avoid overflow. A thermal roll reports an infinite height, which
  // MultiPage can't paginate — render it as one continuous page instead.
  if (pageFormat.height.isFinite) {
    doc.addPage(pw.MultiPage(
      pageFormat: pageFormat,
      build: (context) => body,
    ));
  } else {
    doc.addPage(pw.Page(
      pageFormat: pageFormat,
      build: (context) => pw.Column(
        crossAxisAlignment: pw.CrossAxisAlignment.stretch,
        children: body,
      ),
    ));
  }

  return doc.save();
}

bool _has(String? s) => s != null && s.trim().isNotEmpty;

/// Fold the typographic characters the receipt uses into Latin-1, replacing
/// anything still outside that range with '?' so Helvetica can encode it.
String _latin1(String s) {
  const swaps = {
    '—': '-',
    '–': '-',
    '×': 'x',
    '…': '...',
    '’': "'",
    '‘': "'",
    '“': '"',
    '”': '"',
  };
  final out = StringBuffer();
  for (final rune in s.runes) {
    final ch = String.fromCharCode(rune);
    if (swaps.containsKey(ch)) {
      out.write(swaps[ch]);
    } else if (rune <= 0xFF) {
      out.write(ch);
    } else {
      out.write('?');
    }
  }
  return out.toString();
}
