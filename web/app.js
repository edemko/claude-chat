import { renderMarkdown } from './markdown.js';

const $ = (id) => document.getElementById(id);

const state = {
  connections: [],
  activeId: null,
  serverId: null,
  sessions: [],
  session: null,
  /** id -> element, so live batches append instead of re-rendering the thread. */
  nodes: new Map(),
  /** tool_use_id -> {ok, preview}; results can arrive before or after their chip. */
  results: new Map(),
  seen: new Set(),
  ws: null,
  wsBackoff: 500,
  /** Byte offset of the oldest loaded record; pass as `before` for older pages. */
  cursor: null,
  hasMore: false,
  loadingOlder: false,
  /** Directory the folder browser is currently showing. */
  browsePath: null,
  /** A /rename outranks the automatic title, whichever arrives later. */
  titleIsCustom: false,
};

/** Opening page: roughly two screenfuls. Older pages load on scroll. */
const PAGE_SIZE = 40;

/* ---------- connections ---------- */

/*
 * The client keeps its own list of servers, each a hub with its own credential.
 * This is a different axis from the hub's servers.json, which is one hub reaching
 * other machines over SSH; here the phone talks to several hubs directly.
 */
const CONNS_KEY = 'cc-connections';
const ACTIVE_KEY = 'cc-active';

function loadConnections() {
  try {
    const raw = JSON.parse(localStorage.getItem(CONNS_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((c) => c && c.host && c.token) : [];
  } catch {
    return [];
  }
}

function saveConnections(list) {
  state.connections = list;
  localStorage.setItem(CONNS_KEY, JSON.stringify(list));
}

function connOrigin(conn) {
  return `http://${conn.host}:${conn.port}`;
}

function setActive(id) {
  state.activeId = id;
  localStorage.setItem(ACTIVE_KEY, id);
}

function activeConn() {
  return state.connections.find((c) => c.id === state.activeId) ?? state.connections[0] ?? null;
}

function upsertConnection(conn) {
  const list = loadConnections();
  const at = list.findIndex((c) => c.host === conn.host && c.port === conn.port);
  if (at >= 0) list[at] = { ...list[at], ...conn };
  else list.push(conn);
  saveConnections(list);
  setActive(conn.id);
}

/** The hub that served this page, used for the first-run login. */
function servingHost() {
  return {
    host: location.hostname,
    port: Number(location.port || (location.protocol === 'https:' ? 443 : 80)),
  };
}

(function initConnections() {
  state.connections = loadConnections();
  state.activeId = localStorage.getItem(ACTIVE_KEY) ?? state.connections[0]?.id ?? null;

  // A token in the URL, or one stored by an older build, becomes a connection to
  // whichever hub served this page.
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('t');
  const legacy = localStorage.getItem('cc-token');
  const token = fromUrl ?? legacy;

  if (token) {
    const { host, port } = servingHost();
    upsertConnection({
      id: `${host}:${port}`,
      label: host,
      host,
      port,
      token,
    });
    localStorage.removeItem('cc-token');
    if (fromUrl) {
      url.searchParams.delete('t');
      history.replaceState({}, '', url);
    }
  }
})();

/* ---------- theme ---------- */

const THEMES = ['system', 'light', 'dark'];
const THEME_ICON = { system: '◐', light: '☀', dark: '☾' };
const THEME_NAME = { system: 'follows system', light: 'light', dark: 'dark' };
// Tints the Android status bar when installed to the home screen.
const THEME_COLOR = { light: '#f6f8fc', dark: '#0f1219' };

let themeChoice = 'system';

const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);

  const effective = choice === 'system' ? (systemDark().matches ? 'dark' : 'light') : choice;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[effective]);

  const btn = $('btn-theme');
  btn.textContent = THEME_ICON[choice];
  btn.setAttribute('aria-label', `Theme ${THEME_NAME[choice]} — tap to change`);
}

function initTheme() {
  const saved = localStorage.getItem('cc-theme');
  themeChoice = THEMES.includes(saved) ? saved : 'system';
  applyTheme(themeChoice);

  $('btn-theme').addEventListener('click', () => {
    themeChoice = THEMES[(THEMES.indexOf(themeChoice) + 1) % THEMES.length];
    localStorage.setItem('cc-theme', themeChoice);
    applyTheme(themeChoice);
    toast(`Theme ${THEME_NAME[themeChoice]}`);
  });

  // Keep the status-bar tint correct if the system flips while set to "system".
  systemDark().addEventListener('change', () => {
    if (themeChoice === 'system') applyTheme('system');
  });
}

/* ---------- api ---------- */

