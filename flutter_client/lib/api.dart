import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

import 'models.dart';

/// Client for the claude-chat hub. One instance per configured server address.
class CcApi {
  CcApi({required this.host, required this.port, required this.token});

  final String host;
  final int port;
  final String token;

  String get origin => 'http://$host:$port';
  Map<String, String> get _headers => {'authorization': 'Bearer $token'};

  Uri _uri(String path, [Map<String, String>? query]) =>
      Uri.http('$host:$port', path, query);

  Future<dynamic> _get(String path, [Map<String, String>? query]) async {
    final res = await http
        .get(_uri(path, query), headers: _headers)
        .timeout(const Duration(seconds: 45));
    return _decode(res);
  }

  Future<dynamic> _post(String path, Map<String, dynamic> body) async {
    final res = await http
        .post(
          _uri(path),
          headers: {..._headers, 'content-type': 'application/json'},
          body: jsonEncode(body),
        )
        // Creating a session waits for the TUI to settle, so allow plenty.
        .timeout(const Duration(seconds: 90));
    return _decode(res);
  }

  dynamic _decode(http.Response res) {
    dynamic body;
    try {
      body = jsonDecode(res.body);
    } catch (_) {
      body = null;
    }
    if (res.statusCode >= 400) {
      final message = (body is Map && body['error'] is String)
          ? body['error'] as String
          : 'request failed (${res.statusCode})';
      if (body is Map && body['code'] == 'pane-not-claude') {
        throw PaneNotClaudeException(message);
      }
      throw ApiException(message, res.statusCode);
    }
    return body;
  }

  Future<List<ServerRef>> servers() async {
    final data = await _get('/api/servers');
    return ((data['servers'] as List?) ?? [])
        .map((s) => ServerRef.fromJson(s as Map<String, dynamic>))
        .toList();
  }

  Future<List<SessionInfo>> sessions(String serverId, {bool fresh = false}) async {
    final data = await _get(
      '/api/servers/$serverId/sessions',
      fresh ? {'fresh': '1'} : null,
    );
    return ((data['sessions'] as List?) ?? [])
        .map((s) => SessionInfo.fromJson(s as Map<String, dynamic>))
        .toList();
  }

  /// One page of history. Omit [before] for the newest page; pass a previous
  /// page's cursor to fetch what precedes it.
  Future<HistoryPage> history(
    String serverId,
    String uuid, {
    int limit = 40,
    int? before,
  }) async {
    final data = await _get('/api/servers/$serverId/sessions/$uuid/history', {
      'limit': '$limit',
      if (before != null) 'before': '$before',
    });
    return HistoryPage.fromJson(data as Map<String, dynamic>);
  }

  Future<void> send(String serverId, String uuid, String text) =>
      _post('/api/servers/$serverId/sessions/$uuid/send', {'text': text});

  Future<void> sendKey(String serverId, String uuid, String key) =>
      _post('/api/servers/$serverId/sessions/$uuid/key', {'key': key});

  Future<String> peek(String serverId, String uuid) async {
    final data = await _get('/api/servers/$serverId/sessions/$uuid/peek');
    return data['text'] as String? ?? '';
  }

  Future<SessionDetail> info(String serverId, String uuid) async {
    return SessionDetail.fromJson(await _get('/api/servers/$serverId/sessions/$uuid/info'));
  }

  /// Send an image to a session. The hub writes it on the session's own machine
  /// and types the path into the pane, which is how Claude Code is handed an image.
  ///
  /// Raw bytes with a declared Content-Type rather than multipart: there is one
  /// file and no other fields, so multipart would only add a body to assemble on
  /// one side and parse on the other.
  Future<String> uploadImage(
    String serverId,
    String uuid,
    Uint8List bytes, {
    required String contentType,
    String caption = '',
  }) async {
    final res = await http
        .post(
          _uri('/api/servers/$serverId/sessions/$uuid/upload',
              caption.isEmpty ? null : {'caption': caption}),
          headers: {..._headers, 'content-type': contentType},
          body: bytes,
        )
        .timeout(const Duration(seconds: 120));
    final data = _decode(res) as Map<String, dynamic>;
    return data['path'] as String? ?? '';
  }

  Future<List<String>> dirs(String serverId) async {
    final data = await _get('/api/servers/$serverId/dirs');
    return ((data['dirs'] as List?) ?? []).map((d) => d as String).toList();
  }

  Future<String> createSession(
    String serverId,
    String dir, {
    required bool skipPermissions,
  }) async {
    final data = await _post('/api/servers/$serverId/sessions', {
      'dir': dir,
      'skipPermissions': skipPermissions,
    });
    return data['uuid'] as String? ?? '';
  }

  Future<List<TranscriptCandidate>> candidates(String serverId, String paneId) async {
    final data = await _get('/api/servers/$serverId/candidates', {'pane': paneId});
    return ((data['candidates'] as List?) ?? [])
        .map((c) => TranscriptCandidate.fromJson(c as Map<String, dynamic>))
        .toList();
  }

