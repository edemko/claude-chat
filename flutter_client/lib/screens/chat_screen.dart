import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';

import '../api.dart';
import '../build_info.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets.dart';

/// One Claude session as a conversation.
class ChatScreen extends StatefulWidget {
  const ChatScreen({
    super.key,
    required this.api,
    required this.serverId,
    required this.session,
  });

  final CcApi api;
  final String serverId;
  final SessionInfo session;

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _scroll = ScrollController();
  final _compose = TextEditingController();

  final List<ChatEvent> _events = [];
  final Set<String> _seen = {};

  /// tool_use_id -> result; a result can arrive before or after its chip.
  final Map<String, ChatEvent> _results = {};

  late SessionInfo _session = widget.session;
  CcSocket? _socket;
  bool _loading = true;

  /// Byte offset of the oldest loaded record; `before` for the next page.
  int? _cursor;
  bool _hasMore = false;
  bool _loadingOlder = false;

  /// A `/rename` outranks the automatic title, whichever arrives later.
  bool _titleIsCustom = false;
  bool _sending = false;
  bool _uploading = false;
  String? _noticeText;
  bool _noticeBad = false;
  bool _showGuessNotice = false;

  @override
  void initState() {
    super.initState();
    _showGuessNotice = _session.confidence == MatchConfidence.weak;
    _compose.addListener(() => setState(() {}));
    // The list is reversed, so its far end is the oldest message.
    _scroll.addListener(() {
      if (!_scroll.hasClients) return;
      if (_scroll.position.pixels > _scroll.position.maxScrollExtent - 400) {
        _loadOlder();
      }
    });
    _load();
  }

  @override
  void dispose() {
    _socket?.dispose();
    _scroll.dispose();
    _compose.dispose();
    super.dispose();
  }

  /// Opening page: roughly two screenfuls. Older pages load on scroll.
  static const _pageSize = 40;

