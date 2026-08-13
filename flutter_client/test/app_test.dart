import 'package:claude_chat/api.dart';
import 'package:claude_chat/build_info.dart';
import 'package:claude_chat/markdown_view.dart';
import 'package:claude_chat/models.dart';
import 'package:claude_chat/screens/chat_screen.dart';
import 'package:claude_chat/screens/sessions_screen.dart';
import 'package:claude_chat/store.dart';
import 'package:claude_chat/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Hosts a widget in the real theme so `context.cc` resolves.
Widget host(Widget child, {Brightness brightness = Brightness.dark}) => MaterialApp(
      theme: buildTheme(brightness),
      home: Scaffold(body: child),
    );

/// Flattens every rendered text span so styles can be asserted on.
List<TextSpan> spansOf(WidgetTester tester) {
  final out = <TextSpan>[];
  for (final rich in tester.widgetList<RichText>(find.byType(RichText))) {
    rich.text.visitChildren((span) {
      if (span is TextSpan && (span.text?.isNotEmpty ?? false)) out.add(span);
      return true;
    });
  }
  return out;
}

TextSpan spanWith(WidgetTester tester, String text) =>
    spansOf(tester).firstWhere((s) => s.text == text,
        orElse: () => throw TestFailure(
            'no span with text "$text"; got ${spansOf(tester).map((s) => s.text).toList()}'));

