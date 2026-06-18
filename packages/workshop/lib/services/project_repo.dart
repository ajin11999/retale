import 'package:sembast/sembast.dart';
import 'package:retale_workshop/db.dart';
import 'package:retale_workshop/schema/project.dart';

/// Local CRUD over the sembast `projects` document store. Each job is a single
/// JSON document, so every mutation loads the record, edits it in memory, and
/// writes the whole document back (inside a transaction).
class ProjectRepo {
  final Database _db = DatabaseService.db;
  final StoreRef<int, Map<String, Object?>> _store = DatabaseService.projects;

  /// Jobs not yet uploaded, pinned first then newest first.
  static final Finder _activeFinder =
      Finder(filter: Filter.equals('isUploaded', false));

  List<Project> _sortActive(
      List<RecordSnapshot<int, Map<String, Object?>>> records) {
    final jobs = [for (final r in records) Project.fromJson(r.key, r.value)];
    jobs.sort((a, b) {
      if (a.isPinned != b.isPinned) return a.isPinned ? -1 : 1;
      return b.date.compareTo(a.date);
    });
    return jobs;
  }

  /// Live list of active jobs — emits the current set immediately, then on
  /// every change.
  Stream<List<Project>> watchActive() =>
      _store.query(finder: _activeFinder).onSnapshots(_db).map(_sortActive);

  /// Live view of one job — emits immediately, then on every change; null once
  /// the record is deleted.
  Stream<Project?> watch(int id) => _store.record(id).onSnapshot(_db).map(
      (snap) => snap == null ? null : Project.fromJson(snap.key, snap.value));

  Future<Project?> get(int id) async {
    final value = await _store.record(id).get(_db);
    if (value == null) return null;
    return Project.fromJson(id, value);
  }

  Future<Project> create() async {
    final p = Project()..date = DateTime.now();
    final id = await _store.add(_db, p.toJson());
    return p..id = id;
  }

  Future<void> _mutate(int id, void Function(Project) edit) async {
    await _db.transaction((txn) async {
      final value = await _store.record(id).get(txn);
      if (value == null) return;
      final p = Project.fromJson(id, value);
      edit(p);
      await _store.record(id).put(txn, p.toJson());
    });
  }

  Future<void> saveHeader(
    int id, {
    required String label,
    required String vehicle,
    required String memo,
    required DateTime date,
  }) =>
      _mutate(id, (p) {
        p.label = label;
        p.vehicle = vehicle;
        p.memo = memo;
        p.date = date;
      });

  Future<void> saveLines(int id, List<WorkLine> lines) =>
      _mutate(id, (p) => p.lines = lines);

  Future<void> addPayment(int id, WorkPayment payment) =>
      _mutate(id, (p) => p.payments = [...p.payments, payment]);

  Future<void> togglePin(int id) =>
      _mutate(id, (p) => p.isPinned = !p.isPinned);

  Future<void> markUploaded(int id, String orderId) => _mutate(id, (p) {
        p.isUploaded = true;
        p.uploadedOrderId = orderId;
        p.uploadedAt = DateTime.now();
      });

  Future<void> delete(int id) => _store.record(id).delete(_db);
}
