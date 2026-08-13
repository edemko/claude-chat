import 'dart:async';

import 'package:flutter/material.dart';

import '../api.dart';
import '../build_info.dart';
import '../models.dart';
import '../store.dart';
import '../theme.dart';
import '../widgets.dart';
import 'add_server_screen.dart';
import 'chat_screen.dart';

/// The session list: which sessions are running, and which one wants you.
class SessionsScreen extends StatefulWidget {
  const SessionsScreen({super.key, required this.api, required this.settings});
  final CcApi api;
  final Settings settings;

  @override
  State<SessionsScreen> createState() => _SessionsScreenState();
}

class _SessionsScreenState extends State<SessionsScreen> with WidgetsBindingObserver {
  List<SessionInfo> _sessions = [];
  String? _serverId;
  String _serverLabel = 'connecting…';
  String? _error;
  bool _loading = true;

  CcSocket? _socket;
  Timer? _poll;
  // Relative timestamps go stale silently, so redraw them on a slow tick.
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _bootstrap();
    _ticker = Timer.periodic(const Duration(seconds: 30), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _poll?.cancel();
    _ticker?.cancel();
    _socket?.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _refresh(fresh: true);
  }

  Future<void> _bootstrap() async {
    try {
      final servers = await widget.api.servers();
      if (!mounted) return;
      if (servers.isEmpty) {
        setState(() {
          _loading = false;
          _error = 'The hub has no servers configured.';
        });
        return;
      }
      setState(() {
        _serverId = servers.first.id;
        _serverLabel = servers.first.label;
      });
      await _refresh(fresh: true);
      _openSocket();
    } catch (err) {
      if (!mounted) return;
      if (err is ApiException && err.status == 401) {
        await widget.settings.signOutActive();
        return;
      }
      setState(() {
        _loading = false;
        _serverLabel = 'not connected';
        _error = '$err';
      });
    }
  }

