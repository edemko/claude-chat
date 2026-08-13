import 'package:flutter/material.dart';

import 'markdown_view.dart';
import 'models.dart';
import 'theme.dart';

String relativeTime(DateTime? when) {
  if (when == null) return '';
  final secs = DateTime.now().difference(when).inSeconds;
  if (secs < 45) return 'now';
  if (secs < 3600) return '${(secs / 60).round()}m';
  if (secs < 86400) return '${(secs / 3600).round()}h';
  return '${(secs / 86400).round()}d';
}

String formatSize(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).round()} KB';
  return '${(bytes / 1048576).toStringAsFixed(1)} MB';
}

/// Mono, small, wide-tracked. Machine facts read as machine facts.
class MetaText extends StatelessWidget {
  const MetaText(this.text, {super.key, this.color});
  final String text;
  final Color? color;

  @override
  Widget build(BuildContext context) => Text(
    text,
    maxLines: 1,
    overflow: TextOverflow.ellipsis,
    style: TextStyle(
      fontFamily: monoFamily,
      fontSize: 11,
      letterSpacing: 0.4,
      color: color ?? context.cc.muted,
    ),
  );
}

/// The status bead: the one saturated colour and the one animation in the app.
/// It breathes only while a session is actually working, which is the single fact
/// you open the app to learn.
class Bead extends StatefulWidget {
  const Bead({super.key, required this.working, this.size = 9});
  final bool working;
  final double size;

  @override
  State<Bead> createState() => _BeadState();
}

class _BeadState extends State<Bead> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1600),
  );

  @override
  void initState() {
    super.initState();
    if (widget.working) _controller.repeat(reverse: true);
  }

  @override
  void didUpdateWidget(Bead old) {
    super.didUpdateWidget(old);
    if (widget.working && !_controller.isAnimating) {
      _controller.repeat(reverse: true);
    } else if (!widget.working && _controller.isAnimating) {
      _controller.stop();
      _controller.value = 0;
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final cc = context.cc;
    if (!widget.working) {
      return Container(
        width: widget.size,
        height: widget.size,
        decoration: BoxDecoration(color: cc.line, shape: BoxShape.circle),
      );
    }
    // Respect the platform's reduced-motion setting.
    final reduceMotion =
        MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) {
        final t = reduceMotion ? 0.0 : _controller.value;
        return Container(
          width: widget.size,
          height: widget.size,
          decoration: BoxDecoration(
            color: cc.live,
            shape: BoxShape.circle,
            boxShadow: [
              BoxShadow(
                color: cc.live.withValues(alpha: 0.45 * (1 - t)),
                blurRadius: 0,
                spreadRadius: 6 * t,
              ),
            ],
          ),
        );
      },
    );
  }
}

/// The agent speaks from the environment: flush panel, no tail, no avatar.
/// Only the human gets a filled bubble.
class MessageBubble extends StatelessWidget {
  const MessageBubble({super.key, required this.event, this.onCopy});
  final ChatEvent event;

  /// Long-press the bubble. Selection still works; this is the coarse, reliable
  /// version of it on a touchscreen.
  final VoidCallback? onCopy;

  @override
  Widget build(BuildContext context) {
    final cc = context.cc;
    final mine = event.kind == EventKind.user;

    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.88,
        ),
        child: GestureDetector(
          onLongPress: onCopy,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 10),
            decoration: BoxDecoration(
              color: mine ? cc.you : cc.panel,
              border: mine ? null : Border.all(color: cc.line),
              borderRadius: BorderRadius.only(
                topLeft: Radius.circular(mine ? 14 : 4),
                topRight: const Radius.circular(14),
                bottomLeft: const Radius.circular(14),
                bottomRight: Radius.circular(mine ? 4 : 14),
              ),
            ),
            child: MarkdownView(text: event.text, onYou: mine),
          ),
        ),
      ),
    );
  }
}

/// Machine work, so entirely mono. Collapsed to a single line; tap for output.
class ToolChip extends StatefulWidget {
  const ToolChip({super.key, required this.event, required this.result});
  final ChatEvent event;
  final ChatEvent? result;

  @override
  State<ToolChip> createState() => _ToolChipState();
}

class _ToolChipState extends State<ToolChip> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final cc = context.cc;
    final result = widget.result;
    final dotColor = result == null ? cc.line : (result.ok ? cc.ok : cc.bad);

    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        border: Border.all(color: cc.line),
        borderRadius: BorderRadius.circular(10),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: () => setState(() => _open = !_open),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 8),
              child: Row(
                children: [
                  Container(
                    width: 6,
                    height: 6,
                    decoration: BoxDecoration(
                      color: dotColor,
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: 9),
                  Text(
                    widget.event.name,
                    style: TextStyle(
                      fontFamily: monoFamily,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      color: cc.text,
                    ),
                  ),
                  const SizedBox(width: 9),
                  Expanded(
                    child: Text(
                      widget.event.summary,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontFamily: monoFamily,
                        fontSize: 12,
                        color: cc.muted,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          if (_open)
            Container(
              width: double.infinity,
              constraints: BoxConstraints(
                maxHeight: MediaQuery.sizeOf(context).height * 0.45,
              ),
              decoration: BoxDecoration(
                color: cc.panel,
                border: Border(top: BorderSide(color: cc.line)),
              ),
              child: SingleChildScrollView(
                padding: const EdgeInsets.symmetric(
                  horizontal: 11,
                  vertical: 9,
                ),
                child: Text(
                  result == null || result.preview.isEmpty
                      ? '(no output)'
                      : result.preview,
                  style: TextStyle(
                    fontFamily: monoFamily,
                    fontSize: 11.5,
                    height: 1.45,
                    color: cc.muted,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// Special keys the chat metaphor cannot express: escape, interrupt, history.
class KeyBar extends StatelessWidget {
  const KeyBar({
    super.key,
    required this.onKey,
    required this.onPeek,
    required this.onPick,
  });

  final ValueChanged<String> onKey;
  final VoidCallback onPeek;
  final VoidCallback onPick;

  static const _keys = <String, String>{
    'escape': 'esc',
    'ctrl-c': '^C',
    'up': '↑',
    'down': '↓',
    'tab': '⇥',
    'shift-tab': '⇧⇥',
    'enter': '⏎',
  };

  @override
  Widget build(BuildContext context) {
    final cc = context.cc;

    Widget chip(String label, VoidCallback onTap) => Padding(
      padding: const EdgeInsets.only(right: 7),
      child: OutlinedButton(
        onPressed: onTap,
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(0, 32),
          padding: const EdgeInsets.symmetric(horizontal: 11),
          backgroundColor: cc.panel,
          side: BorderSide(color: cc.line),
          foregroundColor: cc.muted,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
          textStyle: const TextStyle(fontFamily: monoFamily, fontSize: 12),
        ),
        child: Text(label),
      ),
    );

    return SizedBox(
      height: 50,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
        children: [
          for (final entry in _keys.entries)
            chip(entry.value, () => onKey(entry.key)),
          chip('screen', onPeek),
          chip('conversation', onPick),
        ],
      ),
    );
  }
}

/// Used for empty and error states; an empty screen is an invitation to act.
class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.title, required this.body});
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    final cc = context.cc;
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 56),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              title,
              textAlign: TextAlign.center,
              style: TextStyle(
                color: cc.text,
                fontSize: 16,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              body,
              textAlign: TextAlign.center,
              style: TextStyle(color: cc.muted, fontSize: 14, height: 1.4),
            ),
          ],
        ),
      ),
    );
  }
}