void main() {
  drawerReachabilityTests();
  repoInTitleTests();

  group('buildLabel', () {
    test('says "dev build" when nothing was stamped in', () {
      // The APK ships by file sync, so a build with no stamp must be obviously
      // unstamped rather than showing a plausible-looking version.
      expect(buildStamp, isEmpty, reason: 'flutter test runs without --dart-define');
      expect(buildLabel, 'v0.0.0 · dev build');
    });
  });

  group('ConnectionLink.tryParse', () {
    test('parses the link the hub prints', () {
      final link = ConnectionLink.tryParse('http://100.64.0.1:7420/?t=abc123def456789a');
      expect(link, isNotNull);
      expect(link!.host, '100.64.0.1');
      expect(link.port, 7420);
      expect(link.token, 'abc123def456789a');
    });

    test('rejects a URL with no token, since it could not authenticate', () {
      expect(ConnectionLink.tryParse('http://100.64.0.1:7420/'), isNull);
    });

    test('falls back to the default port when the URL omits it', () {
      final link = ConnectionLink.tryParse('http://sam/?t=abc123def456789a');
      expect(link!.port, 7420);
    });

    test('accepts a bare token when a host is already known', () {
      final link = ConnectionLink.tryParse(
        'deadbeefdeadbeef99',
        fallbackHost: '100.64.0.1',
      );
      expect(link!.host, '100.64.0.1');
      expect(link.token, 'deadbeefdeadbeef99');
    });

    test('rejects empty input', () {
      expect(ConnectionLink.tryParse('   '), isNull);
    });
  });

  group('Connection', () {
    test('round-trips through json', () {
      const conn = Connection(
        id: '100.64.0.1:7420',
        label: 'sam',
        host: '100.64.0.1',
        port: 7420,
        token: 'abc',
      );
      final back = Connection.fromJson(conn.toJson())!;
      expect(back.id, conn.id);
      expect(back.label, 'sam');
      expect(back.port, 7420);
      expect(back.token, 'abc');
    });

    test('rejects an entry with no token, which could not authenticate', () {
      expect(Connection.fromJson({'host': 'sam', 'port': 7420}), isNull);
    });

    test('falls back to the host as a label', () {
      final c = Connection.fromJson({'host': 'sam', 'port': 7420, 'token': 't'})!;
      expect(c.label, 'sam');
      expect(c.id, 'sam:7420');
    });
  });

  group('Settings', () {
    test('migrates a single-server install into the connection list', () async {
      SharedPreferences.setMockInitialValues({
        'cc-host': '100.64.0.1',
        'cc-port': 7420,
        'cc-token': 'legacy-token',
      });
      final settings = Settings();
      await settings.load();

      expect(settings.connections, hasLength(1));
      expect(settings.active!.host, '100.64.0.1');
      expect(settings.active!.token, 'legacy-token');
      // The legacy key is cleared so the migration cannot run twice.
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('cc-token'), isNull);
    });

    test('starts with no server when nothing is stored', () async {
      SharedPreferences.setMockInitialValues({});
      final settings = Settings();
      await settings.load();
      expect(settings.active, isNull);
      expect(settings.connections, isEmpty);
    });

    test('upsert replaces by id and makes it active', () async {
      SharedPreferences.setMockInitialValues({});
      final settings = Settings();
      await settings.load();

      await settings.upsert(const Connection(
          id: 'a:1', label: 'a', host: 'a', port: 1, token: 't1'));
      await settings.upsert(const Connection(
          id: 'b:2', label: 'b', host: 'b', port: 2, token: 't2'));
      expect(settings.connections, hasLength(2));
      expect(settings.active!.id, 'b:2');

      // Re-adding the same host:port updates rather than duplicating.
      await settings.upsert(const Connection(
          id: 'a:1', label: 'a renamed', host: 'a', port: 1, token: 't3'));
      expect(settings.connections, hasLength(2));
      expect(settings.active!.id, 'a:1');
      expect(settings.active!.token, 't3');
      expect(settings.active!.label, 'a renamed');
    });

    test('removing the active server falls back to another', () async {
      SharedPreferences.setMockInitialValues({});
      final settings = Settings();
      await settings.load();
      await settings.upsert(const Connection(
          id: 'a:1', label: 'a', host: 'a', port: 1, token: 't1'));
      await settings.upsert(const Connection(
          id: 'b:2', label: 'b', host: 'b', port: 2, token: 't2'));

      await settings.remove('b:2');
      expect(settings.active!.id, 'a:1');
      await settings.remove('a:1');
      expect(settings.active, isNull);
    });
  });

  group('SessionInfo.fromJson', () {
    test('maps status, confidence and repo', () {
      final s = SessionInfo.fromJson({
        'serverId': 'sam',
        'uuid': '2847d280-bf1a',
        'paneId': '%0',
        'cwd': '/home/you/Dev/my-clinic',
        'title': 'implementing MEGA bucket',
        'status': 'working',
        'confidence': 'weak',
        'lastActivity': 1786524565000,
      });
      expect(s.working, isTrue);
      expect(s.confidence, MatchConfidence.weak);
      expect(s.repo, 'my-clinic');
    });

    test('defaults an unknown confidence to weak rather than pretending certainty', () {
      final s = SessionInfo.fromJson({'cwd': '/x', 'confidence': 'nonsense'});
      expect(s.confidence, MatchConfidence.weak);
      expect(s.working, isFalse);
      expect(s.lastActivity, isNull);
    });

    test('pending is a confidence of its own, not a weak match', () {
      // A session opened but never spoken to has no transcript at all. Folding this
      // into `weak` would show the "this is a guess" notice for a chat that is simply
      // empty — and, before the hub stopped guessing, the previous conversation.
      final s = SessionInfo.fromJson({
        'serverId': 'sam',
        'uuid': 'pane-20',
        'paneId': '%20',
        'cwd': '/home/you/Dev/my-clinic',
        'title': 'my-clinic',
        'confidence': 'pending',
      });
      expect(s.confidence, MatchConfidence.pending);
      expect(s.confidence, isNot(MatchConfidence.weak));
      expect(s.lastActivity, isNull);
    });
  });

  group('MarkdownView emphasis colours', () {
    testWidgets('bold takes the warm accent, italic the cool one', (tester) async {
      await tester.pumpWidget(host(
        const MarkdownView(text: 'plain **bold** and *italic* here'),
      ));

      final bold = spanWith(tester, 'bold');
      expect(bold.style!.fontWeight, FontWeight.w700);
      expect(bold.style!.color, CcColors.dark.strong);

      final italic = spanWith(tester, 'italic');
      expect(italic.style!.fontStyle, FontStyle.italic);
      expect(italic.style!.color, CcColors.dark.em);

      // The two must be visually distinct, which is the whole point.
      expect(bold.style!.color, isNot(italic.style!.color));
    });

    testWidgets('inside the user bubble the inverted accent pair is used',
        (tester) async {
      await tester.pumpWidget(host(
        const MarkdownView(text: '**bold** and *italic*', onYou: true),
      ));
      expect(spanWith(tester, 'bold').style!.color, CcColors.dark.strongOnYou);
      expect(spanWith(tester, 'italic').style!.color, CcColors.dark.emOnYou);
    });

    testWidgets('light mode uses the darker accents for contrast', (tester) async {
      await tester.pumpWidget(host(
        const MarkdownView(text: '**bold** and *italic*'),
        brightness: Brightness.light,
      ));
      expect(spanWith(tester, 'bold').style!.color, CcColors.light.strong);
      expect(spanWith(tester, 'italic').style!.color, CcColors.light.em);
    });

    testWidgets('nested emphasis keeps both markers', (tester) async {
      await tester.pumpWidget(host(
        const MarkdownView(text: '*outer **inner** rest*'),
      ));
      final inner = spanWith(tester, 'inner');
      expect(inner.style!.fontWeight, FontWeight.w700);
      expect(inner.style!.fontStyle, FontStyle.italic);
    });
  });

  group('MarkdownView structure', () {
    testWidgets('inline code renders monospaced and tinted', (tester) async {
      await tester.pumpWidget(host(const MarkdownView(text: 'run `npm test` now')));
      final code = spanWith(tester, 'npm test');
      expect(code.style!.fontFamily, monoFamily);
      expect(code.style!.backgroundColor, CcColors.dark.codeBg);
    });

    testWidgets('a fenced block carries a copy button', (tester) async {
      // Dragging a selection over several lines on a phone is hopeless, so this
      // button is the only practical way code leaves a chat.
      await tester.pumpWidget(host(
        const MarkdownView(text: '```sh\nnpm run build\n```'),
      ));
      expect(find.text('copy'), findsOneWidget);
    });

    testWidgets('tapping the copy button copies the code and confirms', (tester) async {
      // Intercept the platform clipboard so what actually gets copied is asserted,
      // not merely that a callback fired.
      final copiedToClipboard = <String>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            copiedToClipboard.add((call.arguments as Map)['text'] as String);
          }
          return null;
        },
      );
      addTearDown(() => tester.binding.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null));

      final announced = <String>[];
      await tester.pumpWidget(host(
        MarkdownView(
          text: '```sh\nnpm run build\n```',
          onCopied: announced.add,
        ),
      ));
      await tester.tap(find.text('copy'));
      // Not pumpAndSettle: that would run the 1600 ms reset timer and put the label
      // back to "copy" before it could be checked.
      await tester.pump(const Duration(milliseconds: 50));

      expect(copiedToClipboard, ['npm run build']);
      expect(announced, ['Code copied']);
      expect(find.text('copied'), findsOneWidget);

      // Let the reset timer run, so the label returns and no timer outlives the test.
      await tester.pump(const Duration(milliseconds: 1700));
      expect(find.text('copy'), findsOneWidget);
    });

    testWidgets('a fenced block keeps markup literal', (tester) async {
      await tester.pumpWidget(host(
        const MarkdownView(text: '```dart\nvar x = **not bold**;\n```'),
      ));
      expect(find.text('var x = **not bold**;'), findsOneWidget);
    });

    testWidgets('lists render a marker per item', (tester) async {
      await tester.pumpWidget(host(
        const MarkdownView(text: '- one\n- two\n- three'),
      ));
      expect(find.text('•'), findsNWidgets(3));
      expect(spanWith(tester, 'two'), isNotNull);
    });

    testWidgets('ordered lists number from the given start', (tester) async {
      await tester.pumpWidget(host(const MarkdownView(text: '3. third\n4. fourth')));
      expect(find.text('3.'), findsOneWidget);
      expect(find.text('4.'), findsOneWidget);
    });

    testWidgets('a table renders its cells', (tester) async {
      await tester.pumpWidget(host(
        const MarkdownView(text: '| key | value |\n|---|---|\n| a | 1 |'),
      ));
      expect(find.byType(Table), findsOneWidget);
      expect(spanWith(tester, 'value'), isNotNull);
      expect(spanWith(tester, '1'), isNotNull);
    });

    testWidgets('links are underlined and tappable', (tester) async {
      await tester.pumpWidget(host(
        const MarkdownView(text: 'see [docs](https://example.com)'),
      ));
      final link = spansOf(tester).firstWhere((s) => s.text == 'docs');
      expect(link.style!.decoration, TextDecoration.underline);
    });

    testWidgets('renders a long real-world message without throwing',
        (tester) async {
      const message = '''
## Summary

Done — **three** things changed:

1. `src/discovery.ts` now ranks *birth time* above content
2. The picker is reachable from the key bar
3. Tables render inside a scroll view

| file | change |
|---|---|
| `proc.ts` | check `pane_pid` itself |

> This was the bug that cost the most time.

```ts
const ok = true;
```
''';
      await tester.pumpWidget(host(const MarkdownView(text: message)));
      expect(tester.takeException(), isNull);
      expect(spanWith(tester, 'three').style!.color, CcColors.dark.strong);
      expect(find.byType(Table), findsOneWidget);
    });
  });
}

