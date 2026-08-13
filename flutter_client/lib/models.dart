// Wire types mirroring the hub's `src/types.ts`.

/// How confidently the hub matched a tmux pane to a transcript.
///
/// `pending` is not a poor match but the absence of one: the pane is running claude
/// and has written nothing yet, so there is no transcript to match against.
enum MatchConfidence { exact, strong, weak, pending }

MatchConfidence _confidence(String? raw) => switch (raw) {
      'exact' => MatchConfidence.exact,
      'strong' => MatchConfidence.strong,
      'pending' => MatchConfidence.pending,
      _ => MatchConfidence.weak,
    };

class SessionInfo {
  SessionInfo({
    required this.serverId,
    required this.uuid,
    required this.paneId,
    required this.tmuxSession,
    required this.cwd,
    required this.title,
    required this.working,
    required this.confidence,
    required this.lastActivity,
    required this.lastMessage,
    this.transcript = '',
    this.pid = 0,
    this.skipPermissions,
  });

  final String serverId;
  final String uuid;
  final String paneId;
  final String tmuxSession;
  final String cwd;
  final String title;
  final bool working;
  final MatchConfidence confidence;
  final DateTime? lastActivity;
  final String? lastMessage;
  /// Empty while the session has written nothing — see [MatchConfidence.pending].
  final String transcript;
  final int pid;
  /// null when the session predates this app and its launch flags are unknown.
  final bool? skipPermissions;

  /// Repo name — the most recognisable label for a session.
  String get repo {
    final parts = cwd.split('/').where((p) => p.isNotEmpty).toList();
    return parts.isEmpty ? cwd : parts.last;
  }

  factory SessionInfo.fromJson(Map<String, dynamic> j) => SessionInfo(
        serverId: j['serverId'] as String? ?? '',
        uuid: j['uuid'] as String? ?? '',
        paneId: j['paneId'] as String? ?? '',
        tmuxSession: j['tmuxSession'] as String? ?? '',
        cwd: j['cwd'] as String? ?? '',
        title: j['title'] as String? ?? 'session',
        working: j['status'] == 'working',
        confidence: _confidence(j['confidence'] as String?),
        lastActivity: j['lastActivity'] == null
            ? null
            : DateTime.fromMillisecondsSinceEpoch((j['lastActivity'] as num).toInt()),
        lastMessage: j['lastMessage'] as String?,
        transcript: j['transcript'] as String? ?? '',
        pid: (j['pid'] as num?)?.toInt() ?? 0,
        skipPermissions: j['skipPermissions'] as bool?,
      );
}

enum EventKind { user, assistant, tool, toolResult, title, system }

EventKind _kind(String? raw) => switch (raw) {
      'user' => EventKind.user,
      'assistant' => EventKind.assistant,
      'tool' => EventKind.tool,
      'tool_result' => EventKind.toolResult,
      'title' => EventKind.title,
      _ => EventKind.system,
    };

class ChatEvent {
  ChatEvent({
    required this.kind,
    required this.id,
    required this.ts,
    this.text = '',
    this.name = '',
    this.summary = '',
    this.toolUseId = '',
    this.ok = true,
    this.preview = '',
    this.title = '',
    this.custom = false,
  });

  final EventKind kind;
  final String id;
  final DateTime ts;
  final String text;
  final String name;
  final String summary;
  final String toolUseId;
  final bool ok;
  final String preview;
  final String title;
  /// True when the title came from `/rename` rather than the automatic titler.
  final bool custom;

  factory ChatEvent.fromJson(Map<String, dynamic> j) => ChatEvent(
        kind: _kind(j['kind'] as String?),
        id: j['id'] as String? ?? '',
        ts: DateTime.fromMillisecondsSinceEpoch((j['ts'] as num?)?.toInt() ?? 0),
        text: j['text'] as String? ?? '',
        name: j['name'] as String? ?? '',
        summary: j['summary'] as String? ?? '',
        toolUseId: j['toolUseId'] as String? ?? '',
        ok: j['ok'] as bool? ?? true,
        preview: j['preview'] as String? ?? '',
        title: j['title'] as String? ?? '',
        custom: j['custom'] as bool? ?? false,
      );
}