async function api(path, options = {}) {
  const conn = options.conn ?? activeConn();
  if (!conn) throw new Error('no server selected');
  // Absolute URL: the active server may not be the one that served this page.
  const res = await fetch(`${connOrigin(conn)}${path}`, {
    ...options,
    headers: {
      // JSON is the default for a body, but an explicit header wins — an image
      // upload sends raw bytes and must not be mislabelled as JSON.
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
      authorization: `Bearer ${conn.token}`,
    },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON error page; fall through to the status-based message.
  }
  if (!res.ok) {
    const err = new Error(body?.error ?? `request failed (${res.status})`);
    err.code = body?.code;
    err.status = res.status;
    throw err;
  }
  return body;
}

/* ---------- helpers ---------- */

function fmtWhen(ts) {
  if (!ts) return '';
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 45) return 'now';
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86400)}d`;
}

const repoOf = (cwd) => cwd.split('/').filter(Boolean).pop() ?? cwd;

/**
 * Build an element. Nodes are constructed, never assembled as HTML strings.
 *
 * Named `mk`, not `el`: several functions here already use `el` as a local for the
 * div they are building, which would shadow this and turn any call inside them into
 * a TypeError that only shows up when that branch runs.
 */
function mk(tag, className, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

let toastTimer = null;
function toast(message, bad = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('is-bad', bad);
  el.classList.add('is-open');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-open'), bad ? 5200 : 2400);
}

function show(which) {
  for (const name of ['login', 'list', 'chat']) {
    $(`screen-${name}`).classList.toggle('is-active', which === name);
  }
}

/* ---------- sign in ---------- */

/** Drop the active connection entirely; used on sign-out and on a 401. */
function forgetActive() {
  const conn = activeConn();
  if (!conn) return;
  saveConnections(state.connections.filter((c) => c.id !== conn.id));
  setActive(state.connections[0]?.id ?? null);
  closeWs();
  state.session = null;
  state.sessions = [];
}

async function doLogin(event) {
  event.preventDefault();
  const username = $('login-user').value.trim();
  const password = $('login-pass').value;
  const error = $('login-error');
  const button = $('login-submit');

  if (!username || !password) {
    error.textContent = 'Enter both a username and a password.';
    return;
  }

  button.disabled = true;
  error.textContent = '';
  try {
    // The one endpoint that takes no credential, so it is called directly.
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? `sign in failed (${res.status})`);

    const { host, port } = servingHost();
    upsertConnection({ id: `${host}:${port}`, label: host, host, port, token: body.token });
    $('login-pass').value = '';
    show('list');
    await boot();
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

$('login-form').addEventListener('submit', doLogin);

/** Falls back to the token screen when no password login is configured. */
async function showLogin() {
  show('login');
  try {
    const res = await fetch('/api/auth-mode');
    const mode = await res.json();
    if (!mode.passwordLogin) {
      $('login-sub').textContent =
        'No password is set on the hub yet. Either run "node scripts/cc-user.mjs set <name>" '
        + 'on the server, or open the link it printed at startup.';
      $('login-form').style.display = 'none';
    }
  } catch {
    $('login-sub').textContent = 'Cannot reach the hub. Is Tailscale on?';
  }
}

async function openAccount() {
  const sheet = $('account-sheet');
  sheet.classList.add('is-open');
  const body = $('account-body');
  body.replaceChildren();

  const row = (label, value) => {
    const el = document.createElement('div');
    el.className = 'account-row';
    const l = document.createElement('span');
    l.className = 'label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'value';
    v.textContent = value;
    el.append(l, v);
    return el;
  };

  let me = null;
  try {
    me = await api('/api/me');
  } catch {
    // Fall through: the rows below still show what is known locally.
  }

  const conn = activeConn();
  body.append(row('Server', conn ? `${conn.host}:${conn.port}` : '—'));
  body.append(row('Signed in as', me?.username ?? '— (master token)'));
  if (me) body.append(row('Devices', String(me.devices)));

  const actions = document.createElement('div');
  actions.className = 'account-actions';
  const out = document.createElement('button');
  out.type = 'button';
  out.textContent = me?.username ? 'Sign out' : 'Forget this token';
  out.addEventListener('click', async () => {
    try {
      if (me?.username) await api('/api/logout', { method: 'POST' });
    } catch {
      // Revoking server-side is best effort; forget it locally regardless.
    }
    forgetActive();
    sheet.classList.remove('is-open');
    await routeStart();
  });
  actions.append(out);
  body.append(actions);
}

$('btn-account').addEventListener('click', openAccount);
$('btn-account-close').addEventListener('click', () => $('account-sheet').classList.remove('is-open'));
$('account-sheet').addEventListener('click', (e) => {
  if (e.target === $('account-sheet')) $('account-sheet').classList.remove('is-open');
});

/* ---------- server browser ---------- */

/** Cheap per-server probe for the drawer: reachable, and who we are there. */
async function probeConn(conn) {
  try {
    const res = await fetch(`${connOrigin(conn)}/api/me`, {
      headers: { authorization: `Bearer ${conn.token}` },
      signal: AbortSignal.timeout(6000),
    });
    if (res.status === 401) return { state: 'unauthorised' };
    if (!res.ok) return { state: 'error' };
    const body = await res.json();
    return { state: 'ok', username: body.username };
  } catch {
    return { state: 'unreachable' };
  }
}

function connRow(conn) {
  const row = document.createElement('div');
  row.className = `conn${conn.id === state.activeId ? ' is-active' : ''}`;

  const pick = document.createElement('button');
  pick.type = 'button';
  pick.className = 'conn-body';
  pick.style.cssText = 'text-align:left;padding:0;background:none;border:none';

  const name = document.createElement('div');
  name.className = 'conn-name';
  name.textContent = conn.label ?? conn.host;

  const meta = document.createElement('div');
  meta.className = 'conn-meta meta';
  meta.textContent = `${conn.host}:${conn.port} · checking…`;

  pick.append(name, meta);
  pick.addEventListener('click', () => selectConn(conn.id));

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'conn-remove';
  remove.textContent = '✕';
  remove.setAttribute('aria-label', `Remove ${conn.label ?? conn.host}`);
  remove.addEventListener('click', (e) => {
    e.stopPropagation();
    removeConn(conn.id);
  });

  row.append(pick, remove);

  // Fire-and-forget: the row renders immediately and fills in its status.
  void probeConn(conn).then((r) => {
    meta.textContent =
      `${conn.host}:${conn.port} · ` +
      (r.state === 'ok'
        ? (r.username ?? 'token')
        : r.state === 'unauthorised'
          ? 'sign in again'
          : r.state === 'unreachable'
            ? 'unreachable'
            : 'error');
  });

  return row;
}

function renderConnections() {
  const list = $('conn-list');
  if (state.connections.length === 0) {
    list.innerHTML =
      '<div class="empty"><strong>No servers yet</strong>Add one to see its Claude sessions.</div>';
    return;
  }
  list.replaceChildren(...state.connections.map(connRow));
}

function openDrawer() {
  renderConnections();
  $('drawer').classList.add('is-open');
}

function closeDrawer() {
  $('drawer').classList.remove('is-open');
}

/** Switch servers: drop all per-server state, then boot against the new one. */
async function selectConn(id) {
  if (id !== state.activeId) {
    setActive(id);
    closeWs();
    state.session = null;
    state.sessions = [];
    state.serverId = null;
    renderSessions();
  }
  closeDrawer();
  show('list');
  await boot();
}

async function removeConn(id) {
  const conn = state.connections.find((c) => c.id === id);
  if (!conn) return;
  saveConnections(state.connections.filter((c) => c.id !== id));
  if (state.activeId === id) {
    setActive(state.connections[0]?.id ?? null);
    closeWs();
    state.session = null;
    state.sessions = [];
    state.serverId = null;
  }
  renderConnections();
  toast(`Removed ${conn.label ?? conn.host}`);
  if (!activeConn()) {
    closeDrawer();
    await routeStart();
  }
}

/**
 * Add a server: the credentials are checked against it before anything is stored,
 * so a saved server is always one that worked at least once.
 */
async function addServer(event) {
  event.preventDefault();
  const host = $('add-host').value.trim();
  const port = Number($('add-port').value.trim() || 7420);
  const username = $('add-user').value.trim();
  const password = $('add-pass').value;
  const label = $('add-label').value.trim() || host;
  const error = $('add-error');
  const button = $('add-submit');

  if (!host || !username || !password) {
    error.textContent = 'Server, username and password are all needed.';
    return;
  }
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    error.textContent = 'That port is not valid.';
    return;
  }

  button.disabled = true;
  error.textContent = '';
  try {
    const res = await fetch(`http://${host}:${port}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? `sign in failed (${res.status})`);

    upsertConnection({ id: `${host}:${port}`, label, host, port, token: body.token });
    $('add-pass').value = '';
    $('add-sheet').classList.remove('is-open');
    error.textContent = '';
    await selectConn(`${host}:${port}`);
    toast(`Added ${label}`);
  } catch (err) {
    // A cross-origin failure and an unreachable host look the same to fetch.
    error.textContent =
      err.name === 'TimeoutError'
        ? `No answer from ${host}:${port}. Is Tailscale on, and the hub running?`
        : err.message === 'Failed to fetch'
          ? `Cannot reach ${host}:${port}. Check the address, Tailscale, and that the hub is running.`
          : err.message;
  } finally {
    button.disabled = false;
  }
}

