import 'package:flutter/material.dart';

import 'api.dart';
import 'screens/sessions_screen.dart';
import 'screens/setup_screen.dart';
import 'store.dart';
import 'theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final settings = Settings();
  await settings.load();
  runApp(ClaudeChatApp(settings: settings));
}

class ClaudeChatApp extends StatelessWidget {
  const ClaudeChatApp({super.key, required this.settings});
  final Settings settings;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: settings,
      builder: (context, _) {
        final conn = settings.active;
        final api = conn == null
            ? null
            : CcApi(host: conn.host, port: conn.port, token: conn.token);

        return MaterialApp(
          title: 'Claude sessions',
          debugShowCheckedModeBanner: false,
          theme: buildTheme(Brightness.light),
          darkTheme: buildTheme(Brightness.dark),
          themeMode: settings.themeMode,
          home: api == null
              ? SetupScreen(settings: settings)
              // Keyed by server, so switching rebuilds the screen's state instead of
              // showing the previous server's sessions.
              : SessionsScreen(
                  key: ValueKey(conn!.id),
                  api: api,
                  settings: settings,
                ),
        );
      },
    );
  }
}