/// A transcript the hub thinks a pane *might* be running, for the picker.
class TranscriptCandidate {
  TranscriptCandidate({
    required this.uuid,
    required this.size,
    required this.title,
    required this.lastMessage,
    required this.lastActivity,
  });

  final String uuid;
  final int size;
  final String? title;
  final String? lastMessage;
  final DateTime? lastActivity;

  factory TranscriptCandidate.fromJson(Map<String, dynamic> j) => TranscriptCandidate(
        uuid: j['uuid'] as String? ?? '',
        size: (j['size'] as num?)?.toInt() ?? 0,
        title: j['title'] as String?,
        lastMessage: j['lastMessage'] as String?,
        lastActivity: j['lastActivity'] == null
            ? null
            : DateTime.fromMillisecondsSinceEpoch((j['lastActivity'] as num).toInt()),
      );
}

/// Detail for the info sheet: the pane's own status line plus derived facts.
class SessionDetail {
  SessionDetail({
    required this.statusLine,
    required this.model,
    required this.effort,
    required this.version,
    required this.gitBranch,
    required this.contextTokens,
    required this.userTurns,
    required this.assistantTurns,
    required this.toolCalls,
    required this.startedAt,
    required this.transcriptBytes,
    required this.uptimeSeconds,
  });

  /// Rendered status line as it appears in the pane, one entry per wrapped line.
  final List<String> statusLine;
  final String? model;
  final String? effort;
  final String? version;
  final String? gitBranch;
  final int? contextTokens;
  final int userTurns;
  final int assistantTurns;
  final int toolCalls;
  final DateTime? startedAt;
  final int? transcriptBytes;
  final int? uptimeSeconds;

  factory SessionDetail.fromJson(Map<String, dynamic> j) {
    final turns = (j['turns'] as Map<String, dynamic>?) ?? const {};
    int? asInt(Object? v) => v is num ? v.toInt() : null;
    return SessionDetail(
      statusLine: ((j['statusLine'] as List?) ?? const [])
          .map((e) => e.toString())
          .where((e) => e.trim().isNotEmpty)
          .toList(),
      model: j['model'] as String?,
      effort: j['effort'] as String?,
      version: j['version'] as String?,
      gitBranch: j['gitBranch'] as String?,
      contextTokens: asInt(j['contextTokens']),
      userTurns: asInt(turns['user']) ?? 0,
      assistantTurns: asInt(turns['assistant']) ?? 0,
      toolCalls: asInt(turns['tools']) ?? 0,
      startedAt: j['startedAt'] == null
          ? null
          : DateTime.fromMillisecondsSinceEpoch((j['startedAt'] as num).toInt()),
      transcriptBytes: asInt(j['transcriptBytes']),
      uptimeSeconds: asInt(j['uptimeSeconds']),
    );
  }
}

class ServerRef {
  ServerRef({required this.id, required this.label});
  final String id;
  final String label;

  factory ServerRef.fromJson(Map<String, dynamic> j) =>
      ServerRef(id: j['id'] as String? ?? '', label: j['label'] as String? ?? '');
}

/// Raised when the pane is no longer running claude, so nothing was sent.
class PaneNotClaudeException implements Exception {
  PaneNotClaudeException(this.message);
  final String message;
  @override
  String toString() => message;
}

class ApiException implements Exception {
  ApiException(this.message, this.status);
  final String message;
  final int status;
  @override
  String toString() => message;
}

/// One page of history plus the cursor for fetching what precedes it.
class HistoryPage {
  HistoryPage({required this.events, required this.cursor, required this.hasMore});

  final List<ChatEvent> events;
  final int cursor;
  final bool hasMore;

  factory HistoryPage.fromJson(Map<String, dynamic> j) => HistoryPage(
        events: ((j['events'] as List?) ?? [])
            .map((e) => ChatEvent.fromJson(e as Map<String, dynamic>))
            .toList(),
        cursor: (j['cursor'] as num?)?.toInt() ?? 0,
        hasMore: j['hasMore'] as bool? ?? false,
      );
}