$('btn-menu').addEventListener('click', openDrawer);
$('btn-drawer-close').addEventListener('click', closeDrawer);
$('drawer').addEventListener('click', (e) => {
  if (e.target === $('drawer')) closeDrawer();
});
$('btn-add-server').addEventListener('click', () => {
  $('add-error').textContent = '';
  $('add-port').value = $('add-port').value || '7420';
  $('add-sheet').classList.add('is-open');
});
$('btn-add-close').addEventListener('click', () => $('add-sheet').classList.remove('is-open'));
$('add-sheet').addEventListener('click', (e) => {
  if (e.target === $('add-sheet')) $('add-sheet').classList.remove('is-open');
});
$('add-form').addEventListener('submit', addServer);

/** Decide the opening screen: sign in when there is no server, otherwise the list. */
async function routeStart() {
  if (!activeConn()) {
    await showLogin();
    return;
  }
  show('list');
  await boot();
}

/* ---------- session list ---------- */

function sessionRow(session) {
  const btn = document.createElement('button');
  btn.className = 'session';
  btn.type = 'button';

  const bead = document.createElement('span');
  bead.className = `bead${session.status === 'working' ? ' is-working' : ''}`;

  const body = document.createElement('div');
  body.className = 'session-body';

  // Repo first, in the accent colour. Session names repeat across projects — two
  // panes were once both called "implementing MEGA bucket" — so the project is what
  // identifies a row and it does not belong in the small print.
  const title = document.createElement('div');
  title.className = 'session-title';
  const repo = document.createElement('span');
  repo.className = 'session-repo';
  repo.textContent = repoOf(session.cwd);
  title.append(repo, document.createTextNode(`  ${session.title}`));

  const meta = document.createElement('div');
  meta.className = 'session-meta meta';
  const where = document.createElement('span');
  // "pane %20", never a bare "%20" — which reads as a percentage.
  where.textContent = `pane ${session.paneId}`;
  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = fmtWhen(session.lastActivity);
  meta.append(where, when);

  body.append(title, meta);

  if (session.lastMessage) {
    const preview = document.createElement('div');
    preview.className = 'session-preview';
    preview.textContent = session.lastMessage;
    body.append(preview);
  }

  btn.append(bead, body);
  btn.addEventListener('click', () => openChat(session));
  return btn;
}

function renderSessions() {
  const list = $('session-list');
  if (state.sessions.length === 0) {
    list.innerHTML =
      '<div class="empty"><strong>No sessions running</strong>' +
      'Tap ＋ to start Claude in one of your repos.</div>';
    return;
  }
  list.replaceChildren(...state.sessions.map(sessionRow));
}