/// Is the server browser actually reachable?
///
/// The Scaffold sets `drawer:`, and Flutter is supposed to insert a hamburger
/// automatically when it does. This asserts that from the widget tree, because
/// "the drawer exists in the code" and "you can open it on a phone" are not the
/// same claim, and only the second one matters.
void drawerReachabilityTests() {
  group('Sessions screen drawer', () {
    setUp(() => SharedPreferences.setMockInitialValues({}));

    testWidgets('a drawer affordance is present in the app bar', (tester) async {
      final settings = Settings();
      await settings.load();
      await settings.upsert(Connection(
        id: 'sam:7420',
        label: 'sam',
        host: '127.0.0.1',
        port: 7420,
        token: 'x' * 16,
      ));

      await tester.pumpWidget(MaterialApp(
        theme: buildTheme(Brightness.dark),
        home: SessionsScreen(
          api: CcApi(host: '127.0.0.1', port: 7420, token: 'x' * 16),
          settings: settings,
        ),
      ));
      await tester.pump(const Duration(milliseconds: 100));

      final scaffold = tester.widget<Scaffold>(find.byType(Scaffold).first);
      expect(scaffold.drawer, isNotNull, reason: 'Scaffold declares no drawer');

      // The affordance the user has to find and tap.
      final hamburger = find.byTooltip('Open navigation menu');
      final anyMenuIcon = find.byIcon(Icons.menu);
      expect(
        hamburger.evaluate().isNotEmpty || anyMenuIcon.evaluate().isNotEmpty,
        isTrue,
        reason: 'no hamburger in the app bar — the drawer is swipe-only, which is '
            'undiscoverable. Icons found: '
            '${tester.widgetList<Icon>(find.byType(Icon)).map((i) => i.icon?.toString()).toList()}',
      );
    });
  });
}


