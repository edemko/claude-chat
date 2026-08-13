import 'package:flutter/material.dart';

import '../api.dart';
import '../models.dart';
import '../store.dart';
import '../theme.dart';

/// Sign-in screen.
///
/// Password login is the normal path: a password can be remembered and typed on a
/// new device. Pasting the hub's startup link is kept as a fallback for when no
/// password is configured yet, since that link is what the hub prints on first run.
class SetupScreen extends StatefulWidget {
  const SetupScreen({super.key, required this.settings});
  final Settings settings;

  @override
  State<SetupScreen> createState() => _SetupScreenState();
}

class _SetupScreenState extends State<SetupScreen> {
  late final _host = TextEditingController(
    text: widget.settings.active?.host ?? '',
  );
  late final _port = TextEditingController(
    text: '${widget.settings.active?.port ?? 7420}',
  );
  final _username = TextEditingController();
  final _password = TextEditingController();
  final _link = TextEditingController();

  bool _busy = false;
  bool _useLink = false;
  bool? _passwordLogin;
  String? _error;

  @override
  void initState() {
    super.initState();
    _checkAuthMode();
  }

  @override
  void dispose() {
    for (final c in [_host, _port, _username, _password, _link]) {
      c.dispose();
    }
    super.dispose();
  }

  int get _portValue => int.tryParse(_port.text.trim()) ?? 7420;

  Future<void> _checkAuthMode() async {
    final available = await CcApi.passwordLoginAvailable(
      host: _host.text.trim(),
      port: _portValue,
    );
    if (!mounted) return;
    setState(() {
      _passwordLogin = available;
      // Nothing to type a password into yet, so offer the link instead.
      if (!available) _useLink = true;
    });
  }

  Future<void> _signIn() async {
    final host = _host.text.trim();
    final username = _username.text.trim();
    final password = _password.text;
    if (host.isEmpty || username.isEmpty || password.isEmpty) {
      setState(() => _error = 'Fill in the server, username and password.');
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final token = await CcApi.login(
        host: host,
        port: _portValue,
        username: username,
        password: password,
      );
      _password.clear();
      // Saving notifies Settings, which swaps this screen for the session list.
      await widget.settings.upsert(Connection(
        id: Connection.idFor(host, _portValue),
        label: host,
        host: host,
        port: _portValue,
        token: token,
      ));
    } on ApiException catch (err) {
      if (!mounted) return;
      setState(() => _error = err.message);
    } catch (err) {
      if (!mounted) return;
      setState(() => _error = 'Cannot reach $host:$_portValue. Is Tailscale on?');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _useStartupLink() async {
    final parsed = ConnectionLink.tryParse(
      _link.text,
      fallbackHost: _host.text.trim(),
      fallbackPort: _portValue,
    );
    if (parsed == null) {
      setState(() => _error = 'That does not look like the hub link. Paste the whole '
          'URL, including the ?t= part.');
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });
    final api = CcApi(host: parsed.host, port: parsed.port, token: parsed.token);
    final reachable = await api.ping();
    if (!mounted) return;
    if (!reachable) {
      setState(() {
        _busy = false;
        _error = 'No answer from ${parsed.host}:${parsed.port}. Is Tailscale on, and '
            'is the hub running?';
      });
      return;
    }
    await widget.settings.upsert(Connection(
      id: Connection.idFor(parsed.host, parsed.port),
      label: parsed.host,
      host: parsed.host,
      port: parsed.port,
      token: parsed.token,
    ));
  }

  @override
  Widget build(BuildContext context) {
    final cc = context.cc;

    InputDecoration field(String hint, {bool mono = false}) => InputDecoration(
          hintText: hint,
          hintStyle: TextStyle(
            color: cc.muted,
            fontSize: mono ? 13 : 16,
            fontFamily: mono ? monoFamily : null,
          ),
          filled: true,
          fillColor: cc.panel,
          contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: BorderSide(color: cc.line),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: BorderSide(color: cc.you),
          ),
        );

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    'Claude sessions',
                    style: TextStyle(
                      color: cc.text,
                      fontSize: 24,
                      fontWeight: FontWeight.w600,
                      letterSpacing: -0.5,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    _passwordLogin == false
                        ? 'No password is set on the hub yet. Paste the link it printed '
                            'at startup, or run cc-user.mjs on the server.'
                        : 'Sign in to the hub. It is reachable over Tailscale only, so '
                            'the phone needs Tailscale running.',
                    style: TextStyle(color: cc.muted, fontSize: 14, height: 1.4),
                  ),
                  const SizedBox(height: 22),

                  // Server address, needed by both paths.
                  Row(
                    children: [
                      Expanded(
                        flex: 3,
                        child: TextField(
                          controller: _host,
                          autocorrect: false,
                          onEditingComplete: _checkAuthMode,
                          style: TextStyle(
                            color: cc.text,
                            fontFamily: monoFamily,
                            fontSize: 14,
                          ),
                          decoration: field('host', mono: true),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: TextField(
                          controller: _port,
                          keyboardType: TextInputType.number,
                          onEditingComplete: _checkAuthMode,
                          style: TextStyle(
                            color: cc.text,
                            fontFamily: monoFamily,
                            fontSize: 14,
                          ),
                          decoration: field('port', mono: true),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 10),

                  if (!_useLink) ...[
                    TextField(
                      controller: _username,
                      autocorrect: false,
                      textCapitalization: TextCapitalization.none,
                      autofillHints: const [AutofillHints.username],
                      style: TextStyle(color: cc.text, fontSize: 16),
                      decoration: field('Username'),
                    ),
                    const SizedBox(height: 10),
                    TextField(
                      controller: _password,
                      obscureText: true,
                      autofillHints: const [AutofillHints.password],
                      onSubmitted: (_) => _signIn(),
                      style: TextStyle(color: cc.text, fontSize: 16),
                      decoration: field('Password'),
                    ),
                  ] else ...[
                    TextField(
                      controller: _link,
                      autocorrect: false,
                      minLines: 2,
                      maxLines: 4,
                      style: TextStyle(
                        color: cc.text,
                        fontFamily: monoFamily,
                        fontSize: 13,
                      ),
                      decoration: field('http://100.64.0.1:7420/?t=…', mono: true),
                    ),
                  ],

                  if (_error != null) ...[
                    const SizedBox(height: 12),
                    Text(
                      _error!,
                      style: TextStyle(color: cc.bad, fontSize: 13, height: 1.4),
                    ),
                  ],

                  const SizedBox(height: 18),
                  FilledButton(
                    onPressed: _busy ? null : (_useLink ? _useStartupLink : _signIn),
                    style: FilledButton.styleFrom(
                      backgroundColor: cc.you,
                      foregroundColor: cc.onYou,
                      minimumSize: const Size(0, 50),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                    child: _busy
                        ? SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: cc.onYou,
                            ),
                          )
                        : Text(_useLink ? 'Connect' : 'Sign in'),
                  ),

                  const SizedBox(height: 6),
                  TextButton(
                    onPressed: _busy
                        ? null
                        : () => setState(() {
                              _useLink = !_useLink;
                              _error = null;
                            }),
                    style: TextButton.styleFrom(foregroundColor: cc.muted),
                    child: Text(
                      _useLink ? 'Use a username and password' : 'Paste a link instead',
                      style: const TextStyle(fontSize: 13.5),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
