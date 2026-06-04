import 'package:flutter/material.dart';
import 'package:graphql_flutter/graphql_flutter.dart';
import 'package:retale_workshop/app_gate.dart';
import 'package:retale_workshop/db.dart';
import 'package:retale_workshop/graphql/client.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await initHiveForFlutter(); // graphql_flutter cache store
  await DatabaseService.setup();
  runApp(const WorkshopApp());
}

class WorkshopApp extends StatelessWidget {
  const WorkshopApp({super.key});

  @override
  Widget build(BuildContext context) {
    return GraphQLProvider(
      client: AppGraphQL.notifier,
      child: MaterialApp(
        title: 'Retale Workshop',
        theme: ThemeData(
          colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
          useMaterial3: true,
        ),
        home: const AppGate(),
      ),
    );
  }
}
