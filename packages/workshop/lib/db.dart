import 'package:sembast/sembast.dart';
import 'package:retale_workshop/platform/db_opener.dart';

/// Owns the single sembast [Database] for the app and the `projects` store.
/// Call [setup] once at startup before any access to [db].
class DatabaseService {
  static late final Database db;

  /// Job documents, keyed by auto-incrementing int (mirrored onto `Project.id`).
  static final StoreRef<int, Map<String, Object?>> projects =
      intMapStoreFactory.store('projects');

  static Future<void> setup() async {
    db = await openWorkshopDb();
  }
}