async function refreshSessions(fresh = false) {
  if (!activeConn() || !state.serverId) return;
  try {
    const data = await api(
      `/api/servers/${state.serverId}/sessions${fresh ? '?fresh=1' : ''}`,
    );
    state.sessions = data.sessions;
    renderSessions();
    syncOpenSession();
  } catch (err) {
    if (err.status === 401) {
      forgetActive();
      await routeStart();
      return;
    }
    toast(err.message, true);
  }
}

/** Keep the chat header's status and title in step with the polled list. */
function syncOpenSession() {
  if (!state.session) return;
  // Matched on paneId, not uuid: the pane is the session's real identity. One opened
  // before its first message has no transcript and gains a uuid when that message
  // lands; a /clear swaps the uuid the same way. Either means reopening the thread.
  const fresh = state.sessions.find((s) => s.paneId === state.session.paneId);
  if (!fresh) return;
  if (fresh.uuid !== state.session.uuid) {
    void openChat(fresh);
    return;
  }
  state.session = fresh;
  $('chat-title').textContent = fresh.title;
  $('chat-bead').className = `bead${fresh.status === 'working' ? ' is-working' : ''}`;
}

/* ---------- thread rendering ---------- */

function bubble(ev) {
  const el = document.createElement('div');
  el.className = ev.kind === 'user' ? 'msg from-you' : 'msg from-agent';
  // renderMarkdown builds nodes rather than HTML — message text is never trusted.
  el.appendChild(renderMarkdown(ev.text));
  return el;
}

function toolChip(ev) {
  const wrap = document.createElement('div');
  wrap.className = 'msg tool';

  const head = document.createElement('button');
  head.className = 'tool-head';
  head.type = 'button';

  const dot = document.createElement('span');
  dot.className = 'tool-dot';
  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = ev.name;
  const summary = document.createElement('span');
  summary.className = 'tool-summary';
  summary.textContent = ev.summary;
  head.append(dot, name, summary);

  const result = document.createElement('div');
  result.className = 'tool-result';
  result.textContent = 'No output recorded.';

  head.addEventListener('click', () => wrap.classList.toggle('is-open'));
  wrap.append(head, result);

  const known = state.results.get(ev.id);
  if (known) applyResultTo(wrap, known);
  return wrap;
}

function applyResultTo(chip, result) {
  chip.querySelector('.tool-dot').className = `tool-dot ${result.ok ? 'ok' : 'bad'}`;
  chip.querySelector('.tool-result').textContent = result.preview || '(no output)';
}

function nodeFor(ev) {
  switch (ev.kind) {
    case 'user':
    case 'assistant':
      return bubble(ev);
    case 'tool':
      return toolChip(ev);
    default:
      return null;
  }
}

function addEvents(events, { prepend = false } = {}) {
  const scroller = $('thread-scroll');
  const thread = $('thread');
  const nearBottom =
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
  // Prepending changes the height above the viewport, so the scroll offset has to
  // be shifted by the same amount or the view jumps.
  const heightBefore = scroller.scrollHeight;
  const topBefore = scroller.scrollTop;
  const newNodes = [];

  for (const ev of events) {
    if (ev.kind === 'title') {
      // Claude Code writes an ai-title after every custom-title, so a plain
      // "latest wins" rule would silently undo a /rename.
      if (!ev.custom && state.titleIsCustom) continue;
      if (ev.custom) state.titleIsCustom = true;
      if (state.session) state.session.title = ev.title;
      $('chat-title').textContent = ev.title;
      continue;
    }

    if (ev.kind === 'tool_result') {
      const payload = { ok: ev.ok, preview: ev.preview };
      state.results.set(ev.toolUseId, payload);
      const chip = state.nodes.get(ev.toolUseId);
      if (chip) applyResultTo(chip, payload);
      continue;
    }

    if (state.seen.has(ev.id)) continue;
    state.seen.add(ev.id);

    const node = nodeFor(ev);
    if (!node) continue;
    state.nodes.set(ev.id, node);
    if (prepend) newNodes.push(node);
    else thread.append(node);
  }

  if (prepend) {
    if (newNodes.length > 0) {
      // Older events arrive oldest-first, which is the order they must appear in.
      thread.prepend(...newNodes);
      scroller.scrollTop = topBefore + (scroller.scrollHeight - heightBefore);
    }
    return;
  }

  if (nearBottom) scroller.scrollTop = scroller.scrollHeight;
}

/** Fetch the page preceding what is loaded, triggered by scrolling near the top. */
async function loadOlder() {
  if (state.loadingOlder || !state.hasMore || !state.session || state.cursor === null) return;
  state.loadingOlder = true;
  const spinner = document.createElement('div');
  spinner.className = 'older-spinner';
  spinner.textContent = 'Loading earlier messages…';
  $('thread').prepend(spinner);

  try {
    const data = await api(
      `/api/servers/${state.session.serverId}/sessions/${state.session.uuid}` +
        `/history?limit=${PAGE_SIZE}&before=${state.cursor}`,
    );
    spinner.remove();
    state.cursor = data.cursor;
    state.hasMore = data.hasMore;
    addEvents(data.events, { prepend: true });
    if (!state.hasMore) {
      const start = document.createElement('div');
      start.className = 'older-spinner';
      start.textContent = 'Start of the conversation';
      $('thread').prepend(start);
    }
  } catch (err) {
    spinner.remove();
    toast(err.message, true);
  } finally {
    state.loadingOlder = false;
  }
}

