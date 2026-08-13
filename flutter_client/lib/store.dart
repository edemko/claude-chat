import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// One hub the client knows how to reach, with the credential for it.
///
/// This is a different axis from the hub's own `servers.json`, which is one hub
/// reaching other machines over SSH. Here the phone talks to several hubs directly,
/// each with its own login.
@immutable
class Connection {
  const Connection({
    required this.id,
    required this.label,
    required this.host,
    required this.port,
    required this.token,
  });

  final String id;
  final String label;
  final String host;
  final int port;
  final String token;

  /// Host and port identify a hub, so they also make a stable id.
  static String idFor(String host, int port) => '$host:$port';

  String get origin => 'http://$host:$port';

  Map<String, dynamic> toJson() => {
        'id': id,
        'label': label,
        'host': host,
        'port': port,
        'token': token,
      };

  static Connection? fromJson(Map<String, dynamic> j) {
    final host = j['host'] as String?;
    final token = j['token'] as String?;
    if (host == null || host.isEmpty || token == null || token.isEmpty) return null;
    final port = (j['port'] as num?)?.toInt() ?? 7420;
    return Connection(
      id: j['id'] as String? ?? idFor(host, port),
      label: (j['label'] as String?)?.trim().isNotEmpty == true
          ? (j['label'] as String).trim()
          : host,
      host: host,
      port: port,
      token: token,
    );
  }
}

class Settings extends ChangeNotifier {
  static const _kConnections = 'cc-connections';
  static const _kActive = 'cc-active';
  static const _kTheme = 'cc-theme';
  // Keys written by the single-server builds, migrated on first load.
  static const _kLegacyHost = 'cc-host';
  static const _kLegacyPort = 'cc-port';
  static const _kLegacyToken = 'cc-token';

  List<Connection> connections = const [];
  String? activeId;
  ThemeMode themeMode = ThemeMode.system;

  Connection? get active {
    if (connections.isEmpty) return null;
    return connections.firstWhere(
      (c) => c.id == activeId,
      orElse: () => connections.first,
    );
  }

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();

    final raw = prefs.getString(_kConnections);
    if (raw != null) {
      try {
        connections = ((jsonDecode(raw) as List?) ?? [])
            .map((e) => Connection.fromJson(e as Map<String, dynamic>))
            .whereType<Connection>()
            .toList();
      } catch (_) {
        connections = const [];
      }
    }

    // Migrate a single-server install into the list.
    final legacyToken = prefs.getString(_kLegacyToken);
    if (connections.isEmpty && legacyToken != null && legacyToken.isNotEmpty) {
      final host = prefs.getString(_kLegacyHost) ?? '127.0.0.1';
      final port = prefs.getInt(_kLegacyPort) ?? 7420;
      connections = [
        Connection(
          id: Connection.idFor(host, port),
          label: host,
          host: host,
          port: port,
          token: legacyToken,
        ),
      ];
      await prefs.remove(_kLegacyToken);
      await _persist(prefs);
    }

    activeId = prefs.getString(_kActive) ?? connections.firstOrNull?.id;
    themeMode = switch (prefs.getString(_kTheme)) {
      'light' => ThemeMode.light,
      'dark' => ThemeMode.dark,
      _ => ThemeMode.system,
    };
    notifyListeners();
  }

  Future<void> _persist(SharedPreferences prefs) async {
    await prefs.setString(
      _kConnections,
      jsonEncode(connections.map((c) => c.toJson()).toList()),
    );
  }

  /// Add or replace a server, and make it the active one.
  Future<void> upsert(Connection conn) async {
    final list = [...connections];
    final at = list.indexWhere((c) => c.id == conn.id);
    if (at >= 0) {
      list[at] = conn;
    } else {
      list.add(conn);
    }
    connections = list;
    activeId = conn.id;

    final prefs = await SharedPreferences.getInstance();
    await _persist(prefs);
    await prefs.setString(_kActive, conn.id);
    notifyListeners();
  }

  Future<void> remove(String id) async {
    connections = connections.where((c) => c.id != id).toList();
    if (activeId == id) activeId = connections.firstOrNull?.id;

    final prefs = await SharedPreferences.getInstance();
    await _persist(prefs);
    if (activeId == null) {
      await prefs.remove(_kActive);
    } else {
      await prefs.setString(_kActive, activeId!);
    }
    notifyListeners();
  }

  Future<void> setActive(String id) async {
    if (activeId == id) return;
    activeId = id;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kActive, id);
    notifyListeners();
  }

  /// Sign out of the active server: forget it and fall back to whatever remains.
  Future<void> signOutActive() async {
    final current = active;
    if (current != null) await remove(current.id);
  }

  /// Cycles system → light → dark, matching the PWA's switcher.
  Future<void> cycleTheme() async {
    themeMode = switch (themeMode) {
      ThemeMode.system => ThemeMode.light,
      ThemeMode.light => ThemeMode.dark,
      ThemeMode.dark => ThemeMode.system,
    };
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kTheme, themeMode.name);
    notifyListeners();
  }

  String get themeLabel => switch (themeMode) {
        ThemeMode.system => 'follows system',
        ThemeMode.light => 'light',
        ThemeMode.dark => 'dark',
      };

  IconData get themeIcon => switch (themeMode) {
        ThemeMode.system => Icons.brightness_auto_outlined,
        ThemeMode.light => Icons.light_mode_outlined,
        ThemeMode.dark => Icons.dark_mode_outlined,
      };
}

/// Parsed form of the link the hub prints at startup.
class ConnectionLink {
  ConnectionLink(this.host, this.port, this.token);
  final String host;
  final int port;
  final String token;

  /// Accepts `http://100.64.0.1:7420/?t=<token>`, a bare `host:port`, or just a
  /// token, so pasting whatever is to hand works.
  static ConnectionLink? tryParse(
    String raw, {
    String fallbackHost = '',
    int fallbackPort = 7420,
  }) {
    final input = raw.trim();
    if (input.isEmpty) return null;

    if (input.contains('://')) {
      final uri = Uri.tryParse(input);
      if (uri == null || uri.host.isEmpty) return null;
      final token = uri.queryParameters['t'] ?? uri.queryParameters['token'] ?? '';
      if (token.isEmpty) return null;
      return ConnectionLink(uri.host, uri.hasPort ? uri.port : fallbackPort, token);
    }

    final match = RegExp(r'^([\w.-]+):(\d+)\D+([0-9a-f]{16,})$', caseSensitive: false)
        .firstMatch(input);
    if (match != null) {
      return ConnectionLink(match.group(1)!, int.parse(match.group(2)!), match.group(3)!);
    }

    if (RegExp(r'^[0-9a-f]{16,}$', caseSensitive: false).hasMatch(input) &&
        fallbackHost.isNotEmpty) {
      return ConnectionLink(fallbackHost, fallbackPort, input);
    }
    return null;
  }
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
