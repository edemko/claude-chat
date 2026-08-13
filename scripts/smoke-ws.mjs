/**
 * Live-stream smoke test: create a throwaway session, watch it over the WebSocket,
 * send a prompt, and assert the events arrive without polling.
 *
 *   node scripts/smoke-ws.mjs
 *
 * Uses a scratch directory, never a real session.
 */
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import WebSocket from 'ws';

const HOST = process.env.CC_TEST_HOST ?? '127.0.0.1';
const PORT = process.env.CC_PORT ?? '7420';
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = readFileSync(join(homedir(), '.claude-chat/token'), 'utf8').trim();
const DIR = '/tmp/claude-1000/cc-ws-smoke';

const api = async (path, options = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function openSocket(sessionUuid) {
  const qs = new URLSearchParams({ server: 'sam', token: TOKEN });
  if (sessionUuid) qs.set('session', sessionUuid);
  return new WebSocket(`ws://${HOST}:${PORT}/ws?${qs}`);
}

let created = null;
try {
  mkdirSync(DIR, { recursive: true });

  console.log('1. socket without a session should still push the session list');
  const listSocket = openSocket(null);
  const gotList = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no sessions message in 15s')), 15_000);
    listSocket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'sessions') {
        clearTimeout(timer);
        resolve(msg.sessions);
      }
    });
    listSocket.on('error', reject);
  });
  console.log(`   received ${gotList.length} sessions`);
  listSocket.close();

  console.log('2. creating a throwaway session');
  created = await api('/api/servers/sam/sessions', {
    method: 'POST',
    body: JSON.stringify({ dir: DIR, skipPermissions: true }),
  });
  console.log(`   uuid=${created.uuid.slice(0, 8)} pane=${created.paneId} ` +
              `ready=${created.ready} trustAnswered=${created.trustPromptAnswered}`);

  console.log('3. subscribing to the session, then sending a prompt');
  const socket = openSocket(created.uuid);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  const events = [];
  socket.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'events') events.push(...msg.events);
    if (msg.type === 'error') console.log(`   ws error: ${msg.message}`);
  });

  await wait(4_000);
  await api(`/api/servers/sam/sessions/${created.uuid}/send`, {
    method: 'POST',
    body: JSON.stringify({ text: 'Reply with exactly one word: streamed' }),
  });
  console.log('   prompt sent, waiting for pushed events');

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const hasUser = events.some((e) => e.kind === 'user');
    const hasAssistant = events.some((e) => e.kind === 'assistant');
    if (hasUser && hasAssistant) break;
    await wait(2_000);
  }
  socket.close();

  const byKind = events.reduce((acc, e) => ({ ...acc, [e.kind]: (acc[e.kind] ?? 0) + 1 }), {});
  console.log(`\n   events pushed over the socket: ${events.length} ${JSON.stringify(byKind)}`);
  for (const e of events.filter((e) => e.kind === 'user' || e.kind === 'assistant')) {
    console.log(`     ${e.kind}: ${JSON.stringify(e.text.slice(0, 70))}`);
  }

  const ok = events.some((e) => e.kind === 'user') && events.some((e) => e.kind === 'assistant');
  console.log(`\n${ok ? 'PASS' : 'FAIL'}: live stream delivered both directions`);
  process.exitCode = ok ? 0 : 1;
} finally {
  if (created?.tmuxSession) {
    try {
      execFileSync('tmux', ['kill-session', '-t', created.tmuxSession]);
      console.log(`cleanup: killed ${created.tmuxSession}`);
    } catch {
      // already gone
    }
  }
  rmSync(DIR, { recursive: true, force: true });
}