$('thread-scroll').addEventListener('scroll', () => {
  if ($('thread-scroll').scrollTop < 240) void loadOlder();
}, { passive: true });

function setNotice(text, bad = false) {
  const host = $('chat-notice');
  if (!text) {
    host.replaceChildren();
    return;
  }
  const el = document.createElement('div');
  el.className = `notice${bad ? ' bad' : ''}`;
  el.textContent = text;
  host.replaceChildren(el);
}

/**
 * Shown when the pane could not be matched to a transcript with confidence. A
 * session can be resumed or cleared mid-process, so guessing is sometimes the best
 * the server can do — this makes the guess visible and correctable.
 */
function showGuessNotice() {
  const el = document.createElement('div');
  el.className = 'notice';
  el.append(
    document.createTextNode('This is a guess at which conversation the pane is running. '),
  );
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Pick the right one';
  btn.addEventListener('click', openPicker);
  el.append(btn);
  $('chat-notice').replaceChildren(el);
}

/* ---------- chat ---------- */

async function openChat(session) {
  state.session = session;
  state.nodes.clear();
  state.results.clear();
  state.seen.clear();
  state.cursor = null;
  state.hasMore = false;
  state.loadingOlder = false;
  state.titleIsCustom = false;
  $('thread').replaceChildren();
  // Same treatment as the list: repo leads, in the accent colour.
  $('chat-title').replaceChildren();
  const chatRepo = document.createElement('span');
  chatRepo.className = 'session-repo';
  chatRepo.textContent = repoOf(session.cwd);
  $('chat-title').append(chatRepo, document.createTextNode(`  ${session.title}`));
  $('chat-meta').textContent =
    `${session.serverId} · pane ${session.paneId} · ` +
    `${session.confidence === 'pending' ? 'no transcript yet' : session.uuid.slice(0, 8)}`;
  $('chat-bead').className = `bead${session.status === 'working' ? ' is-working' : ''}`;
  if (session.confidence === 'weak') showGuessNotice();
  else setNotice('');
  show('chat');

  try {
    const data = await api(
      `/api/servers/${session.serverId}/sessions/${session.uuid}/history?limit=${PAGE_SIZE}`,
    );
    state.cursor = data.cursor;
    state.hasMore = data.hasMore;
    addEvents(data.events);
    // Open at the newest message, the way a chat app should.
    $('thread-scroll').scrollTop = $('thread-scroll').scrollHeight;
  } catch (err) {
    toast(err.message, true);
  }
  connectWs(session);
}

function closeWs() {
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
    state.ws = null;
  }
}

function connectWs(session) {
  closeWs();
  const conn = activeConn();
  if (!conn) return;
  const url =
    `ws://${conn.host}:${conn.port}/ws?server=${encodeURIComponent(session.serverId)}` +
    `&session=${encodeURIComponent(session.uuid)}&token=${encodeURIComponent(conn.token)}`;
  const ws = new WebSocket(url);
  state.ws = ws;

  ws.onopen = () => {
    state.wsBackoff = 500;
  };
  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === 'events') {
      if (state.session && msg.sessionUuid === state.session.uuid) addEvents(msg.events);
    } else if (msg.type === 'sessions') {
      state.sessions = msg.sessions;
      renderSessions();
      syncOpenSession();
    } else if (msg.type === 'error') {
      toast(msg.message, true);
    }
  };
  ws.onclose = () => {
    // Only reconnect while the chat is still on screen.
    if (!state.session || !$('screen-chat').classList.contains('is-active')) return;
    setTimeout(() => connectWs(session), state.wsBackoff);
    state.wsBackoff = Math.min(state.wsBackoff * 2, 15_000);
  };
}

/* ---------- composing ---------- */

const compose = $('compose');

function autogrow() {
  compose.style.height = 'auto';
  compose.style.height = `${Math.min(compose.scrollHeight, window.innerHeight * 0.34)}px`;
  $('btn-send').disabled = compose.value.trim().length === 0;
}

compose.addEventListener('input', autogrow);

async function sendMessage() {
  const text = compose.value;
  if (!text.trim() || !state.session) return;
  const btn = $('btn-send');
  btn.disabled = true;
  try {
    await api(
      `/api/servers/${state.session.serverId}/sessions/${state.session.uuid}/send`,
      { method: 'POST', body: JSON.stringify({ text }) },
    );
    compose.value = '';
    autogrow();
  } catch (err) {
    if (err.code === 'pane-not-claude') {
      setNotice(
        'This session has exited — the pane is back at a shell, so nothing was sent.',
        true,
      );
    }
    toast(err.message, true);
    btn.disabled = false;
  }
}

$('btn-send').addEventListener('click', sendMessage);

/* ---------- copy ---------- */

/**
 * Copy text to the clipboard.
 *
 * `navigator.clipboard` only exists in a secure context, and this app is served over
 * plain HTTP on a private address — so on the very deployment it is built for, the
 * modern API is simply absent. The deprecated execCommand path is the one that
 * actually runs; without it every copy button would silently do nothing.
 */
