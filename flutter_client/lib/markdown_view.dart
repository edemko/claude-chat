import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:url_launcher/url_launcher.dart';

import 'theme.dart';

/// Renders model output as widgets.
///
/// Parsing uses the maintained `markdown` package; the AST → widget mapping lives
/// here so bold and italic can carry their own colours, with a separate pair for
/// use inside the filled bubble where the background is saturated.
class MarkdownView extends StatelessWidget {
  const MarkdownView({
    super.key,
    required this.text,
    this.onYou = false,
    this.baseStyle,
  });

  final String text;

  /// True inside the user's own bubble, which needs the inverted accent pair.
  final bool onYou;
  final TextStyle? baseStyle;

  @override
  Widget build(BuildContext context) {
    final nodes = md.Document(
      extensionSet: md.ExtensionSet.gitHubFlavored,
      encodeHtml: false,
    ).parseLines(text.replaceAll('\r\n', '\n').split('\n'));

    final builder = _Builder(context: context, onYou: onYou, baseStyle: baseStyle);
    final blocks = builder.blocks(nodes);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: blocks,
    );
  }
}

class _Builder {
  _Builder({required this.context, required this.onYou, this.baseStyle});

  final BuildContext context;
  final bool onYou;
  final TextStyle? baseStyle;

  CcColors get cc => context.cc;
  Color get fg => onYou ? cc.onYou : cc.text;
  Color get strongColor => onYou ? cc.strongOnYou : cc.strong;
  Color get emColor => onYou ? cc.emOnYou : cc.em;

  TextStyle get base =>
      (baseStyle ?? const TextStyle(fontSize: 15.5, height: 1.42)).copyWith(color: fg);

  List<Widget> blocks(List<md.Node> nodes) {
    final out = <Widget>[];
    for (final node in nodes) {
      final widget = _block(node);
      if (widget != null) out.add(widget);
    }
    // Space between blocks, but never a trailing gap inside the bubble.
    for (var i = 0; i < out.length - 1; i++) {
      out[i] = Padding(padding: const EdgeInsets.only(bottom: 8), child: out[i]);
    }
    return out;
  }

  Widget? _block(md.Node node) {
    if (node is md.Text) {
      final t = node.text.trim();
      return t.isEmpty ? null : Text(t, style: base);
    }
    if (node is! md.Element) return null;

    switch (node.tag) {
      case 'p':
        return Text.rich(TextSpan(children: _inline(node.children ?? [])), style: base);

      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        final level = int.parse(node.tag.substring(1));
        final size = switch (level) { 1 || 2 => 17.0, 3 || 4 => 15.5, _ => 14.0 };
        final isSmall = level >= 5;
        return Text.rich(
          TextSpan(children: _inline(node.children ?? [])),
          style: base.copyWith(
            fontSize: size,
            fontWeight: FontWeight.w600,
            height: 1.3,
            letterSpacing: isSmall ? 0.6 : -0.2,
            color: isSmall ? cc.muted : fg,
          ),
        );

      case 'pre':
        return _codeBlock(node);

      case 'blockquote':
        return Container(
          padding: const EdgeInsets.only(left: 11),
          decoration: BoxDecoration(
            border: Border(left: BorderSide(color: cc.line, width: 2)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: blocks(node.children ?? []),
          ),
        );

      case 'ul':
      case 'ol':
        return _list(node, ordered: node.tag == 'ol');

      case 'hr':
        return Divider(color: cc.line, height: 1);

      case 'table':
        return _table(node);

      default:
        final children = node.children;
        if (children == null || children.isEmpty) return null;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: blocks(children),
        );
    }
  }

