import 'package:flutter/material.dart';

import '../api.dart';
import '../models.dart';
import '../store.dart';
import '../theme.dart';

/// Add another hub.
///
/// The credentials are checked against the server before anything is stored, so a
/// saved server is always one that worked at least once — tapping it later goes
/// straight to its sessions.
class AddServerScreen extends StatefulWidget {
  const AddServerScreen({super.key, required this.settings});
  final Settings settings;

  @override
  State<AddServerScreen> createState() => _AddServerScreenState();
}

class _AddServerScreenState extends State<AddServerScreen> {
  final _label = TextEditingController();
  final _host = TextEditingController();
  final _port = TextEditingController(text: '7420');
  final _username = TextEditingController();
  final _password = TextEditingController();

  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    for (final c in [_label, _host, _port, _username, _password]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    final host = _host.text.trim();
    final port = int.tryParse(_port.text.trim()) ?? 0;
    final username = _username.text.trim();
    final password = _password.text;

    if (host.isEmpty || username.isEmpty || password.isEmpty) {
      setState(() => _error = 'Server, username and password are all needed.');
      return;
    }
    if (port <= 0 || port > 65535) {
      setState(() => _error = 'That port is not valid.');
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      final token = await CcApi.login(
        host: host,
        port: port,
        username: username,
        password: password,
      );
      final label = _label.text.trim().isEmpty ? host : _label.text.trim();
      await widget.settings.upsert(Connection(
        id: Connection.idFor(host, port),
        label: label,
        host: host,
        port: port,
        token: token,
      ));
      if (!mounted) return;
      Navigator.of(context).pop(label);
    } on ApiException catch (err) {
      if (mounted) setState(() => _error = err.message);
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'Cannot reach $host:$port. Check the address, that '
            'Tailscale is on, and that the hub is running there.');
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final cc = context.cc;

    InputDecoration field(String hint, {bool mono = false}) => InputDecoration(
          hintText: hint,
          hintStyle: TextStyle(
            color: cc.muted,
            fontSize: mono ? 14 : 16,
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
      appBar: AppBar(title: const Text('Add a server')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'Each server runs its own hub with its own login. Sign in once and it '
                'is saved.',
                style: TextStyle(color: cc.muted, fontSize: 14, height: 1.4),
              ),
              const SizedBox(height: 20),
              TextField(
                controller: _label,
                textCapitalization: TextCapitalization.words,
                style: TextStyle(color: cc.text, fontSize: 16),
                decoration: field('Name (optional)'),
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    flex: 3,
                    child: TextField(
                      controller: _host,
                      autocorrect: false,
                      style: TextStyle(
                        color: cc.text,
                        fontFamily: monoFamily,
                        fontSize: 14,
                      ),
                      decoration: field('host or 100.x.y.z', mono: true),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: TextField(
                      controller: _port,
                      keyboardType: TextInputType.number,
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
              TextField(
                controller: _username,
                autocorrect: false,
                autofillHints: const [AutofillHints.username],
                style: TextStyle(color: cc.text, fontSize: 16),
                decoration: field('Username'),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _password,
                obscureText: true,
                autofillHints: const [AutofillHints.password],
                onSubmitted: (_) => _save(),
                style: TextStyle(color: cc.text, fontSize: 16),
                decoration: field('Password'),
              ),
              if (_error != null) ...[
                const SizedBox(height: 12),
                Text(_error!, style: TextStyle(color: cc.bad, fontSize: 13, height: 1.4)),
              ],
              const SizedBox(height: 20),
              FilledButton(
                onPressed: _busy ? null : _save,
                style: FilledButton.styleFrom(
                  backgroundColor: cc.you,
                  foregroundColor: cc.onYou,
                  minimumSize: const Size(0, 50),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                ),
                child: _busy
                    ? SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2, color: cc.onYou),
                      )
                    : const Text('Sign in and save'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