async function copyText(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied or unavailable — fall through rather than give up.
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // Off-screen but focusable: execCommand ignores a hidden or detached element.
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * One delegated listener for every copy affordance in the thread, so markdown.js
 * stays a pure renderer and re-rendered messages need no rebinding.
 */
$('thread').addEventListener('click', async (e) => {
  const button = e.target.closest?.('[data-copy="block"]');
  if (button) {
    const pre = button.parentElement?.querySelector('pre');
    const ok = await copyText(pre?.textContent ?? '');
    button.textContent = ok ? 'copied' : 'failed';
    setTimeout(() => { button.textContent = 'copy'; }, 1600);
    return;
  }

  const inline = e.target.closest?.('code[data-copy="inline"]');
  // Not when it is part of a link: the tap belongs to the link.
  if (inline && !inline.closest('a')) {
    const ok = await copyText(inline.textContent ?? '');
    toast(ok ? 'Copied' : 'Could not copy', !ok);
    inline.classList.add('is-copied');
    setTimeout(() => inline.classList.remove('is-copied'), 600);
  }
});

/* ---------- screenshots ---------- */

const IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * Upload an image and let the hub type its path into the pane, which is how Claude
 * Code is handed a picture. Raw bytes with a declared type, not multipart: one file,
 * no other fields.
 */
async function sendImage(file) {
  if (!state.session) return;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  // The browser's own file.type is trusted only as a fallback; the hub verifies the
  // bytes either way and refuses a mismatch.
  const type = IMAGE_TYPES[ext] || file.type;
  if (!Object.values(IMAGE_TYPES).includes(type)) {
    toast('Only PNG, JPEG and WebP can be sent.', true);
    return;
  }

  const btn = $('btn-image');
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const caption = compose.value.trim();
    const { serverId, uuid } = state.session;
    await api(
      `/api/servers/${serverId}/sessions/${uuid}/upload` +
        (caption ? `?caption=${encodeURIComponent(caption)}` : ''),
      { method: 'POST', headers: { 'Content-Type': type }, body: file },
    );
    compose.value = '';
    autogrow();
    toast('Screenshot sent');
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '🖼';
  }
}

$('btn-image').addEventListener('click', () => $('pick-image').click());
$('pick-image').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  // Cleared so picking the same file twice still fires a change event.
  e.target.value = '';
  if (file) void sendImage(file);
});

for (const key of document.querySelectorAll('.key[data-key]')) {
  key.addEventListener('click', async () => {
    if (!state.session) return;
    try {
      await api(
        `/api/servers/${state.session.serverId}/sessions/${state.session.uuid}/key`,
        { method: 'POST', body: JSON.stringify({ key: key.dataset.key }) },
      );
    } catch (err) {
      toast(err.message, true);
    }
  });
}