/// The repo has to be *visible*, not merely present.
///
/// Session names repeat across projects — two live panes were once both called
/// "implementing MEGA bucket" — so the project is what identifies a conversation.
/// This asserts it is in the title and carries the emphasis accent, in both themes,
/// because "I moved it into the title" is a claim about pixels and the rest of this
/// suite cannot see any.
void repoInTitleTests() {
  SessionInfo session() => SessionInfo(
        serverId: 'sam',
        uuid: '2847d280-bf1a-4be6-85fa-eab2c2da0907',
        paneId: '%0',
        tmuxSession: 'myclinic',
        cwd: '/home/you/Dev/my-clinic',
        title: 'implementing MEGA bucket',
        working: false,
        confidence: MatchConfidence.strong,
        lastActivity: null,
        lastMessage: null,
      );

  for (final brightness in [Brightness.dark, Brightness.light]) {
    testWidgets('chat header shows the repo in the accent colour (${brightness.name})',
        (tester) async {
      final palette = brightness == Brightness.dark ? CcColors.dark : CcColors.light;
      await tester.pumpWidget(MaterialApp(
        theme: buildTheme(brightness),
        home: ChatScreen(
          api: CcApi(host: '127.0.0.1', port: 1, token: 'x' * 16),
          serverId: 'sam',
          session: session(),
        ),
      ));
      await tester.pump(const Duration(milliseconds: 50));

      final repo = spanWith(tester, 'my-clinic');
      expect(repo.style?.color, palette.strong,
          reason: 'the repo must use the emphasis accent, not body text');
      expect(repo.style?.fontWeight, FontWeight.w700);

      // The title still follows it, in ordinary text colour.
      final rest = spanWith(tester, '  implementing MEGA bucket');
      expect(rest.style?.color, palette.text);
    });
  }
}