  Future<void> _load() async {
    try {
      final page = await widget.api.history(
        widget.serverId,
        _session.uuid,
        limit: _pageSize,
      );
      if (!mounted) return;
      setState(() {
        _absorb(page.events);
        _cursor = page.cursor;
        _hasMore = page.hasMore;
        _loading = false;
      });
      // No scrolling needed: the list is reversed, so offset 0 is the newest
      // message and that is where it opens.
    } catch (err) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _noticeText = '$err';
        _noticeBad = true;
      });
    }
    _openSocket();
  }

  void _openSocket() {
    _socket?.dispose();
    final socket = CcSocket(
      widget.api,
      serverId: widget.serverId,
      sessionUuid: _session.uuid,
    );
    socket.events.listen((batch) {
      if (!mounted) return;
      // Appending to a reversed list puts the new message at the bottom, where the
      // view already sits.
      setState(() => _absorb(batch));
    });
    // The hub pushes the list on the same socket; use it to keep the header live.
    // Matched on paneId rather than uuid, because the pane is what a session really
    // is: one opened before its first message has no transcript, and gains a uuid the
    // moment that message lands. A `/clear` swaps the uuid the same way.
    socket.sessions.listen((list) {
      if (!mounted) return;
      final fresh = list.where((s) => s.paneId == _session.paneId).firstOrNull;
      if (fresh == null) return;
      final swapped = fresh.uuid != _session.uuid;
      setState(() => _session = fresh);
      if (swapped) _reattach();
    });
    socket.start();
    _socket = socket;
  }

  /// The pane is now writing a different transcript. Drop what was loaded and read
  /// the new one; `_load` reopens the socket against it.
  void _reattach() {
    setState(() {
      _events.clear();
      _seen.clear();
      _results.clear();
      _cursor = null;
      _hasMore = false;
      _titleIsCustom = false;
      _showGuessNotice = _session.confidence == MatchConfidence.weak;
      _loading = true;
    });
    _load();
  }

  /// Older events, inserted before everything loaded so far.
  void _absorbOlder(List<ChatEvent> incoming) {
    final fresh = <ChatEvent>[];
    for (final event in incoming) {
      switch (event.kind) {
        case EventKind.toolResult:
          _results[event.toolUseId] = event;
        case EventKind.title:
        case EventKind.system:
          break;
        default:
          if (_seen.add(event.id)) fresh.add(event);
      }
    }
    _events.insertAll(0, fresh);
  }

  /// Adds events, deduplicating by id so the tail overlap on reconnect is harmless.
  void _absorb(List<ChatEvent> incoming) {
    for (final event in incoming) {
      switch (event.kind) {
        case EventKind.title:
          // Claude Code writes an ai-title after every custom-title, so a plain
          // "latest wins" rule would silently undo a /rename.
          if (!event.custom && _titleIsCustom) break;
          if (event.custom) _titleIsCustom = true;
          if (event.title.isNotEmpty) {
            _session = SessionInfo(
              serverId: _session.serverId,
              uuid: _session.uuid,
              paneId: _session.paneId,
              tmuxSession: _session.tmuxSession,
              cwd: _session.cwd,
              title: event.title,
              working: _session.working,
              confidence: _session.confidence,
              lastActivity: _session.lastActivity,
              lastMessage: _session.lastMessage,
              transcript: _session.transcript,
              pid: _session.pid,
              skipPermissions: _session.skipPermissions,
            );
          }
        case EventKind.toolResult:
          _results[event.toolUseId] = event;
        case EventKind.system:
          break;
        default:
          if (_seen.add(event.id)) _events.add(event);
      }
    }
  }

  /// Fetch the page preceding what is loaded. Prepending to a reversed list does
  /// not move the viewport, so no scroll compensation is needed.
  Future<void> _loadOlder() async {
    if (_loadingOlder || !_hasMore || _cursor == null) return;
    setState(() => _loadingOlder = true);
    try {
      final page = await widget.api.history(
        widget.serverId,
        _session.uuid,
        limit: _pageSize,
        before: _cursor,
      );
      if (!mounted) return;
      setState(() {
        _absorbOlder(page.events);
        _cursor = page.cursor;
        _hasMore = page.hasMore;
      });
    } catch (err) {
      if (mounted) _toast('$err', bad: true);
    } finally {
      if (mounted) setState(() => _loadingOlder = false);
    }
  }

  void _toast(String message, {bool bad = false}) {
    if (!mounted) return;
    final cc = context.cc;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message, style: TextStyle(color: bad ? cc.bad : cc.text)),
        duration: Duration(seconds: bad ? 5 : 3),
      ),
    );
  }

  Future<void> _send() async {
    final text = _compose.text;
    if (text.trim().isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      await widget.api.send(widget.serverId, _session.uuid, text);
      _compose.clear();
    } on PaneNotClaudeException catch (err) {
      setState(() {
        _noticeText =
            'This session has exited — the pane is back at a shell, so '
            'nothing was sent.';
        _noticeBad = true;
      });
      _toast('$err', bad: true);
    } catch (err) {
      _toast('$err', bad: true);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _sendKey(String key) async {
    try {
      await widget.api.sendKey(widget.serverId, _session.uuid, key);
    } catch (err) {
      _toast('$err', bad: true);
    }
  }

  Future<void> _peek() async {
    try {
      final text = await widget.api.peek(widget.serverId, _session.uuid);
      if (!mounted) return;
      final cc = context.cc;
      await showDialog<void>(
        context: context,
        builder: (context) => Dialog(
          backgroundColor: cc.ink,
          insetPadding: const EdgeInsets.all(14),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
            side: BorderSide(color: cc.line),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 14, 8, 8),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        'Pane ${_session.paneId}',
                        style: TextStyle(
                          color: cc.text,
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                    IconButton(
                      icon: Icon(Icons.close, color: cc.muted, size: 20),
                      onPressed: () => Navigator.of(context).pop(),
                    ),
                  ],
                ),
              ),
              Divider(height: 1, color: cc.line),
              Flexible(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.all(12),
                  child: SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: Text(
                      text,
                      style: TextStyle(
                        fontFamily: monoFamily,
                        fontSize: 10.5,
                        height: 1.35,
                        color: cc.muted,
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      );
    } catch (err) {
      _toast('$err', bad: true);
    }
  }

  /// Pick an image and send it. The compose box doubles as its caption.
  Future<void> _sendImage() async {
    final XFile? picked;
    try {
      picked = await ImagePicker().pickImage(
        source: ImageSource.gallery,
        // Screenshots are already the right size; re-encoding would only cost
        // legibility, which is the entire point of sending one.
        imageQuality: 100,
      );
    } catch (err) {
      _toast('Could not open the picker: $err', bad: true);
      return;
    }
    if (picked == null || !mounted) return;

    setState(() => _uploading = true);
    try {
      final bytes = await picked.readAsBytes();
      final type = _contentTypeFor(picked.name);
      if (type == null) {
        _toast('Only PNG, JPEG and WebP can be sent.', bad: true);
        return;
      }
      final caption = _compose.text.trim();
      await widget.api.uploadImage(
        widget.serverId,
        _session.uuid,
        bytes,
        contentType: type,
        caption: caption,
      );
      if (!mounted) return;
      _compose.clear();
      _toast('Screenshot sent');
    } on PaneNotClaudeException catch (err) {
      _toast(err.message, bad: true);
    } catch (err) {
      _toast('$err', bad: true);
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  /// The hub checks the bytes against this, so a wrong guess is refused rather
  /// than stored under a misleading name.
  static String? _contentTypeFor(String filename) {
    final name = filename.toLowerCase();
    if (name.endsWith('.png')) return 'image/png';
    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
    if (name.endsWith('.webp')) return 'image/webp';
    return null;
  }

  void _showInfo() {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _InfoSheet(
        api: widget.api,
        serverId: widget.serverId,
        session: _session,
      ),
    );
  }

  /// Correct a bad pane→transcript match. See the hub's discovery notes: for
  /// sessions the hub did not launch, the mapping is a ranked guess.
  Future<void> _pickConversation() async {
    final chosen = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _ConversationSheet(
        api: widget.api,
        serverId: widget.serverId,
        paneId: _session.paneId,
        currentUuid: _session.uuid,
      ),
    );
    if (chosen == null || chosen == _session.uuid || !mounted) return;

    try {
      await widget.api.bind(widget.serverId, _session.paneId, chosen);
      final list = await widget.api.sessions(widget.serverId, fresh: true);
      if (!mounted) return;
      final bound = list.where((s) => s.uuid == chosen).firstOrNull;
      if (bound == null) {
        _toast('Pinned, but that session is not listed as running.', bad: true);
        return;
      }
      // Reopen against the newly bound transcript.
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(
          builder: (_) => ChatScreen(
            api: widget.api,
            serverId: widget.serverId,
            session: bound,
          ),
        ),
      );
    } catch (err) {
      _toast('$err', bad: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final cc = context.cc;

    return Scaffold(
      appBar: AppBar(
        titleSpacing: 0,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Repo first, in the accent colour — same treatment as the list, so
            // which project you are talking to is legible at a glance rather than
            // buried in the line of machine facts below.
            Text.rich(
              TextSpan(
                children: [
                  TextSpan(
                    text: _session.repo,
                    style: TextStyle(
                      color: cc.strong,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  TextSpan(
                    text: '  ${_session.title}',
                    style: TextStyle(color: cc.text),
                  ),
                ],
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 17,
                fontWeight: FontWeight.w600,
                letterSpacing: -0.2,
              ),
            ),
            const SizedBox(height: 2),
            MetaText(
              '${widget.serverId} · pane ${_session.paneId} · '
              '${_session.confidence == MatchConfidence.pending ? 'no transcript yet' : _session.uuid.substring(0, _session.uuid.length.clamp(0, 8))}',
            ),
          ],
        ),
        actions: [
          IconButton(
            icon: Icon(Icons.info_outline, color: cc.muted, size: 20),
            tooltip: 'Session info',
            onPressed: _showInfo,
          ),
          Padding(
            padding: const EdgeInsets.only(right: 16),
            child: Center(child: Bead(working: _session.working)),
          ),
        ],
      ),
      body: Column(
        children: [
          if (_showGuessNotice) _guessNotice(cc),
          if (_noticeText != null) _plainNotice(cc, _noticeText!),
          Expanded(child: _thread()),
          _composer(cc),
        ],
      ),
    );
  }

  Widget _guessNotice(CcColors cc) => Container(
    margin: const EdgeInsets.fromLTRB(16, 8, 16, 4),
    padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
    decoration: BoxDecoration(
      color: cc.warn.withValues(alpha: 0.11),
      border: Border.all(color: cc.warn.withValues(alpha: 0.34)),
      borderRadius: BorderRadius.circular(10),
    ),
    child: Row(
      children: [
        Expanded(
          child: Text(
            'This is a guess at which conversation the pane is running.',
            style: TextStyle(color: cc.warn, fontSize: 12.5, height: 1.35),
          ),
        ),
        const SizedBox(width: 8),
        TextButton(
          onPressed: _pickConversation,
          style: TextButton.styleFrom(
            foregroundColor: cc.warn,
            padding: const EdgeInsets.symmetric(horizontal: 8),
            minimumSize: const Size(0, 30),
          ),
          child: const Text('Pick', style: TextStyle(fontSize: 12.5)),
        ),
      ],
    ),
  );

  Widget _plainNotice(CcColors cc, String text) => Container(
    margin: const EdgeInsets.fromLTRB(16, 8, 16, 4),
    padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
    decoration: BoxDecoration(
      color: (_noticeBad ? cc.bad : cc.warn).withValues(alpha: 0.11),
      border: Border.all(
        color: (_noticeBad ? cc.bad : cc.warn).withValues(alpha: 0.34),
      ),
      borderRadius: BorderRadius.circular(10),
    ),
    child: Row(
      children: [
        Expanded(
          child: Text(
            text,
            style: TextStyle(
              color: _noticeBad ? cc.bad : cc.warn,
              fontSize: 12.5,
              height: 1.35,
            ),
          ),
        ),
        IconButton(
          icon: Icon(
            Icons.close,
            size: 16,
            color: _noticeBad ? cc.bad : cc.warn,
          ),
          onPressed: () => setState(() => _noticeText = null),
        ),
      ],
    ),
  );

  Widget _thread() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_events.isEmpty) {
      return const EmptyState(
        title: 'Nothing here yet',
        body: 'Send the first message to start this conversation.',
      );
    }

    // Reversed: index 0 is the newest message and sits at the bottom, so the chat
    // opens where it should and prepending history cannot shift the viewport.
    //
    // SelectionArea because Flutter's Text is not selectable by default: without it
    // the thread is read-only in the literal sense — no drag-select, no copy — which
    // is useless when the whole point is a session emitting paths, commands and
    // snippets you then want to paste elsewhere.
    return SelectionArea(
      child: ListView.separated(
        controller: _scroll,
        reverse: true,
        padding: const EdgeInsets.all(16),
        itemCount: _events.length + 1,
        separatorBuilder: (context, _) => const SizedBox(height: 10),
        itemBuilder: (context, i) {
          if (i == _events.length) return _historyFooter();
          final event = _events[_events.length - 1 - i];
          return switch (event.kind) {
            EventKind.user || EventKind.assistant => MessageBubble(
              event: event,
              onCopy: () => _copy(event.text),
            ),
            EventKind.tool => ToolChip(
              event: event,
              result: _results[event.id],
            ),
            _ => const SizedBox.shrink(),
          };
        },
      ),
    );
  }

  /// Long-press a bubble to copy the whole message.
  ///
  /// Drag-selection works now, but dragging precisely over a wrapped code path on a
  /// phone is fiddly, and "copy that entire message" is what is actually wanted most
  /// of the time.
  Future<void> _copy(String text) async {
    if (text.trim().isEmpty) return;
    await Clipboard.setData(ClipboardData(text: text));
    if (mounted) _toast('Message copied');
  }

  Widget _historyFooter() {
    final cc = context.cc;
    final label = _loadingOlder
        ? 'Loading earlier messages…'
        : _hasMore
        ? ''
        : 'Start of the conversation';
    if (label.isEmpty) return const SizedBox(height: 24);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Center(
        child: Text(
          label,
          style: TextStyle(
            color: cc.muted,
            fontSize: 12,
            fontFamily: monoFamily,
            letterSpacing: 0.3,
          ),
        ),
      ),
    );
  }

  Widget _composer(CcColors cc) {
    final canSend = _compose.text.trim().isNotEmpty && !_sending;

    return Container(
      decoration: BoxDecoration(
        color: cc.ink,
        border: Border(top: BorderSide(color: cc.line)),
      ),
      child: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            KeyBar(onKey: _sendKey, onPeek: _peek, onPick: _pickConversation),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Expanded(
                    child: TextField(
                      controller: _compose,
                      minLines: 1,
                      maxLines: 6,
                      // The whole point of the app: a real keyboard with
                      // autocorrect, prediction and dictation.
                      keyboardType: TextInputType.multiline,
                      textCapitalization: TextCapitalization.sentences,
                      autocorrect: true,
                      enableSuggestions: true,
                      style: TextStyle(
                        color: cc.text,
                        fontSize: 16,
                        height: 1.35,
                      ),
                      decoration: InputDecoration(
                        hintText: 'Message this session…',
                        hintStyle: TextStyle(color: cc.muted, fontSize: 16),
                        isDense: true,
                        filled: true,
                        fillColor: cc.panel,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 14,
                          vertical: 11,
                        ),
                        enabledBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(20),
                          borderSide: BorderSide(color: cc.line),
                        ),
                        focusedBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(20),
                          borderSide: BorderSide(color: cc.you),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 4),
                  // Screenshot. Whatever is typed in the box goes with it as the
                  // caption, so "why is this broken?" plus the picture is one action.
                  SizedBox(
                    width: 40,
                    height: 44,
                    child: IconButton(
                      tooltip: 'Send a screenshot',
                      icon: _uploading
                          ? SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: cc.muted,
                              ),
                            )
                          : Icon(
                              Icons.image_outlined,
                              color: cc.muted,
                              size: 23,
                            ),
                      onPressed: _uploading || _sending ? null : _sendImage,
                    ),
                  ),
                  const SizedBox(width: 5),
                  SizedBox(
                    width: 44,
                    height: 44,
                    child: FilledButton(
                      onPressed: canSend ? _send : null,
                      style: FilledButton.styleFrom(
                        backgroundColor: cc.you,
                        foregroundColor: cc.onYou,
                        disabledBackgroundColor: cc.you.withValues(alpha: 0.35),
                        padding: EdgeInsets.zero,
                        shape: const CircleBorder(),
                      ),
                      child: _sending
                          ? SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: cc.onYou,
                              ),
                            )
                          : const Icon(Icons.arrow_upward, size: 20),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Lists every transcript in the pane's project so a bad match can be corrected.
class _ConversationSheet extends StatefulWidget {
  const _ConversationSheet({
    required this.api,
    required this.serverId,
    required this.paneId,
    required this.currentUuid,
  });

  final CcApi api;
  final String serverId;
  final String paneId;
  final String currentUuid;

  @override
  State<_ConversationSheet> createState() => _ConversationSheetState();
}

class _ConversationSheetState extends State<_ConversationSheet> {
  List<TranscriptCandidate>? _candidates;
  String? _error;

  @override
  void initState() {
    super.initState();
    widget.api
        .candidates(widget.serverId, widget.paneId)
        .then((list) {
          if (mounted) setState(() => _candidates = list);
        })
        .catchError((Object err) {
          if (mounted) setState(() => _error = '$err');
        });
  }

  @override
  Widget build(BuildContext context) {
    final cc = context.cc;
    final candidates = _candidates;

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
                      'Which conversation?',
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
            Expanded(
              child: _error != null
                  ? EmptyState(
                      title: 'Could not read the transcripts',
                      body: _error!,
                    )
                  : candidates == null
                  ? const Center(child: CircularProgressIndicator())
                  : candidates.isEmpty
                  ? const EmptyState(
                      title: 'No transcripts',
                      body: 'This project has no conversations yet.',
                    )
                  : ListView.separated(
                      itemCount: candidates.length,
                      separatorBuilder: (context, _) =>
                          Divider(height: 1, color: cc.line),
                      itemBuilder: (context, i) {
                        final c = candidates[i];
                        final current = c.uuid == widget.currentUuid;
                        return ListTile(
                          title: Text(
                            c.title ?? c.uuid.substring(0, 8),
                            maxLines: 2,
                            style: TextStyle(color: cc.text, fontSize: 14.5),
                          ),
                          subtitle: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const SizedBox(height: 2),
                              MetaText(
                                '${c.uuid.substring(0, 8)} · '
                                '${formatSize(c.size)} · '
                                '${relativeTime(c.lastActivity)}'
                                '${current ? " · shown now" : ""}',
                                color: current ? cc.you : null,
                              ),
                              if (c.lastMessage != null) ...[
                                const SizedBox(height: 3),
                                Text(
                                  c.lastMessage!,
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                    color: cc.muted,
                                    fontSize: 12.5,
                                  ),
                                ),
                              ],
                            ],
                          ),
                          onTap: () => Navigator.of(context).pop(c.uuid),
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}

/// Session facts, headed by the pane's own status line.
///
/// The status line is shown verbatim rather than re-rendered: cost and rate-limit
/// windows are known only to the running Claude Code process, which hands them to
/// the configured statusLine command. Reproducing them here would mean inventing
/// them, so the hub scrapes the rendered line instead.
class _InfoSheet extends StatefulWidget {
  const _InfoSheet({
    required this.api,
    required this.serverId,
    required this.session,
  });

  final CcApi api;
  final String serverId;
  final SessionInfo session;

  @override
  State<_InfoSheet> createState() => _InfoSheetState();
}

class _InfoSheetState extends State<_InfoSheet> {
  SessionDetail? _detail;
  String? _error;

  @override
  void initState() {
    super.initState();
    widget.api
        .info(widget.serverId, widget.session.uuid)
        .then((d) {
          if (mounted) setState(() => _detail = d);
        })
        .catchError((Object err) {
          if (mounted) setState(() => _error = '$err');
        });
  }

  static String _duration(int? seconds) {
    if (seconds == null) return '—';
    final d = Duration(seconds: seconds);
    if (d.inDays > 0) return '${d.inDays}d ${d.inHours % 24}h';
    if (d.inHours > 0) return '${d.inHours}h ${d.inMinutes % 60}m';
    if (d.inMinutes > 0) return '${d.inMinutes}m';
    return '${d.inSeconds}s';
  }

  static String _tokens(int? n) {
    if (n == null) return '—';
    if (n < 1000) return '$n';
    if (n < 1_000_000) return '${(n / 1000).round()}k';
    return '${(n / 1000000).toStringAsFixed(1)}M';
  }

  static String _when(DateTime? when) {
    if (when == null) return '—';
    final l = when.toLocal();
    String two(int v) => v.toString().padLeft(2, '0');
    return '${l.year}-${two(l.month)}-${two(l.day)} ${two(l.hour)}:${two(l.minute)}';
  }

  @override
  Widget build(BuildContext context) {
    final cc = context.cc;
    final detail = _detail;
    final session = widget.session;

    Widget row(String label, String value, {bool mono = true}) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 108,
            child: Text(
              label,
              style: TextStyle(color: cc.muted, fontSize: 12.5),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: TextStyle(
                color: cc.text,
                fontSize: 12.5,
                fontFamily: mono ? monoFamily : null,
                height: 1.35,
              ),
            ),
          ),
        ],
      ),
    );

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
                      session.title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
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
            Expanded(
              child: _error != null
                  ? EmptyState(
                      title: 'Could not read this session',
                      body: _error!,
                    )
                  : detail == null
                  ? const Center(child: CircularProgressIndicator())
                  : ListView(
                      padding: const EdgeInsets.fromLTRB(16, 14, 16, 20),
                      children: [
                        if (detail.statusLine.isNotEmpty) ...[
                          // Horizontally scrollable: the status line is wider
                          // than a phone and must not be wrapped or clipped.
                          Container(
                            padding: const EdgeInsets.all(10),
                            decoration: BoxDecoration(
                              color: cc.panel,
                              borderRadius: BorderRadius.circular(10),
                              border: Border.all(color: cc.line),
                            ),
                            child: SingleChildScrollView(
                              scrollDirection: Axis.horizontal,
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  for (final line in detail.statusLine)
                                    Text(
                                      line,
                                      style: TextStyle(
                                        fontFamily: monoFamily,
                                        fontSize: 11,
                                        height: 1.5,
                                        color: cc.text,
                                      ),
                                    ),
                                ],
                              ),
                            ),
                          ),
                          const SizedBox(height: 6),
                          MetaText('status line, as shown in the pane'),
                          const SizedBox(height: 14),
                        ],
                        row(
                          'model',
                          [
                            detail.model ?? '—',
                            if (detail.effort != null) detail.effort!,
                          ].join(' · '),
                        ),
                        row(
                          'context',
                          '${_tokens(detail.contextTokens)} tokens',
                        ),
                        row('directory', session.cwd),
                        if (detail.gitBranch != null)
                          row('branch', detail.gitBranch!),
                        row(
                          'turns',
                          '${detail.userTurns} you · ${detail.assistantTurns} claude · ${detail.toolCalls} tools',
                        ),
                        row('started', _when(detail.startedAt)),
                        row('pane up', _duration(detail.uptimeSeconds)),
                        row('last active', relativeTime(session.lastActivity)),
                        const SizedBox(height: 10),
                        Divider(height: 1, color: cc.line),
                        const SizedBox(height: 10),
                        row(
                          'pane',
                          '${session.paneId} · tmux ${session.tmuxSession}',
                        ),
                        row('pid', '${session.pid}'),
                        row('server', widget.serverId),
                        row('match', session.confidence.name),
                        row(
                          'transcript',
                          session.transcript.isEmpty
                              ? 'none yet'
                              : '${session.uuid.substring(0, 8)} · '
                                    '${formatSize(detail.transcriptBytes ?? 0)}',
                        ),
                        if (detail.version != null)
                          row('claude code', 'v${detail.version!}'),
                        row('this app', buildLabel),
                        if (session.skipPermissions == true)
                          row(
                            'permissions',
                            'skipped (--dangerously-skip-permissions)',
                          ),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
