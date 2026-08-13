#!/usr/bin/env python3
"""
Claude Code hook -> ntfy push notification.

Wired to the Stop and Notification hooks so the phone learns that a session
finished a turn or is waiting for input. Reads the hook payload on stdin.

This runs on every hook fire, in-process with Claude Code, so it must be fast and
must never fail the session: every error path exits 0 silently.

Usage (from ~/.claude/settings.json):
    python3 /path/to/claude-chat/scripts/cc-notify.py Stop
    python3 /path/to/claude-chat/scripts/cc-notify.py Notification
"""
import json
import os
import sys
import urllib.request

NTFY_URL = os.environ.get('CC_NTFY_URL', 'http://127.0.0.1:8080')
TOPIC = os.environ.get('CC_NTFY_TOPIC', 'claude-sessions')
# Tapping the notification opens the chat app.
APP_URL = os.environ.get('CC_APP_URL', 'http://127.0.0.1:7420/')
# Which machine this came from. Several hubs can publish to one topic, which keeps
# the phone on a single subscription, but then the title is the only thing that
# says where a session is running — and repo names alone are ambiguous. Empty by
# default, so a single-server install is unchanged.
LABEL = os.environ.get('CC_NTFY_LABEL', '')
TAIL_BYTES = 400_000


def last_ai_title(path):
    """Most recent ai-title record. Scanned line-wise; titles are written rarely."""
    title = None
    try:
        with open(path, encoding='utf8', errors='replace') as f:
            for line in f:
                if '"ai-title"' not in line:
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if d.get('type') == 'ai-title' and d.get('aiTitle'):
                    title = d['aiTitle']
    except OSError:
        return None
    return title


def last_assistant_text(path):
    try:
        size = os.path.getsize(path)
        with open(path, 'rb') as f:
            f.seek(max(0, size - TAIL_BYTES))
            chunk = f.read().decode('utf8', 'replace')
    except OSError:
        return None

    text = None
    # Drop the first line: a byte-offset read almost always splits a record.
    for line in chunk.split('\n')[1:]:
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if d.get('type') != 'assistant' or d.get('isSidechain'):
            continue
        content = d.get('message', {}).get('content')
        if not isinstance(content, list):
            continue
        for block in content:
            if isinstance(block, dict) and block.get('type') == 'text' and block.get('text'):
                text = block['text']
    return text


def main():
    event = sys.argv[1] if len(sys.argv) > 1 else 'Stop'
    try:
        payload = json.loads(sys.stdin.read() or '{}')
    except ValueError:
        return

    transcript = payload.get('transcript_path') or ''
    cwd = payload.get('cwd') or ''
    repo = os.path.basename(cwd.rstrip('/')) or 'session'

    title = (last_ai_title(transcript) if transcript else None) or repo
    if LABEL:
        title = f'{LABEL} · {title}'
    body = payload.get('message') or ''
    if not body and transcript:
        body = last_assistant_text(transcript) or ''
    body = ' '.join(body.split())[:400] or f'{event} in {repo}'

    if event == 'Notification':
        tags, priority = 'bell', '4'      # waiting on you — worth a louder buzz
    else:
        tags, priority = 'white_check_mark', '3'

    req = urllib.request.Request(
        f'{NTFY_URL.rstrip("/")}/{TOPIC}',
        data=body.encode('utf8'),
        headers={
            'Title': title.encode('utf8').decode('latin-1', 'replace'),
            'Tags': tags,
            'Priority': priority,
            'Click': APP_URL,
        },
    )
    try:
        urllib.request.urlopen(req, timeout=2).read()
    except Exception:
        # No notification is fine; blocking or failing the session is not.
        pass


if __name__ == '__main__':
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
