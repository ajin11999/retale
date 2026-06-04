import 'dart:typed_data';

import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;

import '../models/money.dart';
import 'receipt.dart';

const _mm = PdfPageFormat.mm;
const _minWidth = 80 * _mm; // never narrower than an 80mm thermal roll

/// Render [receipt] to PDF bytes, laid out for [format] — the paper the print
/// dialog selected. The layout is responsive: it fills the page width down to
/// a floor of 80mm (a thermal roll), so it prints sensibly on a receipt
/// printer or a full A4 page alike.
///
/// The built-in Helvetica fonts cover Latin-1 only; [_latin1] folds the
/// typographic characters the receipt uses into that range. Bundle a Unicode
/// TTF here if names in other scripts ever need to print.
Future<Uint8List> buildReceiptPdf(Receipt receipt, PdfPageFormat format) async {
  final doc = pw.Document();
  final regular = pw.Font.helvetica();
  final bold = pw.Font.helveticaBold();

  final pageFormat = PdfPageFormat(
    format.width < _minWidth ? _minWidth : format.width,
    format.height,
    marginAll: 5 * _mm,
  );

  pw.Widget money(int minor, {pw.Font? font}) =>
      pw.Text(Money.format(minor), style: pw.TextStyle(font: font ?? regular));

  doc.addPage(pw.Page(
    pageFormat: pageFormat,
    build: (context) => pw.Column(
      crossAxisAlignment: pw.CrossAxisAlignment.stretch,
      children: [
        pw.Center(
          child: pw.Text(_latin1(receipt.store.name),
              style: pw.TextStyle(font: bold, fontSize: 15)),
        ),
        if (_has(receipt.store.phone))
          pw.Center(
            child: pw.Text(_latin1(receipt.store.phone!),
                style: pw.TextStyle(font: regular, fontSize: 9)),
          ),
        pw.SizedBox(height: 8),
        if (receipt.displayNumber != null)
          pw.Text('Receipt ${_latin1(receipt.displayNumber!)}',
              style: pw.TextStyle(font: regular, fontSize: 10)),
        if (receipt.createdAt != null)
          pw.Text(Receipt.formatDate(receipt.createdAt!),
              style: pw.TextStyle(font: regular, fontSize: 10)),
        if (_has(receipt.customerName))
          pw.Text('Customer: ${_latin1(receipt.customerName!)}',
              style: pw.TextStyle(font: regular, fontSize: 10)),
        pw.Divider(height: 12),
        for (final line in receipt.lines) ...[
          pw.Text('${line.qty} x ${_latin1(line.name)}',
              style: pw.TextStyle(font: regular, fontSize: 11)),
          pw.Row(
            mainAxisAlignment: pw.MainAxisAlignment.spaceBetween,
            children: [
              pw.Text('  ${Money.format(line.unitPriceMinor)}',
                  style: pw.TextStyle(font: regular, fontSize: 9)),
              money(line.lineTotalMinor),
            ],
          ),
          pw.SizedBox(height: 2),
        ],
        pw.Divider(height: 12),
        pw.Row(
          mainAxisAlignment: pw.MainAxisAlignment.spaceBetween,
          children: [
            pw.Text('Total', style: pw.TextStyle(font: bold, fontSize: 13)),
            money(receipt.totalMinor, font: bold),
          ],
        ),
        if (receipt.paidMinor != null)
          pw.Row(
            mainAxisAlignment: pw.MainAxisAlignment.spaceBetween,
            children: [
              pw.Text('Paid', style: pw.TextStyle(font: regular)),
              money(receipt.paidMinor!),
            ],
          ),
        if (receipt.changeMinor != null && receipt.changeMinor! > 0)
          pw.Row(
            mainAxisAlignment: pw.MainAxisAlignment.spaceBetween,
            children: [
              pw.Text('Change', style: pw.TextStyle(font: regular)),
              money(receipt.changeMinor!),
            ],
          ),
        pw.SizedBox(height: 12),
        pw.Center(
          child: pw.Text('Thank you!', style: pw.TextStyle(font: regular)),
        ),
      ],
    ),
  ));

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
