import 'package:url_launcher/url_launcher.dart';

/// Desktop (Windows/Linux): hand the URL to the OS via `url_launcher`, which
/// ShellExecutes the https link so the default browser / WhatsApp picks it up.
/// Returns false when no handler could be launched.
Future<bool> openExternal(Uri uri) =>
    launchUrl(uri, mode: LaunchMode.externalApplication);