  /// Who is signed in, on how many devices, and the way out.
  Future<void> _openAccount() async {
    Map<String, dynamic>? me;
    try {
      me = await widget.api.me();
    } catch (_) {
      // Show what is known locally rather than nothing.
    }
    if (!mounted) return;
    final cc = context.cc;
    final username = me?['username'] as String?;

    await showModalBottomSheet<void>(
      context: context,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 16, 8, 12),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      'Account',
                      style: TextStyle(
                        color: cc.text,
                        fontSize: 17,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  IconButton(
                    icon: Icon(Icons.close, color: cc.muted, size: 21),
                    onPressed: () => Navigator.of(sheetContext).pop(),
                  ),
                ],
              ),
            ),
            Divider(height: 1, color: cc.line),
            ListTile(
              title: Text('Server', style: TextStyle(color: cc.muted, fontSize: 14)),
              trailing: MetaText(
                '${widget.settings.active?.host ?? "—"}'
                ':${widget.settings.active?.port ?? ""}',
              ),
            ),
            Divider(height: 1, color: cc.line),
            ListTile(
              title: Text('Signed in as', style: TextStyle(color: cc.muted, fontSize: 14)),
              trailing: MetaText(username ?? '— (master token)'),
            ),
            if (me != null) ...[
              Divider(height: 1, color: cc.line),
              ListTile(
                title: Text('Devices', style: TextStyle(color: cc.muted, fontSize: 14)),
                trailing: MetaText('${me['devices']}'),
              ),
            ],
            Divider(height: 1, color: cc.line),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 20),
              child: OutlinedButton(
                onPressed: () async {
                  Navigator.of(sheetContext).pop();
                  if (username != null) {
                    // Best effort: forget it locally even if the hub is unreachable.
                    try {
                      await widget.api.logout();
                    } catch (_) {}
                  }
                  await widget.settings.signOutActive();
                },
                style: OutlinedButton.styleFrom(
                  minimumSize: const Size(0, 48),
                  foregroundColor: cc.bad,
                  side: BorderSide(color: cc.bad.withValues(alpha: 0.4)),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(11),
                  ),
                ),
                child: Text(username != null ? 'Sign out' : 'Forget this token'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _openSocket() {
    final serverId = _serverId;
    if (serverId == null) return;
    _socket?.dispose();
    final socket = CcSocket(widget.api, serverId: serverId);
    socket.sessions.listen((list) {
      if (mounted) setState(() => _sessions = list);
    });
    socket.start();
    _socket = socket;
  }

  Future<void> _refresh({bool fresh = false}) async {
    final serverId = _serverId;
    if (serverId == null) return;
    try {
      final list = await widget.api.sessions(serverId, fresh: fresh);
      if (!mounted) return;
      setState(() {
        _sessions = list;
        _loading = false;
        _error = null;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = '$err';
      });
    }
  }

  void _toast(String message, {bool bad = false}) {
    if (!mounted) return;
    final cc = context.cc;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(message, style: TextStyle(color: bad ? cc.bad : cc.text)),
      duration: Duration(seconds: bad ? 5 : 3),
    ));
  }

  Future<void> _openChat(SessionInfo session) async {
    final serverId = _serverId;
    if (serverId == null) return;
    await Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => ChatScreen(api: widget.api, serverId: serverId, session: session),
    ));
    if (mounted) _refresh(fresh: true);
  }

  Future<void> _newSession() async {
    final serverId = _serverId;
    if (serverId == null) return;

    final choice = await showModalBottomSheet<NewSessionChoice>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _NewSessionSheet(api: widget.api, serverId: serverId),
    );
    if (choice == null || !mounted) return;

    _toast('Starting Claude in ${choice.dir.split('/').last}…');
    try {
      final uuid = await widget.api.createSession(
        serverId,
        choice.dir,
        skipPermissions: choice.skipPermissions,
      );
      await _refresh(fresh: true);
      if (!mounted) return;
      final created = _sessions.where((s) => s.uuid == uuid).firstOrNull;
      if (created != null) {
        _openChat(created);
      } else {
        _toast('Session started, but it is not listed yet.', bad: true);
      }
    } catch (err) {
      _toast('$err', bad: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final cc = context.cc;

    return Scaffold(
      appBar: AppBar(
        titleSpacing: 16,
        title: InkWell(
          onTap: _openAccount,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Sessions'),
              const SizedBox(height: 2),
              MetaText(_serverLabel),
            ],
          ),
        ),
        actions: [
          IconButton(
            tooltip: 'Theme ${widget.settings.themeLabel}',
            icon: Icon(widget.settings.themeIcon, color: cc.muted, size: 21),
            onPressed: () async {
              await widget.settings.cycleTheme();
              if (mounted) _toast('Theme ${widget.settings.themeLabel}');
            },
          ),
          IconButton(
            tooltip: 'Refresh',
            icon: Icon(Icons.refresh, color: cc.muted, size: 21),
            onPressed: () => _refresh(fresh: true),
          ),
          IconButton(
            tooltip: 'New session',
            icon: Icon(Icons.add, color: cc.muted, size: 23),
            onPressed: _newSession,
          ),
          const SizedBox(width: 4),
        ],
      ),
      drawer: _serverDrawer(),
      body: RefreshIndicator(
        color: cc.you,
        backgroundColor: cc.panel,
        onRefresh: () => _refresh(fresh: true),
        child: _buildBody(),
      ),
    );
  }

  /// Server browser. Each entry is a hub with its own stored credential, so
  /// tapping one goes straight to its sessions.
  Widget _serverDrawer() {
    final cc = context.cc;
    final settings = widget.settings;

    return Drawer(
      backgroundColor: cc.ink,
      shape: Border(right: BorderSide(color: cc.line)),
      child: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 18, 16, 14),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      'Servers',
                      style: TextStyle(
                        color: cc.text,
                        fontSize: 18,
                        fontWeight: FontWeight.w600,
                        letterSpacing: -0.2,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            Divider(height: 1, color: cc.line),
            Expanded(
              child: settings.connections.isEmpty
                  ? const EmptyState(
                      title: 'No servers yet',
                      body: 'Add one to see its Claude sessions.',
                    )
                  : ListView.separated(
                      padding: EdgeInsets.zero,
                      itemCount: settings.connections.length,
                      separatorBuilder: (context, _) =>
                          Divider(height: 1, color: cc.line),
                      itemBuilder: (context, i) {
                        final conn = settings.connections[i];
                        final isActive = conn.id == settings.active?.id;
                        return ListTile(
                          selected: isActive,
                          selectedTileColor: cc.panel,
                          title: Text(
                            conn.label,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              color: isActive ? cc.you : cc.text,
                              fontSize: 15,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          subtitle: MetaText('${conn.host}:${conn.port}'),
                          trailing: IconButton(
                            icon: Icon(Icons.close, size: 17, color: cc.muted),
                            tooltip: 'Remove ${conn.label}',
                            onPressed: () async {
                              Navigator.of(context).pop();
                              await settings.remove(conn.id);
                            },
                          ),
                          onTap: () async {
                            Navigator.of(context).pop();
                            // Switching notifies Settings; main.dart rebuilds the
                            // screen with a new key, so nothing stale survives.
                            await settings.setActive(conn.id);
                          },
                        );
                      },
                    ),
            ),
            Divider(height: 1, color: cc.line),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
              child: OutlinedButton.icon(
                icon: const Icon(Icons.add, size: 19),
                label: const Text('Add a server'),
                style: OutlinedButton.styleFrom(
                  minimumSize: const Size(0, 48),
                  foregroundColor: cc.text,
                  side: BorderSide(color: cc.line),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(11),
                  ),
                ),
                onPressed: () async {
                  Navigator.of(context).pop();
                  final added = await Navigator.of(context).push<String>(
                    MaterialPageRoute(
                      builder: (_) => AddServerScreen(settings: widget.settings),
                    ),
                  );
                  if (added != null && mounted) _toast('Added $added');
                },
              ),
            ),
            // Which build is installed, reachable without opening a chat — the
            // APK arrives by file sync, so nothing else announces the version.
            Padding(
              padding: const EdgeInsets.only(left: 16, right: 16, bottom: 14),
              child: MetaText(buildLabel),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildBody() {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_sessions.isEmpty) {
      // ListView keeps pull-to-refresh usable on an empty screen.
      return ListView(
        children: [
          SizedBox(
            height: MediaQuery.sizeOf(context).height * 0.6,
            child: _error != null
                ? EmptyState(title: 'Cannot reach the hub', body: _error!)
                : const EmptyState(
                    title: 'No sessions running',
                    body: 'Tap + to start Claude in one of your repos.',
                  ),
          ),
        ],
      );
    }

    return ListView.separated(
      itemCount: _sessions.length,
      separatorBuilder: (context, _) => Divider(height: 1, color: context.cc.line),
      itemBuilder: (context, i) => _SessionTile(
        session: _sessions[i],
        onTap: () => _openChat(_sessions[i]),
      ),
    );
  }
}