$('btn-peek').addEventListener('click', async () => {
  if (!state.session) return;
  try {
    const data = await api(
      `/api/servers/${state.session.serverId}/sessions/${state.session.uuid}/peek`,
    );
    const host = $('chat-notice');
    const el = document.createElement('div');
    el.className = 'notice';
    const pre = document.createElement('div');
    pre.style.cssText =
      'font-family:var(--mono);font-size:10.5px;white-space:pre;overflow:auto;max-height:40vh;color:var(--muted)';
    pre.textContent = data.text;
    const close = document.createElement('button');
    close.textContent = 'hide screen';
    close.addEventListener('click', () => setNotice(''));
    el.append(pre, close);
    host.replaceChildren(el);
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------- correcting the conversation match ---------- */

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function candidateRow(c) {
  const btn = document.createElement('button');
  btn.className = 'dir';
  btn.type = 'button';

  const name = document.createElement('span');
  name.className = 'dir-name';
  name.textContent = c.title ?? c.uuid.slice(0, 8);

  const meta = document.createElement('span');
  meta.className = 'dir-path';
  const current = state.session && c.uuid === state.session.uuid ? ' · shown now' : '';
  meta.textContent =
    `${c.uuid.slice(0, 8)} · ${fmtSize(c.size)} · ${fmtWhen(c.lastActivity)}${current}`;

  btn.append(name, meta);
  if (c.lastMessage) {
    const preview = document.createElement('span');
    preview.className = 'dir-path';
    preview.textContent = c.lastMessage;
    btn.append(preview);
  }
  btn.addEventListener('click', () => bindTo(c.uuid));
  return btn;
}

async function openPicker() {
  if (!state.session) return;
  const sheet = $('pick-sheet');
  sheet.classList.add('is-open');
  const list = $('pick-list');
  list.innerHTML = '<div class="empty">Reading transcripts…</div>';
  try {
    const data = await api(
      `/api/servers/${state.session.serverId}/candidates` +
        `?pane=${encodeURIComponent(state.session.paneId)}`,
    );
    if (data.candidates.length === 0) {
      list.innerHTML = '<div class="empty">No transcripts in this project yet.</div>';
      return;
    }
    list.replaceChildren(...data.candidates.map(candidateRow));
  } catch (err) {
    list.innerHTML = '<div class="empty">Could not read the transcripts.</div>';
    toast(err.message, true);
  }
}

async function bindTo(transcriptUuid) {
  if (!state.session) return;
  $('pick-sheet').classList.remove('is-open');
  const { serverId, paneId } = state.session;
  try {
    await api(`/api/servers/${serverId}/bind`, {
      method: 'POST',
      body: JSON.stringify({ pane: paneId, transcriptUuid }),
    });
    await refreshSessions(true);
    const session = state.sessions.find((s) => s.uuid === transcriptUuid);
    if (session) openChat(session);
    else toast('Pinned, but that session is not listed as running.', true);
  } catch (err) {
    toast(err.message, true);
  }
}

$('btn-pick').addEventListener('click', openPicker);
$('btn-pick-close').addEventListener('click', () => $('pick-sheet').classList.remove('is-open'));
$('pick-sheet').addEventListener('click', (e) => {
  if (e.target === $('pick-sheet')) $('pick-sheet').classList.remove('is-open');
});

/* ---------- session info ---------- */

function fmtTokens(n) {
  if (typeof n !== 'number') return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

function fmtDuration(seconds) {
  if (typeof seconds !== 'number') return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}

function fmtStamp(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const two = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
    `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** label/value pairs, built as nodes — none of this text is trusted markup. */
function infoRows(rows) {
  const frag = document.createDocumentFragment();
  for (const [label, value] of rows) {
    if (value === null || value === undefined) continue;
    const row = document.createElement('div');
    row.className = 'info-row';
    const k = document.createElement('span');
    k.className = 'info-key';
    k.textContent = label;
    const v = document.createElement('span');
    v.className = 'info-val';
    v.textContent = value;
    row.append(k, v);
    frag.append(row);
  }
  return frag;
}

async function openInfo() {
  if (!state.session) return;
  const session = state.session;
  const sheet = $('info-sheet');
  sheet.classList.add('is-open');
  $('info-title').textContent = session.title;
  const body = $('info-body');
  body.innerHTML = '<div class="empty">Reading…</div>';

  try {
    const d = await api(
      `/api/servers/${session.serverId}/sessions/${session.uuid}/info`,
    );
    body.replaceChildren();

    // The status line is the running session's own render — cost and rate-limit
    // windows exist nowhere else — so it is shown verbatim, scrolled not wrapped.
    if (d.statusLine && d.statusLine.length > 0) {
      const box = document.createElement('pre');
      box.className = 'info-status';
      box.textContent = d.statusLine.join('\n');
      const cap = document.createElement('div');
      cap.className = 'meta info-cap';
      cap.textContent = 'status line, as shown in the pane';
      body.append(box, cap);
    }

    const turns = d.turns || {};
    body.append(infoRows([
      ['model', [d.model || '—', d.effort].filter(Boolean).join(' · ')],
      ['context', `${fmtTokens(d.contextTokens)} tokens`],
      ['directory', session.cwd],
      ['branch', d.gitBranch],
      ['turns', `${turns.user ?? 0} you · ${turns.assistant ?? 0} claude · ${turns.tools ?? 0} tools`],
      ['started', fmtStamp(d.startedAt)],
      ['pane up', fmtDuration(d.uptimeSeconds)],
      ['last active', fmtWhen(session.lastActivity)],
    ]));

    const rule = document.createElement('div');
    rule.className = 'info-rule';
    body.append(rule);

    body.append(infoRows([
      ['pane', `${session.paneId} · tmux ${session.tmuxSession}`],
      ['pid', session.pid ? String(session.pid) : null],
      ['server', session.serverId],
      ['match', session.confidence],
      ['transcript', session.transcript
        ? `${session.uuid.slice(0, 8)} · ${fmtSize(d.transcriptBytes || 0)}`
        : 'none yet'],
      ['claude code', d.version ? `v${d.version}` : null],
      ['permissions', session.skipPermissions ? 'skipped (--dangerously-skip-permissions)' : null],
    ]));
  } catch (err) {
    body.innerHTML = '<div class="empty">Could not read this session.</div>';
    toast(err.message, true);
  }
}

$('btn-info').addEventListener('click', openInfo);
$('btn-info-close').addEventListener('click', () => $('info-sheet').classList.remove('is-open'));
$('info-sheet').addEventListener('click', (e) => {
  if (e.target === $('info-sheet')) $('info-sheet').classList.remove('is-open');
});

/* ---------- new session ---------- */

async function openSheet() {
  $('sheet').classList.add('is-open');
  showBrowser(false);
  const list = $('dir-list');
  list.innerHTML = '<div class="empty">Looking for repos…</div>';
  try {
    const data = await api(`/api/servers/${state.serverId}/dirs`);
    if (data.dirs.length === 0) {
      // Name the paths that were actually searched. "Set CC_REPO_ROOTS" alone is
      // unhelpful precisely when you are new and have not set it.
      const where = (data.roots ?? []).join(', ') || 'nowhere';
      list.replaceChildren(mk('div', 'empty', [
        mk('strong', '', ['No git repos found']),
        document.createTextNode(`Looked in ${where}. Browse to any folder below, `),
        document.createTextNode('or set CC_REPO_ROOTS on the server.'),
      ]));
      return;
    }
    list.replaceChildren(
      ...data.dirs.map((dir) => {
        const btn = document.createElement('button');
        btn.className = 'dir';
        btn.type = 'button';
        const name = document.createElement('span');
        name.className = 'dir-name';
        name.textContent = repoOf(dir);
        const path = document.createElement('span');
        path.className = 'dir-path';
        path.textContent = dir;
        btn.append(name, path);
        btn.addEventListener('click', () => startSession(dir));
        return btn;
      }),
    );
  } catch (err) {
    list.innerHTML = '<div class="empty">Could not list repos.</div>';
    toast(err.message, true);
  }
}

async function startSession(dir) {
  $('sheet').classList.remove('is-open');
  toast(`Starting Claude in ${repoOf(dir)}…`);
  try {
    const created = await api(`/api/servers/${state.serverId}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ dir, skipPermissions: $('skip-perms').checked }),
    });
    await refreshSessions(true);
    const session = state.sessions.find((s) => s.uuid === created.uuid);
    if (session) openChat(session);
    else toast('Session started, but it has not written a transcript yet.', true);
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------- folder browser ---------- */

/*
 * One directory level at a time, not a tree.
 *
 * A tree rooted at the home directory means node_modules, .cache and .nvm — tens of
 * thousands of entries, slow to read and impossible to scan on a phone. Breadcrumb
 * plus children is what every file picker does, because it stays the same size no
 * matter what it is pointed at. It also needs nothing installed on the server.
 */

function showBrowser(on) {
  $('browse').hidden = !on;
  $('dir-list').hidden = on;
  $('btn-browse').hidden = on;
}

async function openBrowse(path = '~') {
  showBrowser(true);
  const list = $('browse-list');
  list.replaceChildren(mk('div', 'empty', ['Reading…']));
  try {
    const data = await api(
      `/api/servers/${state.serverId}/browse?path=${encodeURIComponent(path)}`,
    );
    state.browsePath = data.path;
    renderCrumbs(data);
    renderBrowseEntries(data);
  } catch (err) {
    list.replaceChildren(mk('div', 'empty', [err.message]));
  }
}

function renderCrumbs(data) {
  const crumbs = $('crumbs');
  crumbs.replaceChildren();
  // Only the tail is kept: a deep path would otherwise push the useful end of the
  // breadcrumb off screen, and the last few segments are what orient you.
  const shown = data.crumbs.slice(-4);
  if (shown.length < data.crumbs.length) crumbs.append(mk('span', 'crumb-sep', ['…']));
  shown.forEach((c, i) => {
    if (i > 0) crumbs.append(mk('span', 'crumb-sep', ['/']));
    const b = mk('button', 'crumb', [c.name]);
    b.type = 'button';
    b.addEventListener('click', () => openBrowse(c.path));
    crumbs.append(b);
  });
}

function renderBrowseEntries(data) {
  const list = $('browse-list');
  const rows = [];

  if (data.parent) {
    const up = mk('button', 'dir dir-up', [mk('span', 'dir-name', ['↑  ..'])]);
    up.type = 'button';
    up.addEventListener('click', () => openBrowse(data.parent));
    rows.push(up);
  }

  for (const entry of data.entries) {
    const row = mk('button', `dir${entry.isRepo ? ' is-repo' : ''}`, [
      mk('span', 'dir-name', [entry.name]),
      entry.isRepo ? mk('span', 'repo-badge', ['repo']) : mk('span', 'dir-path', ['folder']),
    ]);
    row.type = 'button';
    // Tapping descends. Starting a session is always the explicit "Start here"
    // button, so a mistap navigates rather than launching Claude somewhere odd.
    row.addEventListener('click', () => openBrowse(entry.path));
    rows.push(row);
  }

  if (rows.length === 0 || (rows.length === 1 && data.parent)) {
    rows.push(mk('div', 'empty', [
      data.hiddenCount > 0
        ? `No visible folders here (${data.hiddenCount} hidden). You can still start a session in it.`
        : 'No folders here. You can still start a session in it.',
    ]));
  }
  list.replaceChildren(...rows);
  $('btn-start-here').textContent = `Start in ${repoOf(data.path)}`;
}

/** Inline input rather than prompt(), which is ugly and can be blocked in a PWA. */
function promptNewFolder() {
  const input = mk('input', 'mkdir-input');
  input.type = 'text';
  input.placeholder = 'folder name';
  input.autocapitalize = 'none';
  input.autocorrect = 'off';

  const submit = async () => {
    const name = input.value.trim();
    if (!name) return row.remove();
    try {
      const made = await api(`/api/servers/${state.serverId}/mkdir`, {
        method: 'POST',
        body: JSON.stringify({ parent: state.browsePath, name }),
      });
      toast(`Created ${repoOf(made.path)}`);
      await openBrowse(made.path);
    } catch (err) {
      toast(err.message, true);
      input.focus();
    }
  };

  const ok = mk('button', 'ghost', ['Create']);
  ok.type = 'button';
  ok.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
    if (e.key === 'Escape') row.remove();
  });

  const row = mk('div', 'mkdir-row', [input, ok]);
  $('browse-list').prepend(row);
  input.focus();
}