  Future<void> bind(String serverId, String paneId, String transcriptUuid) =>
      _post('/api/servers/$serverId/bind', {
        'pane': paneId,
        'transcriptUuid': transcriptUuid,
      });

  /// Does the hub have password login configured? Needs no credential.
  static Future<bool> passwordLoginAvailable({
    required String host,
    required int port,
  }) async {
    try {
      final res = await http
          .get(Uri.http('$host:$port', '/api/auth-mode'))
          .timeout(const Duration(seconds: 8));
      if (res.statusCode != 200) return false;
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      return body['passwordLogin'] == true;
    } catch (_) {
      return false;
    }
  }

  /// Exchange a username and password for a session token.
  ///
  /// Static because it runs before there is a credential to construct a client with.
  /// The password is sent once and never stored on the device — only the returned
  /// token is kept.
  static Future<String> login({
    required String host,
    required int port,
    required String username,
    required String password,
  }) async {
    final res = await http
        .post(
          Uri.http('$host:$port', '/api/login'),
          headers: {'content-type': 'application/json'},
          body: jsonEncode({'username': username, 'password': password}),
        )
        .timeout(const Duration(seconds: 30));

    dynamic body;
    try {
      body = jsonDecode(res.body);
    } catch (_) {
      body = null;
    }
    if (res.statusCode != 200) {
      final message = (body is Map && body['error'] is String)
          ? body['error'] as String
          : 'sign in failed (${res.statusCode})';
      throw ApiException(message, res.statusCode);
    }
    final token = (body as Map)['token'] as String?;
    if (token == null || token.isEmpty) throw ApiException('hub returned no token', 500);
    return token;
  }

  /// Current identity, or null when authenticated with the master token.
  Future<Map<String, dynamic>> me() async =>
      (await _get('/api/me')) as Map<String, dynamic>;

  /// Revoke this device's session server-side.
  Future<void> logout() => _post('/api/logout', const {});

  /// Cheap reachability probe used by the setup screen.
  Future<bool> ping() async {
    try {
      final res = await http
          .get(_uri('/api/health'), headers: _headers)
          .timeout(const Duration(seconds: 8));
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  WebSocketChannel connect({required String serverId, String? sessionUuid}) {
    final query = {
      'server': serverId,
      'token': token,
      'session': ?sessionUuid,
    };
    return WebSocketChannel.connect(Uri(
      scheme: 'ws',
      host: host,
      port: port,
      path: '/ws',
      queryParameters: query,
    ));
  }
}

/// A hub socket that reconnects with backoff and surfaces both message kinds.
///
/// The hub pushes the session list on an interval regardless of whether a single
/// session is being watched, so one socket keeps the list and the open chat live.
class CcSocket {
  CcSocket(this._api, {required this.serverId, this.sessionUuid});

  final CcApi _api;
  final String serverId;
  final String? sessionUuid;

  final _events = StreamController<List<ChatEvent>>.broadcast();
  final _sessions = StreamController<List<SessionInfo>>.broadcast();

  Stream<List<ChatEvent>> get events => _events.stream;
  Stream<List<SessionInfo>> get sessions => _sessions.stream;

  WebSocketChannel? _channel;
  StreamSubscription? _sub;
  Timer? _retry;
  Duration _backoff = const Duration(milliseconds: 500);
  bool _closed = false;

  void start() {
    if (_closed) return;
    try {
      final channel = _api.connect(serverId: serverId, sessionUuid: sessionUuid);
      _channel = channel;
      _sub = channel.stream.listen(
        _onMessage,
        onDone: _scheduleRetry,
        onError: (_) => _scheduleRetry(),
        cancelOnError: true,
      );
      _backoff = const Duration(milliseconds: 500);
    } catch (_) {
      _scheduleRetry();
    }
  }

  void _onMessage(dynamic raw) {
    Map<String, dynamic> msg;
    try {
      msg = jsonDecode(raw as String) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    switch (msg['type']) {
      case 'events':
        if (sessionUuid != null && msg['sessionUuid'] != sessionUuid) return;
        final list = ((msg['events'] as List?) ?? [])
            .map((e) => ChatEvent.fromJson(e as Map<String, dynamic>))
            .toList();
        if (list.isNotEmpty && !_events.isClosed) _events.add(list);
      case 'sessions':
        final list = ((msg['sessions'] as List?) ?? [])
            .map((s) => SessionInfo.fromJson(s as Map<String, dynamic>))
            .toList();
        if (!_sessions.isClosed) _sessions.add(list);
    }
  }

  void _scheduleRetry() {
    _sub?.cancel();
    _sub = null;
    _channel = null;
    if (_closed) return;
    _retry?.cancel();
    _retry = Timer(_backoff, start);
    final next = _backoff * 2;
    _backoff = next > const Duration(seconds: 15) ? const Duration(seconds: 15) : next;
  }

  Future<void> dispose() async {
    _closed = true;
    _retry?.cancel();
    await _sub?.cancel();
    await _channel?.sink.close();
    await _events.close();
    await _sessions.close();
  }
}