  Widget _codeBlock(md.Element pre) {
    final code = (pre.children?.isNotEmpty ?? false) ? pre.children!.first : null;
    final body = code is md.Element ? code.textContent : pre.textContent;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 10),
      decoration: BoxDecoration(
        color: cc.codeBg,
        borderRadius: BorderRadius.circular(9),
      ),
      // Long lines scroll themselves rather than forcing the bubble wide.
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Text(
          body.trimRight(),
          style: base.copyWith(
            fontFamily: monoFamily,
            fontSize: 12,
            height: 1.5,
          ),
        ),
      ),
    );
  }

  Widget _list(md.Element list, {required bool ordered}) {
    final start = int.tryParse(list.attributes['start'] ?? '1') ?? 1;
    final rows = <Widget>[];
    var index = start;

    for (final item in list.children ?? <md.Node>[]) {
      if (item is! md.Element || item.tag != 'li') continue;

      // An li mixes inline content with any nested lists; split them so the text
      // renders on the marker row and sublists sit underneath.
      final inlineNodes = <md.Node>[];
      final childBlocks = <md.Node>[];
      for (final child in item.children ?? <md.Node>[]) {
        final isBlock = child is md.Element &&
            const {'ul', 'ol', 'pre', 'blockquote', 'table', 'p'}.contains(child.tag);
        if (isBlock) {
          if (child.tag == 'p' && childBlocks.isEmpty && inlineNodes.isEmpty) {
            inlineNodes.addAll(child.children ?? []);
          } else {
            childBlocks.add(child);
          }
        } else {
          inlineNodes.add(child);
        }
      }

      rows.add(Padding(
        padding: const EdgeInsets.only(bottom: 3),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: ordered ? 24 : 18,
              child: Text(
                ordered ? '$index.' : '•',
                style: base.copyWith(color: cc.muted),
              ),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (inlineNodes.isNotEmpty)
                    Text.rich(TextSpan(children: _inline(inlineNodes)), style: base),
                  ...blocks(childBlocks),
                ],
              ),
            ),
          ],
        ),
      ));
      index++;
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: rows,
    );
  }

  Widget _table(md.Element table) {
    final rows = <TableRow>[];

    void addSection(md.Element section, {required bool header}) {
      for (final row in section.children ?? <md.Node>[]) {
        if (row is! md.Element || row.tag != 'tr') continue;
        final cells = <Widget>[];
        for (final cell in row.children ?? <md.Node>[]) {
          if (cell is! md.Element) continue;
          cells.add(Padding(
            padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
            child: Text.rich(
              TextSpan(children: _inline(cell.children ?? [])),
              style: base.copyWith(
                fontSize: 13,
                fontWeight: header ? FontWeight.w600 : null,
              ),
            ),
          ));
        }
        if (cells.isNotEmpty) rows.add(TableRow(children: cells));
      }
    }

    for (final section in table.children ?? <md.Node>[]) {
      if (section is! md.Element) continue;
      if (section.tag == 'thead') addSection(section, header: true);
      if (section.tag == 'tbody') addSection(section, header: false);
    }
    if (rows.isEmpty) return const SizedBox.shrink();

    // Ragged rows would throw; pad every row to the widest.
    final width = rows.map((r) => r.children.length).reduce((a, b) => a > b ? a : b);
    final padded = rows
        .map((r) => TableRow(children: [
              ...r.children,
              for (var i = r.children.length; i < width; i++) const SizedBox.shrink(),
            ]))
        .toList();

    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Table(
        defaultColumnWidth: const IntrinsicColumnWidth(),
        border: TableBorder.all(color: cc.line),
        children: padded,
      ),
    );
  }

  List<InlineSpan> _inline(List<md.Node> nodes, {TextStyle? inherited}) {
    final style = inherited ?? base;
    final spans = <InlineSpan>[];

    for (final node in nodes) {
      if (node is md.Text) {
        // The parser leaves entities encoded off, so text is already literal.
        spans.add(TextSpan(text: node.text, style: style));
        continue;
      }
      if (node is! md.Element) continue;

      switch (node.tag) {
        case 'strong':
          spans.addAll(_inline(
            node.children ?? [],
            inherited: style.copyWith(fontWeight: FontWeight.w700, color: strongColor),
          ));

        case 'em':
          spans.addAll(_inline(
            node.children ?? [],
            inherited: style.copyWith(fontStyle: FontStyle.italic, color: emColor),
          ));

        case 'del':
          spans.addAll(_inline(
            node.children ?? [],
            inherited: style.copyWith(decoration: TextDecoration.lineThrough),
          ));

        case 'code':
          spans.add(TextSpan(
            text: node.textContent,
            style: style.copyWith(
              fontFamily: monoFamily,
              fontSize: (style.fontSize ?? 15.5) * 0.88,
              backgroundColor: cc.codeBg,
            ),
          ));

        case 'a':
          final href = node.attributes['href'] ?? '';
          final linkStyle = style.copyWith(
            color: onYou ? cc.onYou : cc.you,
            decoration: TextDecoration.underline,
          );
          spans.add(TextSpan(
            children: _inline(node.children ?? [], inherited: linkStyle),
            recognizer: TapGestureRecognizer()..onTap = () => _open(href),
          ));

        case 'br':
          spans.add(TextSpan(text: '\n', style: style));

        default:
          spans.addAll(_inline(node.children ?? [], inherited: style));
      }
    }
    return spans;
  }

  Future<void> _open(String href) async {
    final uri = Uri.tryParse(href);
    // Only follow schemes that cannot execute anything locally.
    if (uri == null || !const {'http', 'https', 'mailto'}.contains(uri.scheme)) return;
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }
}