// Home is the entry point: the quick list already covers configured roots, so
// browsing is for everything else.
$('btn-browse').addEventListener('click', () => openBrowse('~'));
$('btn-mkdir').addEventListener('click', promptNewFolder);
$('btn-start-here').addEventListener('click', () => {
  if (state.browsePath) startSession(state.browsePath);
});

$('btn-new').addEventListener('click', openSheet);
$('btn-sheet-close').addEventListener('click', () => $('sheet').classList.remove('is-open'));
$('sheet').addEventListener('click', (e) => {
  if (e.target === $('sheet')) $('sheet').classList.remove('is-open');
});

$('btn-back').addEventListener('click', () => {
  closeWs();
  state.session = null;
  show('list');
  refreshSessions();
});

$('btn-refresh').addEventListener('click', () => refreshSessions(true));

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshSessions(true);
});

/* ---------- boot ---------- */

async function boot() {
  const conn = activeConn();
  if (!conn) {
    await showLogin();
    return;
  }
  $('server-label').textContent = conn.label ?? conn.host;
  show('list');
  renderSessions();
  try {
    const data = await api('/api/servers');
    const first = data.servers[0];
    if (!first) {
      $('server-label').textContent = 'no servers configured';
      return;
    }
    state.serverId = first.id;
    $('server-label').textContent = first.label;
    await refreshSessions(true);
    setInterval(() => {
      if (document.visibilityState === 'visible' && !state.session) refreshSessions();
    }, 8_000);
  } catch (err) {
    if (err.status === 401) {
      // A revoked or expired session: ask for the password again.
      forgetActive();
      await routeStart();
      return;
    }
    $('server-label').textContent = 'not connected';
    toast(err.message, true);
  }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // Offline shell is a nicety; the app works without it.
  });
}

initTheme();
routeStart();
