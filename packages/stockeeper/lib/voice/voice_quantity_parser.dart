import 'dart:math' as math;

/// Result of parsing a spoken English quantity transcript.
class VoiceParseResult {
  const VoiceParseResult.success(this.value) : error = null;
  const VoiceParseResult.failure(this.error) : value = null;

  final num? value;
  final String? error;

  bool get isSuccess => value != null;
}

/// Pure-Dart parser for spoken English stock-count quantities.
class VoiceQuantityParser {
  VoiceQuantityParser._();

  static const _units = <String, int>{
    'zero': 0,
    'one': 1,
    'two': 2,
    'three': 3,
    'four': 4,
    'five': 5,
    'six': 6,
    'seven': 7,
    'eight': 8,
    'nine': 9,
    'ten': 10,
    'eleven': 11,
    'twelve': 12,
    'thirteen': 13,
    'fourteen': 14,
    'fifteen': 15,
    'sixteen': 16,
    'seventeen': 17,
    'eighteen': 18,
    'nineteen': 19,
  };

  static const _tens = <String, int>{
    'twenty': 20,
    'thirty': 30,
    'forty': 40,
    'fifty': 50,
    'sixty': 60,
    'seventy': 70,
    'eighty': 80,
    'ninety': 90,
  };

  static final _numWords = <String>{
    ..._units.keys,
    ..._tens.keys,
    'hundred',
    'thousand',
  };

  static final _fillerWords = <String>{
    'set',
    'count',
    'counted',
    'qty',
    'quantity',
    'is',
    'equals',
    'equal',
    'to',
    'at',
    'for',
    'pcs',
    'pc',
    'piece',
    'pieces',
    'unit',
    'units',
  };

  /// Parses [transcript] into a validated quantity for a variant with [qtyDecimals].
  static VoiceParseResult parse(
    String transcript, {
    required int qtyDecimals,
  }) {
    final raw = transcript.trim();
    if (raw.isEmpty) {
      return const VoiceParseResult.failure('No speech heard — tap mic to retry');
    }

    var s = raw.toLowerCase();

    // Reject explicit negative phrasing before stripping punctuation.
    if (RegExp(r'(^|\s)-\s*\d').hasMatch(s) ||
        RegExp(r'\b(minus|negative)\b').hasMatch(s)) {
      return const VoiceParseResult.failure('Quantity cannot be negative');
    }

    // Strip English thousands separators: "1,000" -> "1000", "1,250.5" -> "1250.5".
    s = s.replaceAllMapped(
      RegExp(r'\b\d{1,3}(?:,\d{3})+(\.\d+)?\b'),
      (m) => m.group(0)!.replaceAll(',', ''),
    );

    // Normalize "a hundred" / "a thousand" -> "one hundred" / "one thousand".
    s = s.replaceAllMapped(
      RegExp(r'\ba\s+(hundred|thousand)\b'),
      (m) => 'one ${m.group(1)}',
    );

    // Normalize "hundred and twenty" -> "hundred twenty" and drop stray "and".
    s = s.replaceAllMapped(
      RegExp(
        r'\b(hundred|thousand)\s+and\s+(?=(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b)',
      ),
      (m) => '${m.group(1)} ',
    );

    // Replace hyphens inside compound number words ("twenty-five" -> "twenty five").
    s = s.replaceAllMapped(
      RegExp(r'\b([a-z]+)-([a-z]+)\b'),
      (m) => _numWords.contains(m.group(1)) && _numWords.contains(m.group(2))
          ? '${m.group(1)} ${m.group(2)}'
          : m.group(0)!,
    );

    // Handle spoken decimal separator "point" (e.g. "two point five", "point five").
    final pointParts = s.split(RegExp(r'\bpoint\b'));
    if (pointParts.length > 2) {
      return VoiceParseResult.failure('Could not understand "$raw"');
    }

    num? parsed;
    if (pointParts.length == 2) {
      parsed = _parsePointExpression(pointParts[0], pointParts[1]);
    } else {
      final result = _parseSingleTokenStream(s);
      if (result.error != null) {
        return VoiceParseResult.failure(result.error!);
      }
      parsed = result.value;
    }

    if (parsed == null) {
      return VoiceParseResult.failure('Could not parse quantity from "$raw"');
    }

    return _validateDecimals(parsed, qtyDecimals: qtyDecimals);
  }

