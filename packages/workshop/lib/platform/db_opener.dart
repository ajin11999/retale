// Opens the workshop sembast database with the right factory per platform:
// a file under the documents dir on native, IndexedDB on web. The conditional
// export keeps `dart:io` (native) and `dart:html` (web) out of each other's
// compile target.
export 'db_opener_io.dart' if (dart.library.html) 'db_opener_web.dart';
