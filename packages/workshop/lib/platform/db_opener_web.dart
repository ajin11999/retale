import 'package:sembast_web/sembast_web.dart';

/// Web/PWA: persisted in the browser's IndexedDB under this database name.
Future<Database> openWorkshopDb() async {
  return databaseFactoryWeb.openDatabase('retale_workshop');
}