  static num? _parsePointExpression(String intStr, String fracStr) {
    final cleanedInt = _stripFillers(intStr);
    int intVal = 0;
    if (cleanedInt.isNotEmpty) {
      final intParsed = _parseSingleTokenStream(cleanedInt);
      if (intParsed.value == null || intParsed.value! % 1 != 0) return null;
      intVal = intParsed.value!.toInt();
    }

    final fracTokens = _tokenize(fracStr)
        .where((t) => !_fillerWords.contains(t))
        .toList();
    if (fracTokens.isEmpty) return null;

    final digitsBuffer = StringBuffer();
    if (fracTokens.every((t) => _units.containsKey(t) && _units[t]! < 10 || RegExp(r'^\d+$').hasMatch(t))) {
      for (final t in fracTokens) {
        if (RegExp(r'^\d+$').hasMatch(t)) {
          digitsBuffer.write(t);
        } else {
          digitsBuffer.write(_units[t]!);
        }
      }
    } else {
      final fracParsed = _parseSingleTokenStream(fracTokens.join(' '));
      if (fracParsed.value == null || fracParsed.value! % 1 != 0) return null;
      digitsBuffer.write(fracParsed.value!.toInt());
    }

    return double.tryParse('$intVal.$digitsBuffer');
  }

  static ({num? value, String? error}) _parseSingleTokenStream(String input) {
    final cleaned = _stripFillers(input);
    final tokens = _tokenize(cleaned);
    if (tokens.isEmpty) return (value: null, error: null);

    final values = <num>[];
    var i = 0;
    while (i < tokens.length) {
      final tok = tokens[i];
      if (_fillerWords.contains(tok)) {
        i++;
        continue;
      }

      final direct = num.tryParse(tok);
      if (direct != null) {
        values.add(direct);
        i++;
        continue;
      }

      if (_numWords.contains(tok)) {
        final run = <String>[tok];
        var j = i + 1;
        while (j < tokens.length && _numWords.contains(tokens[j])) {
          final prev = run.last;
          final next = tokens[j];
          final isCompoundTensUnit =
              _tens.containsKey(prev) && (_units[next] ?? 99) < 10 && (_units[next] ?? 0) > 0;
          final isMultiplier = next == 'hundred' || next == 'thousand';
          final followsMultiplier = prev == 'hundred' || prev == 'thousand';
          if (isCompoundTensUnit || isMultiplier || followsMultiplier) {
            run.add(next);
            j++;
          } else {
            break;
          }
        }
        values.add(_wordsToInt(run));
        i = j;
        continue;
      }

      // Unknown non-filler word -> not a clean quantity utterance.
      return (value: null, error: null);
    }

    if (values.isEmpty) return (value: null, error: null);
    if (values.length > 1) {
      return (
        value: null,
        error: 'Heard multiple numbers — say a single quantity',
      );
    }
    return (value: values.first, error: null);
  }

  static String _stripFillers(String input) {
    // Strip trailing sentence punctuation like ".", ",", "!" from tokens while
    // keeping decimal points inside numbers (e.g. "2.5").
    return input
        .replaceAll(RegExp(r'(?<!\d)[.,!?;:]+|[.,!?;:]+(?!\d)'), ' ')
        .trim();
  }

  static List<String> _tokenize(String input) =>
      input.split(RegExp(r'\s+')).where((t) => t.isNotEmpty).toList();

  static int _wordsToInt(List<String> words) {
    var total = 0;
    var current = 0;
    for (final w in words) {
      if (_units.containsKey(w)) {
        current += _units[w]!;
      } else if (_tens.containsKey(w)) {
        current += _tens[w]!;
      } else if (w == 'hundred') {
        current = (current == 0 ? 1 : current) * 100;
      } else if (w == 'thousand') {
        total += (current == 0 ? 1 : current) * 1000;
        current = 0;
      }
    }
    return total + current;
  }

  static VoiceParseResult _validateDecimals(
    num value, {
    required int qtyDecimals,
  }) {
    if (value < 0) {
      return const VoiceParseResult.failure('Quantity cannot be negative');
    }

    if (value == value.truncateToDouble()) {
      return VoiceParseResult.success(value.toInt());
    }

    if (qtyDecimals <= 0) {
      return const VoiceParseResult.failure(
        'Whole numbers only for this item',
      );
    }

    final factor = math.pow(10, qtyDecimals);
    final scaled = value * factor;
    if ((scaled - scaled.roundToDouble()).abs() > 1e-6) {
      return VoiceParseResult.failure(
        'At most $qtyDecimals decimal place${qtyDecimals == 1 ? '' : 's'} allowed',
      );
    }

    return VoiceParseResult.success(scaled.round() / factor);
  }
}