class _SessionTile extends StatelessWidget {
  const _SessionTile({required this.session, required this.onTap});
  final SessionInfo session;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final cc = context.cc;

    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 7, right: 12),
              child: Bead(working: session.working),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // The repo leads the title in the accent colour. Session names
                  // repeat across projects — two panes were both called
                  // "implementing MEGA bucket" — and the project is what actually
                  // identifies a row, so it must not be buried in the meta line.
                  // First in the span, so it is never the part that gets ellipsised.
                  Text.rich(
                    TextSpan(children: [
                      TextSpan(
                        text: session.repo,
                        style: TextStyle(
                          color: cc.strong,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      TextSpan(
                        text: '  ${session.title}',
                        style: TextStyle(color: cc.text),
                      ),
                    ]),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                      letterSpacing: -0.15,
                    ),
                  ),
                  const SizedBox(height: 3),
                  Row(
                    children: [
                      // "pane %20", never a bare "%20" — which reads as a percentage.
                      Expanded(child: MetaText('pane ${session.paneId}')),
                      MetaText(relativeTime(session.lastActivity)),
                    ],
                  ),
                  if (session.lastMessage != null) ...[
                    const SizedBox(height: 5),
                    Text(
                      session.lastMessage!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: cc.muted, fontSize: 13),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Repo picker for a new session.
class _NewSessionSheet extends StatefulWidget {
  const _NewSessionSheet({required this.api, required this.serverId});
  final CcApi api;
  final String serverId;

  @override
  State<_NewSessionSheet> createState() => _NewSessionSheetState();
}

class _NewSessionSheetState extends State<_NewSessionSheet> {
  List<String>? _dirs;
  String? _error;
  bool _skip = true;

  @override
  void initState() {
    super.initState();
    widget.api.dirs(widget.serverId).then((dirs) {
      if (mounted) setState(() => _dirs = dirs);
    }).catchError((Object err) {
      if (mounted) setState(() => _error = '$err');
    });
  }

  @override
  Widget build(BuildContext context) {
    final cc = context.cc;
    final dirs = _dirs;

    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.84,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 16, 8, 12),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      'New session',
                      style: TextStyle(
                        color: cc.text,
                        fontSize: 17,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  IconButton(
                    icon: Icon(Icons.close, color: cc.muted, size: 21),
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
            ),
            Divider(height: 1, color: cc.line),
            SwitchListTile(
              value: _skip,
              onChanged: (v) => setState(() => _skip = v),
              activeThumbColor: cc.you,
              title: Text(
                'Skip permission prompts',
                style: TextStyle(color: cc.text, fontSize: 14),
              ),
              subtitle: Text(
                'The session acts without asking',
                style: TextStyle(color: cc.muted, fontSize: 12.5),
              ),
            ),
            Divider(height: 1, color: cc.line),
            Expanded(
              child: _error != null
                  ? EmptyState(title: 'Could not list repos', body: _error!)
                  : dirs == null
                      ? const Center(child: CircularProgressIndicator())
                      : dirs.isEmpty
                          ? const EmptyState(
                              title: 'No repos found',
                              body: 'Set CC_REPO_ROOTS on the hub.',
                            )
                          : ListView.separated(
                              itemCount: dirs.length,
                              separatorBuilder: (context, _) =>
                                  Divider(height: 1, color: cc.line),
                              itemBuilder: (context, i) => ListTile(
                                title: Text(
                                  dirs[i].split('/').last,
                                  style: TextStyle(
                                    fontFamily: monoFamily,
                                    fontSize: 13.5,
                                    color: cc.text,
                                  ),
                                ),
                                subtitle: MetaText(dirs[i]),
                                onTap: () => Navigator.of(context).pop(
                                  NewSessionChoice(dirs[i], _skip),
                                ),
                              ),
                            ),
            ),
          ],
        ),
      ),
    );
  }
}

/// What the new-session sheet hands back: the repo, and how it should run.
class NewSessionChoice {
  const NewSessionChoice(this.dir, this.skipPermissions);
  final String dir;
  final bool skipPermissions;
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
