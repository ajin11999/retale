import 'package:isar/isar.dart';
import 'package:retale_workshop/db.dart';
import 'package:retale_workshop/schema/project.dart';

/// Local CRUD over the Isar `Project` store. Embedded line/payment lists can't
/// be updated in isolation, so every mutation loads the project, edits it in
/// memory, and writes the whole object back.
class ProjectRepo {
  final Isar _db = DatabaseService.db;

  /// Jobs not yet uploaded, pinned first then newest first. Live query.
  Query<Project> activeQuery() => _db.projects
      .filter()
      .isUploadedEqualTo(false)
      .sortByIsPinnedDesc()
      .thenByDateDesc()
      .build();

  Future<Project?> get(int id) async {
    final p = await _db.projects.get(id);
    if (p == null) return null;
    // Isar hands embedded lists back fixed-length, but the UI mutates them in
    // place (add/remove/reorder) — copy them growable, recursively.
    p.lines = _growable(p.lines);
    p.payments = List.of(p.payments);
    return p;
  }

  static List<WorkLine> _growable(List<WorkLine> lines) {
    for (final line in lines) {
      final children = line.children;
      if (children != null) line.children = _growable(children);
    }
    return List.of(lines);
  }

  Future<Project> create() async {
    final p = Project()..date = DateTime.now();
    await _db.writeTxn(() => _db.projects.put(p));
    return p;
  }

  Future<void> _mutate(int id, void Function(Project) edit) async {
    await _db.writeTxn(() async {
      final p = await _db.projects.get(id);
      if (p == null) return;
      edit(p);
      await _db.projects.put(p);
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

  Future<void> delete(int id) async {
    await _db.writeTxn(() => _db.projects.delete(id));
  }
}
