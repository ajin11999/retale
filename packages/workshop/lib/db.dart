import 'package:isar/isar.dart';
import 'package:path_provider/path_provider.dart';
import 'package:retale_workshop/schema/project.dart';

/// Owns the single Isar instance for the app. Call [setup] once at startup
/// before any access to [db].
class DatabaseService {
  static late final Isar db;

  static Future<void> setup() async {
    final dir = await getApplicationDocumentsDirectory();
    db = await Isar.open([ProjectSchema], directory: dir.path);
  }
}
