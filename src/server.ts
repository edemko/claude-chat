import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

import {
  activeSessions,
  hasUsers,
  lockoutRemainingMs,
  login,
  revokeSession,
  safeEqual,
  verifySession,
} from './auth.js';
import { BrowseError, listDir, makeDir } from './browse.js';
import { listCommands } from './commands.js';
import { HOST, PORT, REPO_ROOTS, getToken, loadServers } from './config.js';
import { listRepoDirs } from './create.js';
import { bindPane, countByProvider, listPaneCandidates, listSessions } from './discovery.js';
import { LocalExecutor, SshExecutor, type Executor } from './exec.js';
import { PaneNotClaudeError, capturePane, sendKey, sendText } from './input.js';
import { availableProviders, isProviderId, providerFor } from './providers/index.js';
import { probe } from './proc.js';
import { StreamHub } from './stream.js';
import { historyPage } from './transcript.js';
import { UploadError, storeUpload, uploadMessage } from './upload.js';
import type { ServerConfig, SessionInfo } from './types.js';

const WEB_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'web');
const TOKEN = getToken();
const SERVERS = loadServers();

const executors = new Map<string, Executor>();
for (const cfg of SERVERS) executors.set(cfg.id, makeExecutor(cfg));

function makeExecutor(cfg: ServerConfig): Executor {
  if (cfg.kind === 'ssh') {
    if (!cfg.host) throw new Error(`server ${cfg.id}: kind "ssh" requires a host`);
    return new SshExecutor(cfg.id, cfg.label, cfg.host);
  }
  return new LocalExecutor(cfg.id, cfg.label);
}

