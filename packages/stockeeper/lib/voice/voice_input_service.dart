import 'package:flutter/foundation.dart';
import 'package:speech_to_text/speech_recognition_error.dart';
import 'package:speech_to_text/speech_recognition_result.dart';
import 'package:speech_to_text/speech_to_text.dart';

/// Abstraction over platform speech recognition so UI widgets can be tested
/// without microphone hardware.
abstract class VoiceRecognizer {
  bool get isListening;

  Future<bool> startListening({
    required void Function(String partialWords) onPartial,
    required void Function(String finalWords) onFinal,
    required void Function(String message) onError,
    required VoidCallback onStopped,
  });

  Future<void> stop();

  Future<void> cancel();

  void dispose();
}

/// English (`en_US`) speech-to-text adapter backed by `speech_to_text`.
class SpeechToTextVoiceRecognizer implements VoiceRecognizer {
  SpeechToTextVoiceRecognizer([SpeechToText? speech])
      : _speech = speech ?? SpeechToText();

  final SpeechToText _speech;
  bool _initialized = false;
  bool _disposed = false;
  bool _active = false;
  bool _deliveredFinal = false;
  String _latestWords = '';

  void Function(String)? _onPartial;
  void Function(String)? _onFinal;
  void Function(String)? _onError;
  VoidCallback? _onStopped;

  @override
  bool get isListening => _active;

  @override
  Future<bool> startListening({
    required void Function(String partialWords) onPartial,
    required void Function(String finalWords) onFinal,
    required void Function(String message) onError,
    required VoidCallback onStopped,
  }) async {
    if (_disposed) return false;

    if (_active) {
      await cancel();
    }

    _onPartial = onPartial;
    _onFinal = onFinal;
    _onError = onError;
    _onStopped = onStopped;
    _deliveredFinal = false;
    _latestWords = '';

    if (!_initialized) {
      try {
        _initialized = await _speech.initialize(
          onError: _handleError,
          onStatus: _handleStatus,
        );
      } catch (e) {
        _onError?.call('Voice recognition failed to start: $e');
        return false;
      }

      if (!_initialized) {
        _onError?.call(
          'Voice recognition unavailable or microphone permission denied.',
        );
        return false;
      }
    }

    _active = true;
    try {
      await _speech.listen(
        onResult: _handleResult,
        listenOptions: SpeechListenOptions(
          localeId: 'en_US',
          listenFor: const Duration(seconds: 8),
          pauseFor: const Duration(seconds: 3),
          listenMode: ListenMode.confirmation,
          partialResults: true,
          cancelOnError: true,
        ),
      );
      return true;
    } catch (e) {
      _active = false;
      _onError?.call('Could not start listening: $e');
      return false;
    }
  }

  void _handleResult(SpeechRecognitionResult result) {
    if (_disposed || !_active) return;
    final words = result.recognizedWords.trim();
    if (words.isNotEmpty) {
      _latestWords = words;
      _onPartial?.call(words);
    }

    if (result.finalResult && !_deliveredFinal) {
      _deliveredFinal = true;
      _active = false;
      _onFinal?.call(words.isNotEmpty ? words : _latestWords);
    }
  }

  void _handleStatus(String status) {
    if (_disposed) return;
    if (status == 'notListening' || status == 'done') {
      if (_active) {
        _active = false;
        if (!_deliveredFinal && _latestWords.isNotEmpty) {
          _deliveredFinal = true;
          _onFinal?.call(_latestWords);
        } else {
          _onStopped?.call();
        }
      }
    }
  }

  void _handleError(SpeechRecognitionError error) {
    if (_disposed) return;
    final wasActive = _active;
    _active = false;
    if (!wasActive) return;
    _onError?.call(_friendlyError(error.errorMsg));
  }

  String _friendlyError(String code) {
    switch (code) {
      case 'error_permission':
        return 'Microphone permission denied. Enable it in App Settings.';
      case 'error_network':
      case 'error_network_timeout':
        return 'Network unavailable for speech recognition. Check Wi-Fi or install the Android offline English pack.';
      case 'error_no_match':
      case 'error_speech_timeout':
        return 'No speech recognized — tap mic and say the quantity clearly.';
      case 'error_audio':
        return 'Audio recording error — check microphone access.';
      case 'error_busy':
        return 'Speech recognizer is busy — please try again.';
      default:
        return 'Voice recognition failed ($code).';
    }
  }

  @override
  Future<void> stop() async {
    if (!_active) return;
    try {
      await _speech.stop();
    } catch (_) {}
  }

  @override
  Future<void> cancel() async {
    _active = false;
    _deliveredFinal = true;
    try {
      await _speech.cancel();
    } catch (_) {}
  }

  @override
  void dispose() {
    _disposed = true;
    _active = false;
    _onPartial = null;
    _onFinal = null;
    _onError = null;
    _onStopped = null;
    try {
      _speech.cancel();
    } catch (_) {}
  }
}
