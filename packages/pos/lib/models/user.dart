/// The authenticated clerk/root user, as returned inside an AuthPayload.
class AppUser {
  AppUser({
    required this.id,
    required this.username,
    required this.name,
    required this.isRoot,
  });

  final String id;
  final String username;
  final String name;
  final bool isRoot;

  factory AppUser.fromJson(Map<String, dynamic> j) => AppUser(
        id: j['id'] as String,
        username: j['username'] as String,
        name: j['name'] as String,
        isRoot: j['isRoot'] as bool? ?? false,
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'username': username,
        'name': name,
        'isRoot': isRoot,
      };
}