function execFor(serverId: string): Executor {
  const exec = executors.get(serverId);
  if (!exec) throw new HttpError(404, `unknown server: ${serverId}`);
  return exec;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Session lists are cached briefly: discovery costs several commands per call and the
 * chat list polls. Concurrent callers share one in-flight refresh.
 */
class SessionCache {
  private cache = new Map<string, { at: number; list: SessionInfo[] }>();
  private inflight = new Map<string, Promise<SessionInfo[]>>();

  async list(serverId: string, maxAgeMs = 4_000): Promise<SessionInfo[]> {
    const hit = this.cache.get(serverId);
    if (hit && Date.now() - hit.at < maxAgeMs) return hit.list;

    const existing = this.inflight.get(serverId);
    if (existing) return existing;

    const task = listSessions(execFor(serverId), serverId)
      .then((list) => {
        this.cache.set(serverId, { at: Date.now(), list });
        return list;
      })
      .finally(() => this.inflight.delete(serverId));

    this.inflight.set(serverId, task);
    return task;
  }

  async get(serverId: string, uuid: string): Promise<SessionInfo> {
    let list = await this.list(serverId);
    let found = list.find((s) => s.uuid === uuid);
    if (!found) {
      // Might be a session that just started — force a refresh before giving up.
      list = await this.list(serverId, 0);
      found = list.find((s) => s.uuid === uuid);
    }
    if (!found) throw new HttpError(404, `no live session ${uuid} on ${serverId}`);
    return found;
  }

  invalidate(serverId: string): void {
    this.cache.delete(serverId);
  }
}

const sessions = new SessionCache();
const hub = new StreamHub();

/**
 * The remote home directory, cached for the life of the process.
 *
 * It costs a round trip to ask and cannot change while the hub runs, yet the session
 * list wants it on every poll — the client shortens paths to `~/…` with it.
 */
const homes = new Map<string, string>();
async function homeOf(serverId: string): Promise<string> {
  const known = homes.get(serverId);
  if (known) return known;
  const { home } = await probe(execFor(serverId));
  homes.set(serverId, home);
  return home;
}

/** Extract the presented credential from either the header or the query string. */
function presentedToken(req: IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  // Query string is needed for WebSocket upgrades and the APK download, neither of
  // which can set a header.
  return url.searchParams.get('token');
}

/**
 * Two kinds of credential are accepted:
 *   - a session token minted by POST /api/login, revocable per device
 *   - the master token in ~/.claude-chat/token, for scripts and the APK link
 *
 * Compared in constant time so a wrong guess reveals nothing through timing.
 */
function authorised(req: IncomingMessage, url: URL): boolean {
  const presented = presentedToken(req, url);
  if (!presented) return false;
  if (safeEqual(presented, TOKEN)) return true;
  return verifySession(presented) !== null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** Bytes as sent, for uploads. Kept separate from readBody, which insists on JSON. */
async function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new HttpError(413, `body over ${Math.round(limit / 1048576)} MB`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function readBody(req: IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new HttpError(413, 'body too large');
    chunks.push(buf);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(WEB_ROOT, rel);
  if (!file.startsWith(WEB_ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    // Unknown paths fall back to the shell so the PWA can own its routing.
    const fallback = join(WEB_ROOT, 'index.html');
    if (!existsSync(fallback)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME['.html']!, 'cache-control': 'no-store' });
    createReadStream(fallback).pipe(res);
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': rel === '/index.html' ? 'no-store' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'servers', id, ...]
  const method = req.method ?? 'GET';

  if (parts[1] === 'health') return sendJson(res, 200, { ok: true });

  // Who am I, and how many devices are signed in.
  if (parts[1] === 'me' && method === 'GET') {
    const presented = presentedToken(req, url);
    const username = presented ? verifySession(presented) : null;
    return sendJson(res, 200, {
      username,
      viaMasterToken: username === null,
      devices: activeSessions().length,
    });
  }

  // Sign this device out. The master token cannot be revoked this way.
  if (parts[1] === 'logout' && method === 'POST') {
    const presented = presentedToken(req, url);
    return sendJson(res, 200, { revoked: presented ? revokeSession(presented) : false });
  }

  /*
   * GET /api/apk?token=… — download the latest built Android client.
   *
   * Served from the Flutter build output rather than checked in, so no 18 MB
   * binary lives in git. Authorised like any other endpoint, which is why the
   * token goes in the query string: a browser navigation cannot set a header.
   */
  if (parts[1] === 'apk' && method === 'GET') {
    const abi = url.searchParams.get('abi') ?? 'arm64-v8a';
    if (!/^[\w-]+$/.test(abi)) throw new HttpError(400, 'bad abi');
    const apk = join(
      WEB_ROOT,
      '..',
      'flutter_client/build/app/outputs/flutter-apk',
      `app-${abi}-release.apk`,
    );
    if (!existsSync(apk)) {
      throw new HttpError(404, `no APK built for ${abi} — run flutter build apk --release --split-per-abi`);
    }
    res.writeHead(200, {
      'content-type': 'application/vnd.android.package-archive',
      'content-length': statSync(apk).size,
      'content-disposition': 'attachment; filename="claude-sessions.apk"',
      'cache-control': 'no-store',
    });
    createReadStream(apk).pipe(res);
    return;
  }

  if (parts[1] === 'servers' && parts.length === 2 && method === 'GET') {
    return sendJson(res, 200, {
      servers: SERVERS.map((s) => ({ id: s.id, label: s.label, kind: s.kind })),
    });
  }

  const serverId = parts[2];
  if (parts[1] !== 'servers' || !serverId) throw new HttpError(404, 'unknown endpoint');
  const exec = execFor(serverId);

  // GET /api/servers/:id/sessions
  if (parts[3] === 'sessions' && parts.length === 4 && method === 'GET') {
    const fresh = url.searchParams.get('fresh') === '1';
    const [list, home] = await Promise.all([
      sessions.list(serverId, fresh ? 0 : 4_000),
      homeOf(serverId),
    ]);
    return sendJson(res, 200, { sessions: list, home, counts: countByProvider(list) });
  }

  /*
   * GET /api/servers/:id/commands?cwd=…
   *
   * Built-in slash commands plus whatever this machine and this project define, for
   * the composer's autocomplete. `cwd` is the session's directory: without it only
   * the user-wide commands are listed, since project ones are per-directory.
   */
  if (parts[3] === 'commands' && method === 'GET') {
    const cwd = url.searchParams.get('cwd');
    if (cwd !== null && !cwd.startsWith('/')) throw new HttpError(400, 'cwd must be absolute');
    const which = url.searchParams.get('provider') ?? 'claude';
    if (!isProviderId(which)) throw new HttpError(400, `unknown provider: ${which}`);
    return sendJson(res, 200, {
      ...(await providerFor(which).commands(exec, await homeOf(serverId), cwd)),
      provider: which,
    });
  }

  // POST /api/servers/:id/sessions  {dir, skipPermissions}
  if (parts[3] === 'sessions' && parts.length === 4 && method === 'POST') {
    const body = (await readBody(req)) as {
      dir?: unknown;
      skipPermissions?: unknown;
      provider?: unknown;
    };
    if (typeof body.dir !== 'string' || !body.dir.startsWith('/')) {
      throw new HttpError(400, 'dir must be an absolute path');
    }
    const wanted = typeof body.provider === 'string' ? body.provider : 'claude';
    if (!isProviderId(wanted)) throw new HttpError(400, `unknown provider: ${wanted}`);
    const { home } = await probe(exec);
    if (!(await availableProviders(exec, home)).includes(wanted)) {
      throw new HttpError(409, `${wanted} is not installed on ${serverId}`);
    }
    const created = await providerFor(wanted).create(
      exec,
      serverId,
      body.dir,
      body.skipPermissions === true,
    );
    sessions.invalidate(serverId);
    return sendJson(res, 201, { ...created, provider: wanted });
  }

  // GET /api/servers/:id/dirs — git repos under CC_REPO_ROOTS, the quick list
  if (parts[3] === 'dirs' && method === 'GET') {
    const { home } = await probe(exec);
    const [dirs, providers] = await Promise.all([
      listRepoDirs(exec, home),
      // Which agents this machine actually has. The client offers only these, so a
      // machine without Codex never presents an option that cannot work.
      availableProviders(exec, home),
    ]);
    return sendJson(res, 200, { dirs, roots: REPO_ROOTS, home, providers });
  }

  /*
   * GET /api/servers/:id/browse?path=&hidden=1
   *
   * One directory level. The quick list above only finds repos two levels under a
   * configured root, which leaves anyone whose code lives elsewhere unable to start
   * a session at all; this is the way out of that.
   */
  if (parts[3] === 'browse' && method === 'GET') {
    const { home } = await probe(exec);
    try {
      return sendJson(res, 200, await listDir(exec, home, url.searchParams.get('path') ?? '~', {
        showHidden: url.searchParams.get('hidden') === '1',
      }));
    } catch (err) {
      if (err instanceof BrowseError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  // POST /api/servers/:id/mkdir  {parent, name}
  if (parts[3] === 'mkdir' && method === 'POST') {
    const body = (await readBody(req)) as { parent?: unknown; name?: unknown };
    if (typeof body.parent !== 'string' || typeof body.name !== 'string') {
      throw new HttpError(400, 'parent and name are required');
    }
    const { home } = await probe(exec);
    try {
      return sendJson(res, 200, { path: await makeDir(exec, home, body.parent, body.name) });
    } catch (err) {
      if (err instanceof BrowseError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  // GET /api/servers/:id/candidates?pane=%0 — transcripts this pane could be running
  if (parts[3] === 'candidates' && method === 'GET') {
    const pane = url.searchParams.get('pane');
    if (!pane) throw new HttpError(400, 'pane is required');
    return sendJson(res, 200, { candidates: await listPaneCandidates(exec, pane) });
  }

  // POST /api/servers/:id/bind  {pane, transcriptUuid}
  if (parts[3] === 'bind' && method === 'POST') {
    const body = (await readBody(req)) as { pane?: unknown; transcriptUuid?: unknown };
    if (typeof body.pane !== 'string' || typeof body.transcriptUuid !== 'string') {
      throw new HttpError(400, 'pane and transcriptUuid are required');
    }
    const bound = await bindPane(exec, serverId, body.pane, body.transcriptUuid);
    sessions.invalidate(serverId);
    return sendJson(res, 200, bound);
  }

  const uuid = parts[4];
  if (parts[3] !== 'sessions' || !uuid) throw new HttpError(404, 'unknown endpoint');
  const action = parts[5];

  /*
   * GET .../sessions/:uuid/history?limit=&before=
   *
   * Returns the newest page by default. `before` is the `cursor` from a previous
   * response — pass it to fetch the window immediately preceding that page, which is
   * what scrolling up does. Converting the entire transcript on open was slow and
   * pointless, since the view starts at the bottom.
   */
  if (action === 'history' && method === 'GET') {
    const session = await sessions.get(serverId, uuid);
    const limit = Number(url.searchParams.get('limit') ?? 60) || 60;
    const beforeRaw = url.searchParams.get('before');
    const before = beforeRaw === null ? undefined : Number(beforeRaw);
    if (before !== undefined && (!Number.isFinite(before) || before < 0)) {
      throw new HttpError(400, 'before must be a non-negative byte offset');
    }
    // No transcript yet — a session that has not been spoken to. Empty, not an error.
    if (!session.transcript) {
      return sendJson(res, 200, { session, events: [], cursor: 0, hasMore: false });
    }
    const page = await historyPage(
      exec,
      session.transcript,
      providerFor(session.provider).toEvents,
      { before, limit },
    );
    return sendJson(res, 200, { session, ...page });
  }

  // POST .../sessions/:uuid/send  {text}
  if (action === 'send' && method === 'POST') {
    const body = (await readBody(req)) as { text?: unknown };
    if (typeof body.text !== 'string' || !body.text.trim()) {
      throw new HttpError(400, 'text is required');
    }
    const session = await sessions.get(serverId, uuid);
    await sendText(exec, session.paneId, body.text);
    return sendJson(res, 200, { ok: true });
  }

  /*
   * POST .../sessions/:uuid/upload?caption=…   raw image bytes
   *
   * Content-Type states the format; the bytes are checked against it. The file is
   * written on the session's own machine and its path is typed into the pane, since
   * that is how Claude Code is given an image.
   */
  if (action === 'upload' && method === 'POST') {
    const contentType = req.headers['content-type'] ?? '';
    const data = await readRawBody(req, 12 * 1024 * 1024);
    const session = await sessions.get(serverId, uuid);
    const { home } = await probe(exec);
    try {
      const stored = await storeUpload(exec, home, session.uuid, contentType, data);
      const caption = url.searchParams.get('caption') ?? '';
      await sendText(exec, session.paneId, uploadMessage(stored.path, caption));
      return sendJson(res, 200, { ok: true, ...stored });
    } catch (err) {
      if (err instanceof UploadError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  // POST .../sessions/:uuid/key  {key}
  if (action === 'key' && method === 'POST') {
    const body = (await readBody(req)) as { key?: unknown };
    if (typeof body.key !== 'string') throw new HttpError(400, 'key is required');
    const session = await sessions.get(serverId, uuid);
    await sendKey(exec, session.paneId, body.key, providerFor(session.provider).clearKey);
    return sendJson(res, 200, { ok: true });
  }

  // GET .../sessions/:uuid/info — status line and session facts for the "i" sheet
  if (action === 'info' && method === 'GET') {
    const session = await sessions.get(serverId, uuid);
    const detail = await providerFor(session.provider).detail(exec, session);
    return sendJson(res, 200, { session, ...detail });
  }

  // GET .../sessions/:uuid/peek — raw screen, to sanity-check a weak mapping
  if (action === 'peek' && method === 'GET') {
    const session = await sessions.get(serverId, uuid);
    return sendJson(res, 200, { text: await capturePane(exec, session.paneId) });
  }

  throw new HttpError(404, 'unknown endpoint');
}

/**
 * Login is the one endpoint that cannot require a credential.
 *
 * Kept out of handleApi so there is no path where an unauthenticated request reaches
 * the session machinery.
 */
async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readBody(req)) as { username?: unknown; password?: unknown };
  if (typeof body.username !== 'string' || typeof body.password !== 'string') {
    throw new HttpError(400, 'username and password are required');
  }

  const waitMs = lockoutRemainingMs(body.username);
  if (waitMs > 0) {
    throw new HttpError(429, `too many attempts — try again in ${Math.ceil(waitMs / 1000)}s`);
  }

  const label = (req.headers['user-agent'] ?? 'unknown device').toString();
  const result = await login(body.username, body.password, label);
  if (!result) {
    // Deliberately identical for an unknown user and a wrong password.
    throw new HttpError(401, 'wrong username or password');
  }
  console.log(`[auth] ${result.username} logged in (${label.slice(0, 60)})`);
  sendJson(res, 200, result);
}

/*
 * Cross-origin access to /api.
 *
 * The PWA is served by one hub but can be pointed at others, which makes those calls
 * cross-origin. `*` is safe here specifically because authentication is a bearer
 * token in a header, never a cookie: the browser attaches nothing automatically, and
 * a hostile page cannot read another origin's stored token. Were this cookie-based,
 * this would be a hole.
 */
function applyCors(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization, content-type');
  res.setHeader('access-control-max-age', '600');
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (!url.pathname.startsWith('/api/')) {
    serveStatic(req, res, url.pathname);
    return;
  }

  applyCors(res);

  // Preflight for the JSON POSTs; must answer before any credential check.
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  // Unauthenticated: whether login is even configured, and login itself.
  if (url.pathname === '/api/auth-mode' && req.method === 'GET') {
    sendJson(res, 200, { passwordLogin: hasUsers() });
    return;
  }
  if (url.pathname === '/api/login') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'POST only' });
      return;
    }
    handleLogin(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
        return;
      }
      console.error('[auth]', err);
      sendJson(res, 500, { error: 'login failed' });
    });
    return;
  }

  if (!authorised(req, url)) {
    sendJson(res, 401, { error: 'unauthorised' });
    return;
  }

  handleApi(req, res, url).catch((err: unknown) => {
    if (err instanceof PaneNotClaudeError) {
      sendJson(res, 409, { error: err.message, code: 'pane-not-claude' });
      return;
    }
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: err.message });
      return;
    }
    console.error('[api]', err);
    sendJson(res, 500, { error: err instanceof Error ? err.message : 'internal error' });
  });
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/ws' || !authorised(req, url)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => attachSocket(ws, url));
});

function attachSocket(ws: WebSocket, url: URL): void {
  const serverId = url.searchParams.get('server');
  const sessionUuid = url.searchParams.get('session');
  if (!serverId || !executors.has(serverId)) {
    ws.send(JSON.stringify({ type: 'error', message: 'unknown server' }));
    ws.close();
    return;
  }

  const send = (msg: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  let unsubscribe: (() => void) | null = null;
  let closed = false;

  if (sessionUuid) {
    void sessions
      .get(serverId, sessionUuid)
      .then((session) => {
        if (closed || !session.transcript) return;
        unsubscribe = hub.subscribe(
          execFor(serverId),
          serverId,
          session.transcript,
          providerFor(session.provider).toEvents,
          (events) => send({ type: 'events', sessionUuid, events }),
        );
      })
      .catch((err: unknown) => {
        send({ type: 'error', message: err instanceof Error ? err.message : 'stream failed' });
      });
  }

  // Keep the chat list live even when a single session is being watched.
  const pushSessions = () => {
    void Promise.all([sessions.list(serverId, 4_000), homeOf(serverId)])
      .then(([list, home]) =>
        send({ type: 'sessions', sessions: list, home, counts: countByProvider(list) }),
      )
      .catch((err: unknown) => console.error('[ws] session list failed:', err));
  };
  pushSessions();
  const interval = setInterval(pushSessions, 5_000);

  ws.on('close', () => {
    closed = true;
    clearInterval(interval);
    unsubscribe?.();
  });
  ws.on('error', (err) => console.error('[ws]', err));
}

function listen(host: string, isRetry = false): void {
  server.once('error', (err: NodeJS.ErrnoException) => {
    if (!isRetry && (err.code === 'EADDRNOTAVAIL' || err.code === 'EINVAL')) {
      console.error(
        `[server] cannot bind ${host}:${PORT} (${err.code}). ` +
          `Is Tailscale up? Falling back to 127.0.0.1 — the phone will NOT reach this.`,
      );
      listen('127.0.0.1', true);
      return;
    }
    console.error('[server] listen failed:', err);
    process.exit(1);
  });

  server.listen(PORT, host, () => {
    console.log(`claude-chat listening on http://${host}:${PORT}`);
    console.log(`open on phone:  http://${host}:${PORT}/?t=${TOKEN}`);
    console.log(`servers: ${SERVERS.map((s) => `${s.id} (${s.kind})`).join(', ')}`);
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n[server] ${signal}, shutting down`);
    hub.stopAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000);
  });
}

listen(HOST);
