import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:sembast/sembast_io.dart';

/// Native (Windows/Linux/desktop): a single file in the app documents dir.
Future<Database> openWorkshopDb() async {
  final dir = await getApplicationDocumentsDirectory();
  final path = p.join(dir.path, 'retale_workshop.db');
  return databaseFactoryIo.openDatabase(path);
}
