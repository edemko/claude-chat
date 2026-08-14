import {
  HELP_SECTIONS,
  SOURCE_LABEL,
  filterCommands,
  leadingCommand,
  parseSlash,
  rankCommands,
} from './commands.js';
import { renderMarkdown } from './markdown.js';

const $ = (id) => document.getElementById(id);

const state = {
  connections: [],
  activeId: null,
  serverId: null,
  sessions: [],
  session: null,
  /** Remote home directory, for showing `~/Dev/x` rather than `/home/you/Dev/x`. */
  home: null,
  /** Sessions per agent, for the filter chips' counts. */
  counts: {},
  /** null shows every agent; otherwise narrow to this one. A filter, not a mode. */
  providerFilter: null,
  /** Agents the active server reports it can actually run. */
  providers: [],
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

/**
 * What to call a server.
 *
 * Three names can exist for one connection and they are not equal in authority:
 *
 *   1. a name the user typed — always wins
 *   2. `hubLabel`, what the hub calls itself, learned on the first successful boot
 *      and cached so the drawer can show it before any request is made
 *   3. the address, which is a fallback and not a name
 *
 * The label assigned automatically at first sign-in *is* the address, so a label
 * equal to `host` counts as unnamed rather than as a choice. Without this the drawer
 * showed `100.75.240.46` while the header, reading the hub's own label, said `sam`.
 */
function connName(conn) {
  if (!conn) return '';
  if (conn.label && conn.label !== conn.host) return conn.label;
  return conn.hubLabel ?? conn.host;
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
  if (at >= 0) {
    const existing = list[at];
    // Signing in again refreshes the token, not the name. Without this, a server the
    // user renamed reverted to its bare address the next time the token expired.
    const keepName = conn.label === undefined || conn.label === conn.host;
    list[at] = { ...existing, ...conn, label: keepName ? existing.label : conn.label };
  } else {
    list.push(conn);
  }
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

/* ---------- providers ---------- */

const PROVIDER_LABEL = { claude: 'claude', codex: 'codex' };

/**
 * The sessions to show: everything, or one agent's.
 *
 * A filter rather than a mode, and that distinction is the whole design. The agent is
 * a property of the pane — one machine runs both at once, and the same repo can have
 * one of each — so a mode that hid the others would let a notification arrive for a
 * session the interface is pretending does not exist.
 */
function visibleSessions() {
  const filter = state.providerFilter;
  if (!filter) return state.sessions;
  return state.sessions.filter((s) => s.provider === filter);
}

function providerBadge(provider) {
  return mk('span', `prov is-${provider}`, [PROVIDER_LABEL[provider] ?? provider]);
}

/*
 * Fixed chip order.
 *
 * `counts` is built by walking the session list, which is sorted by activity — so
 * `Object.keys` order changes whenever a different agent was last to speak, and the
 * chips swapped places between two polls. Same reason the favourites bar keeps the
 * drawer's order: a control that moves under your thumb is worse than one that is
 * occasionally in an odd order.
 */
const PROVIDER_ORDER = ['claude', 'codex'];

function renderProviderBar() {
  const bar = $('prov-bar');
  const counts = state.counts ?? {};
  const kinds = [
    ...PROVIDER_ORDER.filter((k) => counts[k] > 0),
    // Anything a newer hub reports that this build has never heard of still shows.
    ...Object.keys(counts).filter((k) => counts[k] > 0 && !PROVIDER_ORDER.includes(k)).sort(),
  ];

  // One agent means nothing to filter, so the row is not drawn at all.
  if (kinds.length < 2) {
    bar.hidden = true;
    bar.replaceChildren();
    // A filter left over from another server would silently hide everything.
    if (state.providerFilter && !kinds.includes(state.providerFilter)) {
      state.providerFilter = null;
    }
    return;
  }

  const total = kinds.reduce((sum, k) => sum + counts[k], 0);
  const chip = (label, count, value) => {
    const on = state.providerFilter === value;
    const el = mk('button', `pchip${on ? ' is-on' : ''}`, [
      label,
      mk('span', 'n', [String(count)]),
    ]);
    el.type = 'button';
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
    el.addEventListener('click', () => {
      // Tapping the active chip clears the filter, so there is always a way back to
      // everything without hunting for an "all" button.
      state.providerFilter = on ? null : value;
      renderProviderBar();
      renderSessions();
    });
    return el;
  };

  bar.replaceChildren(
    chip('All', total, null),
    ...kinds.map((k) => chip(PROVIDER_LABEL[k] ?? k, counts[k], k)),
  );
  bar.hidden = false;
}

/** `/home/you/Dev/x` -> `~/Dev/x`, once the hub has told us where home is. */
function tildify(path) {
  const home = state.home;
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

/**
 * A path short enough for a sidebar row.
 *
 * Truncated from the front, keeping the last few segments: CSS can only ellipsise the
 * tail, which is the half that tells you which project this is.
 */
function shortPath(path) {
  const shown = tildify(path);
  const parts = shown.split('/');
  return parts.length <= 4 ? shown : `…/${parts.slice(-3).join('/')}`;
}

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

/**
 * Mark a button as working.
 *
 * Disabled alone reads as "the tap did nothing", and the honest response to that is
 * to tap again — which for a sign-in means a second request against a lockout
 * counter. The spinner is CSS; this only toggles the class and the disabled state
 * together so the two cannot drift apart.
 */
function setBusy(button, busy) {
  button.classList.toggle('is-busy', busy);
  button.disabled = busy;
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
  // On a wide screen the list and the chat sit side by side. Sign-in owns the whole
  // window, so the split only starts once there is something to be beside.
  document.body.classList.toggle('is-split', which !== 'login');
}

/** The chat half has nothing to show until a session is picked. */
function markSession() {
  document.body.classList.toggle('no-session', !state.session);
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
  markSession();
  renderFavourites();
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

  setBusy(button, true);
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
    setBusy(button, false);
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

/**
 * Cheap per-server probe for the drawer: reachable, who we are, and what it calls
 * itself. Both requests together, since one round trip's latency covers both and the
 * name is only learnable by asking — a favourite you have never opened would
 * otherwise sit in the quick-switch bar as a bare address forever.
 */
async function probeConn(conn) {
  const get = (path) =>
    fetch(`${connOrigin(conn)}${path}`, {
      headers: { authorization: `Bearer ${conn.token}` },
      signal: AbortSignal.timeout(6000),
    });
  try {
    const [meRes, srvRes] = await Promise.all([get('/api/me'), get('/api/servers')]);
    if (meRes.status === 401) return { state: 'unauthorised' };
    if (!meRes.ok) return { state: 'error' };
    const me = await meRes.json();
    // The name is a nicety; a failure here must not make a reachable server look down.
    const hubLabel = srvRes.ok
      ? (await srvRes.json().catch(() => null))?.servers?.[0]?.label ?? null
      : null;
    return { state: 'ok', username: me.username, hubLabel };
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
  name.textContent = connName(conn);

  const meta = document.createElement('div');
  meta.className = 'conn-meta meta';
  meta.textContent = `${conn.host}:${conn.port} · checking…`;

  pick.append(name, meta);
  pick.addEventListener('click', () => selectConn(conn.id));

  const star = document.createElement('button');
  star.type = 'button';
  star.className = `conn-star${conn.fav ? ' is-on' : ''}`;
  star.setAttribute('aria-pressed', conn.fav ? 'true' : 'false');
  star.setAttribute(
    'aria-label',
    conn.fav ? `Unstar ${connName(conn)}` : `Star ${connName(conn)}`,
  );
  star.title = conn.fav ? 'Starred — shown in the quick-switch bar' : 'Star for quick switching';
  star.innerHTML = STAR_SVG;
  star.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFav(conn.id);
  });

  const rename = document.createElement('button');
  rename.type = 'button';
  rename.className = 'conn-edit';
  rename.setAttribute('aria-label', `Rename ${connName(conn)}`);
  rename.title = 'Rename';
  rename.innerHTML =
    '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M4 20h4l10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5V20z"/>' +
    '<path d="M13.5 6.5L17.5 10.5"/></svg>';
  rename.addEventListener('click', (e) => {
    e.stopPropagation();
    openRename(conn.id);
  });

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'conn-remove';
  remove.textContent = '✕';
  remove.setAttribute('aria-label', `Remove ${connName(conn)}`);
  remove.addEventListener('click', (e) => {
    e.stopPropagation();
    removeConn(conn.id);
  });

  // Grouped, so the row's 11 px gap is spent once rather than three times — with the
  // buttons as direct children the body lost ~50 px and the address wrapped, which
  // made rows different heights depending on how long an address was.
  row.append(pick, mk('div', 'conn-actions', [star, rename, remove]));

  // Fire-and-forget: the row renders immediately and fills in its status.
  void probeConn(conn).then((r) => {
    if (r.hubLabel && r.hubLabel !== conn.hubLabel) {
      saveConnections(
        state.connections.map((c) => (c.id === conn.id ? { ...c, hubLabel: r.hubLabel } : c)),
      );
      // Only where no name was chosen — a rename must not be undone by a probe.
      if (!conn.label || conn.label === conn.host) name.textContent = r.hubLabel;
      renderFavourites();
    }
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

/*
 * One path, reused at three sizes: the drawer's toggle, the quick-switch chips, and
 * the empty-state hint. `fill` is set by CSS, so the same markup is an outline or a
 * solid star depending only on whether it is starred.
 */
const STAR_SVG =
  '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M12 3.6l2.6 5.3 5.9.85-4.25 4.15 1 5.85L12 17l-5.25 2.75 1-5.85L3.5 9.75l5.9-.85z"/>' +
  '</svg>';

/**
 * Starred servers, in the order they appear in the drawer.
 *
 * Deliberately the same order as the list you starred them from — a bar that sorted
 * itself would move a chip out from under your thumb between one tap and the next.
 */
function favourites() {
  return state.connections.filter((c) => c.fav);
}

function toggleFav(id) {
  const conn = state.connections.find((c) => c.id === id);
  if (!conn) return;
  const on = !conn.fav;
  saveConnections(
    // `fav: undefined` rather than `false`: nothing reads it as a tri-state, and it
    // keeps stored connections from accumulating dead keys.
    state.connections.map((c) => (c.id === id ? { ...c, fav: on || undefined } : c)),
  );
  renderConnections();
  renderFavourites();
  toast(on ? `${connName(conn)} starred` : `${connName(conn)} unstarred`);
}

function favChip(conn) {
  const active = conn.id === state.activeId;
  const chip = mk('button', `fav${active ? ' is-on' : ''}`, []);
  chip.type = 'button';
  chip.innerHTML = STAR_SVG;
  chip.append(mk('span', 'fav-name', [connName(conn)]));
  chip.setAttribute('aria-current', active ? 'true' : 'false');
  // Tapping the server you are already on would otherwise tear the list down and
  // rebuild it identically, animation and all.
  if (!active) chip.addEventListener('click', () => selectConn(conn.id));
  return chip;
}

function renderFavourites() {
  const bar = $('fav-bar');
  const favs = favourites();
  bar.hidden = favs.length === 0;
  bar.replaceChildren(...favs.map(favChip));
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

/*
 * Slide the session list aside, swap servers, slide the new one in.
 *
 * Direction comes from the servers' position in the list, so moving to one further
 * down slides left — the same spatial logic as the quick-switch bar it is usually
 * driven from. The Web Animations API rather than classes and `animationend`: the
 * promise makes "swap the content at the midpoint" a straight `await`, with no
 * listener to leak if the switch is abandoned halfway.
 */
const SWITCH_OUT_MS = 130;
const SWITCH_IN_MS = 190;

async function slideSwitch(direction, swap) {
  const list = $('session-list');
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    await swap();
    return;
  }
  await list.animate(
    [
      { transform: 'none', opacity: 1 },
      { transform: `translateX(${-100 * direction}%)`, opacity: 0 },
    ],
    { duration: SWITCH_OUT_MS, easing: 'ease-in' },
  ).finished;

  await swap();

  list.animate(
    [
      { transform: `translateX(${100 * direction}%)`, opacity: 0 },
      { transform: 'none', opacity: 1 },
    ],
    { duration: SWITCH_IN_MS, easing: 'ease-out' },
  );
}

/** Switch servers: drop all per-server state, then boot against the new one. */
async function selectConn(id) {
  if (id === state.activeId) {
    // Already here. Still close the drawer, since that is what the tap asked for.
    closeDrawer();
    show('list');
    return;
  }

  const from = state.connections.findIndex((c) => c.id === state.activeId);
  const to = state.connections.findIndex((c) => c.id === id);
  const direction = from >= 0 && to >= 0 && to < from ? -1 : 1;

  closeDrawer();
  show('list');

  await slideSwitch(direction, async () => {
    setActive(id);
    closeWs();
    state.session = null;
    state.sessions = [];
    state.serverId = null;
    markSession();
    // Emptied before the incoming half of the animation, so what slides in is the new
    // server's list rather than the old one's rows retitled a moment later.
    renderSessions();
    renderFavourites();
  });

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
    markSession();
  }
  renderConnections();
  renderFavourites();
  toast(`Removed ${connName(conn)}`);
  if (!activeConn()) {
    closeDrawer();
    await routeStart();
  }
}

/**
 * Is this an address the hub could plausibly be listening on?
 *
 * The hub binds to **one** interface — by default the machine's Tailscale address —
 * so reaching a server at its public IP is not a firewall problem to work through,
 * it is simply the wrong address. Worth saying, because the generic "no answer"
 * message sends you to check Tailscale and the service, both of which are fine.
 *
 * A tailnet address is the 100.64.0.0/10 CGNAT range or a `*.ts.net` MagicDNS name.
 * Loopback and private LAN ranges are legitimate too, as is any hostname.
 */
function isPublicIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false; // a name, not an address — nothing to judge
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127 || a === 10) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // tailnet
  if (a === 192 && b === 168) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 169 && b === 254) return false;
  return true;
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

  setBusy(button, true);
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
    closeAddServer();
    error.textContent = '';
    await selectConn(`${host}:${port}`);
    toast(`Added ${label}`);
  } catch (err) {
    // A cross-origin failure and an unreachable host look the same to fetch, so the
    // message has to cover both without claiming to know which.
    const unreachable = err.name === 'TimeoutError' || err.message === 'Failed to fetch';
    error.textContent = !unreachable
      ? err.message
      : isPublicIPv4(host)
        ? `No answer from ${host}:${port}. That is a public address, and the hub `
          + `listens on one interface only — its Tailscale address. Try the machine's `
          + `100.x.y.z address, or its <name>.ts.net.`
        : `No answer from ${host}:${port}. Is Tailscale on, and the hub running?`;
  } finally {
    setBusy(button, false);
  }
}

/* ---------- naming a server ---------- */

/*
 * A server is remembered by address and shown by name. The hub that served the page
 * gets added automatically at first sign-in, and all it knows about itself then is
 * `100.75.240.46` — so the list reads as a row of addresses until you can name them.
 */
let renamingId = null;

function openRename(id) {
  const conn = state.connections.find((c) => c.id === id);
  if (!conn) return;
  // The drawer sits above sheets in the stack, so its scrim would dim this modal.
  closeDrawer();
  renamingId = id;
  // Only a name the user picked is prefilled. Seeding the box with the address, or
  // with the hub's own label, turns "give this a name" into "edit this text".
  $('name-input').value = conn.label && conn.label !== conn.host ? conn.label : '';
  $('name-input').placeholder = conn.hubLabel ?? 'e.g. sam';
  $('name-where').textContent = `${conn.host}:${conn.port}`;
  $('name-sheet').classList.add('is-open');
  $('name-input').focus();
  $('name-input').select();
}

function closeRename() {
  renamingId = null;
  $('name-sheet').classList.remove('is-open');
}

function saveRename(event) {
  event.preventDefault();
  const conn = state.connections.find((c) => c.id === renamingId);
  if (!conn) return closeRename();
  // Cleared means "no name" — fall back to the address rather than an empty row.
  const name = $('name-input').value.trim();
  saveConnections(
    state.connections.map((c) => (c.id === conn.id ? { ...c, label: name || undefined } : c)),
  );
  closeRename();
  renderFavourites();
  const active = activeConn();
  if (active) $('server-label').textContent = connName(active);
  // Back to the list you were editing, now showing the new name.
  openDrawer();
  toast(name ? `Renamed to ${name}` : 'Name cleared');
}

$('name-form').addEventListener('submit', saveRename);
$('btn-name-close').addEventListener('click', closeRename);
$('btn-name-cancel').addEventListener('click', closeRename);
$('name-sheet').addEventListener('click', (e) => {
  if (e.target === $('name-sheet')) closeRename();
});

function openAddServer() {
  closeDrawer();
  $('add-error').textContent = '';
  $('add-port').value = $('add-port').value || '7420';
  $('add-sheet').classList.add('is-open');
  $('add-host').focus();
}

function closeAddServer() {
  $('add-sheet').classList.remove('is-open');
}

$('btn-menu').addEventListener('click', openDrawer);
$('btn-drawer-close').addEventListener('click', closeDrawer);
$('drawer').addEventListener('click', (e) => {
  if (e.target === $('drawer')) closeDrawer();
});
$('btn-add-server').addEventListener('click', openAddServer);
// The same thing from the drawer's title bar, for when the list is long enough that
// the footer button is a scroll away.
$('btn-add-quick').addEventListener('click', openAddServer);
$('btn-add-close').addEventListener('click', closeAddServer);
$('btn-add-cancel').addEventListener('click', closeAddServer);
$('add-sheet').addEventListener('click', (e) => {
  if (e.target === $('add-sheet')) closeAddServer();
});
$('add-form').addEventListener('submit', addServer);

// Esc closes whichever modal is on top. A centred dialog with no visible edge to tap
// past needs a keyboard way out.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const id of ['name-sheet', 'add-sheet']) {
    if ($(id).classList.contains('is-open')) {
      $(id).classList.remove('is-open');
      if (id === 'name-sheet') renamingId = null;
      return;
    }
  }
});

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
  const current = state.session?.paneId === session.paneId;
  const btn = document.createElement('button');
  btn.className = `session${current ? ' is-current' : ''}`;
  btn.type = 'button';

  const bead = document.createElement('span');
  bead.className = `bead${session.status === 'working' ? ' is-working' : ''}`;

  const body = document.createElement('div');
  body.className = 'session-body';

  // The project is now the group heading above this row, so the title is just the
  // conversation. Names repeat across projects — two panes were once both called
  // "implementing MEGA bucket" — and the heading is what tells them apart.
  const title = document.createElement('div');
  title.className = 'session-title';
  title.textContent = session.title;

  // The agent, beside the name. Two sessions in one repo are routinely one of each.
  const titleRow = mk('div', 'session-title-row', [title, providerBadge(session.provider)]);

  const meta = document.createElement('div');
  meta.className = 'session-meta meta';
  const where = document.createElement('span');
  // "pane %20", never a bare "%20" — which reads as a percentage.
  where.textContent = `pane ${session.paneId}`;
  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = fmtWhen(session.lastActivity);
  meta.append(where, when);

  body.append(titleRow, meta);

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

/**
 * Sessions by the directory they run in.
 *
 * Work here is organised by project, not by conversation: several sessions in one
 * repo is normal, and the same conversation name in two repos is a different thing
 * entirely. Groups are ordered by their most recent activity, so whatever is live
 * stays at the top.
 */
function groupSessions(sessions) {
  const groups = new Map();
  for (const session of sessions) {
    let group = groups.get(session.cwd);
    if (!group) {
      group = {
        cwd: session.cwd,
        name: repoOf(session.cwd),
        isRepo: session.isRepo === true,
        sessions: [],
        last: 0,
      };
      groups.set(session.cwd, group);
    }
    group.sessions.push(session);
    group.last = Math.max(group.last, session.lastActivity ?? 0);
  }
  return [...groups.values()].sort((a, b) => b.last - a.last);
}

function projectGroup(group) {
  const head = mk('div', 'proj-head', [
    mk('span', 'proj-name', [group.name]),
    mk('span', 'proj-badge', [group.isRepo ? 'repo' : 'folder']),
    mk('span', 'proj-path meta', [shortPath(group.cwd)]),
  ]);
  return mk('div', `proj${group.isRepo ? ' is-repo' : ''}`, [
    head,
    ...group.sessions.map(sessionRow),
  ]);
}

function renderSessions() {
  const list = $('session-list');
  const shown = visibleSessions();

  if (shown.length === 0) {
    // Distinguish "nothing running" from "the filter is hiding it all" — the second
    // has an obvious fix and should say so rather than looking like an empty server.
    list.replaceChildren(
      state.sessions.length > 0 && state.providerFilter
        ? mk('div', 'empty', [
            mk('strong', '', [`No ${PROVIDER_LABEL[state.providerFilter]} sessions`]),
            `${state.sessions.length} running under another agent — tap All to see them.`,
          ])
        : mk('div', 'empty', [
            mk('strong', '', ['No sessions running']),
            'Tap ＋ to start an agent in one of your repos.',
          ]),
    );
    return;
  }
  list.replaceChildren(...groupSessions(shown).map(projectGroup));
}

async function refreshSessions(fresh = false) {
  if (!activeConn() || !state.serverId) return;
  try {
    const data = await api(
      `/api/servers/${state.serverId}/sessions${fresh ? '?fresh=1' : ''}`,
    );
    state.sessions = data.sessions;
    if (data.home) state.home = data.home;
    state.counts = data.counts ?? {};
    renderProviderBar();
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
  // Something arrived while reading back through the thread. Never yank the view
  // down — mark the button instead and let the reader decide.
  else if (events.length > 0) $('btn-bottom').classList.add('has-new');
  updateBottomButton();
}

/* ---------- jump to the latest message ---------- */

/** Far enough up that scrolling back by hand is a chore. */
const DETACHED_PX = 160;

function updateBottomButton() {
  const scroller = $('thread-scroll');
  const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  const away = gap > DETACHED_PX;
  const btn = $('btn-bottom');
  btn.hidden = !away;
  if (!away) btn.classList.remove('has-new');
}

$('btn-bottom').addEventListener('click', () => {
  const scroller = $('thread-scroll');
  scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
  $('btn-bottom').classList.remove('has-new');
});

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
  updateBottomButton();
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
    `${PROVIDER_LABEL[session.provider] ?? session.provider} · pane ${session.paneId} · ` +
    `${session.confidence === 'pending' ? 'no transcript yet' : session.uuid.slice(0, 8)}`;
  applyKeyBar(session.provider);
  $('chat-bead').className = `bead${session.status === 'working' ? ' is-working' : ''}`;
  // Only Claude Code produces a weak match; codex is exact or has no transcript yet.
  if (session.confidence === 'weak' && session.provider === 'claude') showGuessNotice();
  else setNotice('');
  show('chat');
  markSession();
  // Highlight the row this came from, which on a wide screen stays on screen.
  renderSessions();
  // This project's own commands, for the composer. Fire and forget: autocomplete
  // arriving a moment late is fine, blocking the thread on it is not.
  void loadCommands(session);

  try {
    const data = await api(
      `/api/servers/${session.serverId}/sessions/${session.uuid}/history?limit=${PAGE_SIZE}`,
    );
    state.cursor = data.cursor;
    state.hasMore = data.hasMore;
    addEvents(data.events);
    // Open at the newest message, the way a chat app should.
    $('thread-scroll').scrollTop = $('thread-scroll').scrollHeight;
    $('btn-bottom').classList.remove('has-new');
    updateBottomButton();
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
      if (msg.home) state.home = msg.home;
      state.counts = msg.counts ?? state.counts;
      renderProviderBar();
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
  const max = window.innerHeight * 0.34;
  compose.style.height = 'auto';
  const needed = compose.scrollHeight;
  compose.style.height = `${Math.min(needed, max)}px`;
  // Only allow scrolling once the field is actually clamped. Left on `auto`, the
  // textarea reserves a scrollbar gutter as soon as its content approaches its
  // height, so a one-line message showed a permanent track.
  compose.style.overflowY = needed > max ? 'auto' : 'hidden';
  $('btn-send').disabled = compose.value.trim().length === 0;
}

compose.addEventListener('input', () => {
  autogrow();
  updateComposer();
});
// A tap or an arrow key moves the caret without changing the text, and the menu
// belongs to where the caret is.
compose.addEventListener('click', updateComposer);
compose.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') return; // owned by the menu
  updateComposer();
});
// Deferred: tapping a suggestion blurs the box first on a touchscreen, and hiding the
// menu on that blur would pull the row out from under the finger before it lands.
compose.addEventListener('blur', () => setTimeout(closeCmdMenu, 150));
compose.addEventListener('scroll', () => {
  $('compose-mirror').scrollTop = compose.scrollTop;
}, { passive: true });

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
    updateComposer();
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

/* ---------- slash commands ---------- */

/*
 * What the session will accept as a command: Claude Code's built-ins, plus whatever
 * this machine and this project define in `.claude/commands` and `.claude/skills`.
 * The custom half is the reason this is fetched rather than hardcoded — a list of
 * built-ins is guessable, your own commands are not.
 */
const cmd = {
  list: [],
  /** Directory the list belongs to; a different project has different commands. */
  forCwd: null,
  matches: [],
  index: 0,
  open: false,
  /** Text the menu was dismissed for, so it stays shut until something is typed. */
  suppressed: null,
};

async function loadCommands(session) {
  // Keyed by provider too: the same directory has different commands under each
  // agent, and keying on the path alone showed Claude's list inside a Codex session.
  const key = `${session?.provider}:${session?.cwd}`;
  if (!session || cmd.forCwd === key) return;
  cmd.forCwd = key;
  cmd.list = [];
  try {
    const data = await api(
      `/api/servers/${session.serverId}/commands?cwd=${encodeURIComponent(session.cwd)}` +
        `&provider=${encodeURIComponent(session.provider)}`,
    );
    // A reply for a session we have since left must not become this one's catalogue.
    if (state.session?.cwd === session.cwd && state.session?.provider === session.provider) {
      cmd.list = data.commands;
      updateComposer();
    }
  } catch {
    // Autocomplete is a convenience. Clear the marker so the next open retries.
    cmd.forCwd = null;
  }
}

/** The catalogue for the help sheet, which may be open with no session in view. */
async function commandsForHelp() {
  if (cmd.list.length > 0) return cmd.list;
  if (!state.serverId) return [];
  const cwd = state.session?.cwd;
  const provider = state.session?.provider ?? state.providers[0] ?? 'claude';
  const query = new URLSearchParams({ provider });
  if (cwd) query.set('cwd', cwd);
  const data = await api(`/api/servers/${state.serverId}/commands?${query}`);
  return data.commands;
}

/**
 * Is this name going to be understood?
 *
 * A prefix of a real command counts as fine while the name is still being typed —
 * warning about `/comp` on the way to `/compact` would be nagging. Once arguments
 * follow, the name is settled and only an exact match will do. With no catalogue
 * loaded nothing is flagged: a false warning is worse than no warning.
 */
function commandKnown(name, settled) {
  if (cmd.list.length === 0) return true;
  if (cmd.list.some((c) => c.name === name)) return true;
  return !settled && cmd.list.some((c) => c.name.startsWith(name));
}

/** Where the leading `/name` token ends. */
function nameEnd(text) {
  const space = text.search(/\s/);
  return space < 0 ? text.length : space;
}

/** Paint the command name behind the textarea's own (transparent) text. */
function renderMirror(text) {
  const field = $('compose-field');
  const mirror = $('compose-mirror');
  const on = text.startsWith('/');
  field.classList.toggle('is-cmd', on);
  if (!on) {
    mirror.replaceChildren();
    return;
  }
  const end = nameEnd(text);
  const known = commandKnown(text.slice(1, end), end < text.length);
  mirror.replaceChildren(
    mk('span', `cmd-tok ${known ? 'is-known' : 'is-unknown'}`, [text.slice(0, end)]),
    document.createTextNode(text.slice(end)),
  );
  mirror.scrollTop = compose.scrollTop;
}

function renderCmdMenu() {
  const pop = $('cmd-pop');
  pop.replaceChildren(
    ...cmd.matches.map((c, i) => {
      const row = mk('button', `cmd-row${i === cmd.index ? ' is-on' : ''}`, [
        mk('span', 'cmd-row-name', [`/${c.name}`]),
        ...(c.argumentHint ? [mk('span', 'cmd-row-hint', [c.argumentHint])] : []),
        mk('span', 'cmd-row-desc', [c.description]),
        ...(c.source !== 'builtin' ? [mk('span', 'cmd-tag', [SOURCE_LABEL[c.source]])] : []),
      ]);
      row.type = 'button';
      // mousedown, not click: click lands after the textarea has already blurred,
      // which closes the menu out from under the tap.
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        applyCompletion(c);
      });
      return row;
    }),
  );
  pop.hidden = false;
}

function closeCmdMenu() {
  cmd.open = false;
  cmd.matches = [];
  $('cmd-pop').hidden = true;
}

function dismissCmdMenu() {
  cmd.suppressed = compose.value;
  closeCmdMenu();
  renderCmdHint(compose.value);
}

function moveCmdSelection(step) {
  if (cmd.matches.length === 0) return;
  cmd.index = (cmd.index + step + cmd.matches.length) % cmd.matches.length;
  renderCmdMenu();
  $('cmd-pop').children[cmd.index]?.scrollIntoView({ block: 'nearest' });
}

/** Replace the leading token with a chosen command, leaving room for its arguments. */
function applyCompletion(chosen) {
  const text = compose.value;
  const rest = text.slice(nameEnd(text));
  const tail = chosen.argumentHint && !rest.trim() ? ' ' : rest;
  compose.value = `/${chosen.name}${tail}`;
  const caret = chosen.name.length + 1 + (tail === ' ' ? 1 : 0);
  compose.setSelectionRange(caret, caret);
  compose.focus();
  autogrow();
  // Dismissed for this exact text: completing a name would otherwise reopen the menu
  // on the very command just picked.
  cmd.suppressed = compose.value;
  closeCmdMenu();
  renderMirror(compose.value);
  renderCmdHint(compose.value);
}

/** One line saying what the command about to be sent actually does. */
function renderCmdHint(text) {
  const hint = $('cmd-hint');
  const name = leadingCommand(text);
  // While the menu is open it says the same thing, with more detail.
  if (!name || cmd.open || cmd.list.length === 0) {
    hint.hidden = true;
    return;
  }
  const found = cmd.list.find((c) => c.name === name);
  const settled = /\s/.test(text);

  if (!found) {
    if (!settled) {
      hint.hidden = true;
      return;
    }
    hint.className = 'cmd-hint is-unknown';
    hint.replaceChildren(
      mk('span', 'name', [`/${name}`]),
      mk('span', 'what', ['not a command this session knows — it will be sent as text']),
    );
    hint.hidden = false;
    return;
  }

  hint.className = 'cmd-hint';
  hint.replaceChildren(
    mk('span', 'name', [`/${found.name}${found.argumentHint ? ` ${found.argumentHint}` : ''}`]),
    mk('span', 'what', [found.description]),
  );
  hint.hidden = false;
}

/** Recompute everything that depends on the text and the caret. */
function updateComposer() {
  const text = compose.value;
  const caret = compose.selectionStart ?? text.length;
  renderMirror(text);

  const slash = parseSlash(text, caret);
  if (!slash || cmd.suppressed === text || cmd.list.length === 0) {
    closeCmdMenu();
  } else {
    const matches = rankCommands(slash.query, cmd.list).slice(0, 40);
    if (matches.length === 0) {
      closeCmdMenu();
    } else {
      cmd.matches = matches;
      cmd.index = 0;
      cmd.open = true;
      cmd.suppressed = null;
      renderCmdMenu();
    }
  }
  renderCmdHint(text);
}

/** A physical keyboard is a desktop keyboard: Enter sends, Shift-Enter breaks a line. */
const wideScreen = () => window.matchMedia('(min-width: 900px)').matches;

compose.addEventListener('keydown', (e) => {
  if (cmd.open) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveCmdSelection(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveCmdSelection(-1);
      return;
    }
    if (e.key === 'Tab' || e.key === 'Enter') {
      const chosen = cmd.matches[cmd.index];
      if (chosen) {
        e.preventDefault();
        applyCompletion(chosen);
        return;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      dismissCmdMenu();
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && wideScreen()) {
    e.preventDefault();
    void sendMessage();
  }
});

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

/* ---------- drag, drop and paste ---------- */

/*
 * Dropping a screenshot straight onto the conversation.
 *
 * Two things make this fiddly. A drop anywhere the page has not claimed makes the
 * browser *navigate to the file*, losing the session — so the window-level handlers
 * cancel every drag regardless of where it lands. And dragenter/dragleave fire for
 * each element the pointer crosses, which flickers a naive overlay; a depth counter
 * is what makes it steady.
 */
let dragDepth = 0;

/** True only for an actual file drag — not text selection, not a dragged link. */
const isFileDrag = (e) =>
  Array.from(e.dataTransfer?.types ?? []).includes('Files');

function showDropVeil(on) {
  if (!on) dragDepth = 0;
  $('drop-veil').hidden = !on;
}

window.addEventListener('dragenter', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth += 1;
  if (state.session) showDropVeil(true);
});

window.addEventListener('dragover', (e) => {
  if (!isFileDrag(e)) return;
  // Required on every dragover, not just dragenter: without it the drop event never
  // fires and the browser opens the file instead.
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', (e) => {
  if (!isFileDrag(e)) return;
  dragDepth -= 1;
  if (dragDepth <= 0) showDropVeil(false);
});

window.addEventListener('drop', (e) => {
  if (!isFileDrag(e)) return;
  // Cancel even when there is nowhere to put it, so a stray drop cannot navigate.
  e.preventDefault();
  showDropVeil(false);
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  if (!state.session) {
    toast('Open a session first, then drop the image.', true);
    return;
  }
  void sendImage(file);
});

// Ctrl-V a screenshot. On a desktop this is how one arrives — straight off the
// clipboard, with no file on disk to pick from.
compose.addEventListener('paste', (e) => {
  const item = Array.from(e.clipboardData?.items ?? []).find(
    (i) => i.kind === 'file' && i.type.startsWith('image/'),
  );
  if (!item) return; // ordinary text paste
  const file = item.getAsFile();
  if (!file || !state.session) return;
  e.preventDefault();
  void sendImage(file);
});

/*
 * The composer-clearing key differs per agent, so the bar is relabelled rather than
 * sending the wrong one. `Escape` clears Claude Code's prompt; in Codex it leaves the
 * text alone and a stale line then prefixes whatever is sent next. The client sends
 * the logical name `clear` and the hub picks the binding.
 */
const CLEAR_LABEL = { claude: 'esc', codex: '^U' };

function applyKeyBar(provider) {
  const btn = document.querySelector('.key[data-key="clear"]');
  if (btn) {
    btn.textContent = CLEAR_LABEL[provider] ?? 'esc';
    btn.title =
      provider === 'codex'
        ? 'Ctrl-U — clears the composer (Escape does not, in Codex)'
        : 'Escape — clears the prompt or dismisses a menu';
  }

  /*
   * "conversation" corrects a guessed pane→transcript match, and only Claude Code
   * ever guesses — Codex names its own transcript on a file descriptor, so its match
   * is always exact. Left visible it was not merely useless: it calls an endpoint
   * that only knows how to inspect a Claude pane, so it would fail with an error
   * about the session not being a Claude one.
   */
  const pick = $('btn-pick');
  if (pick) pick.hidden = provider === 'codex';
}

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
    // A raw token count means little; against the window it is immediately readable.
    const context =
      d.contextTokens && d.contextWindow
        ? `${fmtTokens(d.contextTokens)} / ${fmtTokens(d.contextWindow)} · ` +
          `${Math.round((d.contextTokens / d.contextWindow) * 100)}%`
        : `${fmtTokens(d.contextTokens)} tokens`;
    body.append(infoRows([
      ['agent', PROVIDER_LABEL[session.provider] ?? session.provider],
      ['model', [d.model || '—', d.effort].filter(Boolean).join(' · ')],
      ['context', context],
      ['directory', session.cwd],
      ['branch', d.gitBranch],
      // Named after the agent, not hardcoded — this read "13 claude" inside a Codex
      // session, which is exactly the sort of detail that makes a UI feel bolted on.
      ['turns', `${turns.user ?? 0} you · ${turns.assistant ?? 0} ${PROVIDER_LABEL[session.provider] ?? 'agent'} · ${turns.tools ?? 0} tools`],
      ['started', fmtStamp(d.startedAt)],
      ['pane up', fmtDuration(d.uptimeSeconds)],
      ['last active', fmtWhen(session.lastActivity)],
    ]));

    const rule = document.createElement('div');
    rule.className = 'info-rule';
    body.append(rule);

    // Provider extras: Codex reports rate limits, sandbox policy and collaboration
    // mode as data. Claude Code computes the equivalent privately and shows it only
    // through the scraped status line above, so this block is simply empty there.
    if (Array.isArray(d.extra) && d.extra.length > 0) {
      body.append(infoRows(d.extra.map((e) => [e.label, e.value])));
      const rule = document.createElement('div');
      rule.className = 'info-rule';
      body.append(rule);
    }

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

/** Which agent ＋ will launch. Defaults to the first the server reports. */
let newProvider = null;

function renderNewProvider() {
  const host = $('new-prov');
  const list = state.providers ?? [];
  // Nothing to choose between: one agent, or a hub too old to report any.
  if (list.length < 2) {
    host.hidden = true;
    host.replaceChildren();
    newProvider = list[0] ?? null;
    return;
  }
  if (!list.includes(newProvider)) newProvider = list[0];
  host.replaceChildren(
    ...list.map((id) => {
      const btn = mk('button', newProvider === id ? 'is-on' : '', [
        PROVIDER_LABEL[id] ?? id,
      ]);
      btn.type = 'button';
      btn.setAttribute('aria-pressed', newProvider === id ? 'true' : 'false');
      btn.addEventListener('click', () => {
        newProvider = id;
        renderNewProvider();
        renderPermsLabel();
      });
      return btn;
    }),
  );
  host.hidden = false;
}

/** The bypass flag is named differently by each agent; say which one is meant. */
function renderPermsLabel() {
  const label = $('skip-perms-label');
  if (!label) return;
  label.textContent =
    newProvider === 'codex'
      ? 'Bypass approvals and sandbox — the session acts without asking'
      : 'Skip permission prompts — the session acts without asking';
}

async function openSheet() {
  $('sheet').classList.add('is-open');
  showBrowser(false);
  const list = $('dir-list');
  list.innerHTML = '<div class="empty">Looking for repos…</div>';
  try {
    const data = await api(`/api/servers/${state.serverId}/dirs`);
    state.providers = data.providers ?? [];
    renderNewProvider();
    renderPermsLabel();
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
  const which = newProvider ?? state.providers[0] ?? 'claude';
  toast(`Starting ${PROVIDER_LABEL[which] ?? which} in ${repoOf(dir)}…`);
  try {
    const created = await api(`/api/servers/${state.serverId}/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        dir,
        skipPermissions: $('skip-perms').checked,
        provider: which,
      }),
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
  markSession();
  show('list');
  refreshSessions();
});

/* ---------- help ---------- */

let helpTab = 'tips';

function helpItem(term, text, mono = false) {
  return mk('div', 'help-item', [
    mk('div', `help-term${mono ? ' mono' : ''}`, [term]),
    mk('div', 'help-text', [text]),
  ]);
}

function renderHelpTips() {
  const body = $('help-body');
  const parts = [];
  for (const section of HELP_SECTIONS) {
    parts.push(
      mk('div', 'help-sec', [
        mk('h3', '', [section.title]),
        ...section.items.map(([term, text]) =>
          helpItem(term, text, section.title === 'The key bar'),
        ),
      ]),
    );
  }
  // Enter only sends where there is a keyboard to press it on, so say so there.
  if (wideScreen()) {
    parts.push(
      mk('div', 'help-sec', [
        mk('h3', '', ['On this screen']),
        helpItem('Enter sends', 'Shift-Enter starts a new line. On a phone the ↑ button sends.'),
        helpItem(
          'The list stays open',
          'Sessions on the left, conversation on the right — no going back and forth.',
        ),
      ]),
    );
  }
  body.replaceChildren(...parts);
}

function commandGroup(title, commands, note) {
  if (commands.length === 0) return null;
  return mk('div', 'help-sec', [
    mk('h3', '', [`${title} · ${commands.length}`]),
    ...(note ? [mk('div', 'help-foot', [note])] : []),
    ...commands.map((c) =>
      helpItem(`/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''}`, c.description, true),
    ),
  ]);
}

async function renderHelpCommands(filter = '') {
  const body = $('help-body');
  let list;
  try {
    list = await commandsForHelp();
  } catch {
    body.replaceChildren(mk('div', 'empty', ['Could not read the commands from this server.']));
    return;
  }

  const shown = filterCommands(filter, list);
  if (shown.length === 0) {
    body.replaceChildren(mk('div', 'empty', ['Nothing matches that.']));
    return;
  }

  const by = (source) => shown.filter((c) => c.source === source);
  const groups = [
    commandGroup('This project', by('project')),
    commandGroup('Your commands', by('user')),
    commandGroup('Skills', by('skill')),
    commandGroup('Built in', by('builtin')),
  ].filter(Boolean);

  groups.push(
    mk('div', 'help-foot', [
      'Add your own by dropping a markdown file in ',
      mk('code', '', ['~/.claude/commands']),
      ' or ',
      mk('code', '', ['.claude/commands']),
      ' in the project. The filename is the command name, and a ',
      mk('code', '', ['description:']),
      ' line in its frontmatter is what shows up here.',
    ]),
  );
  body.replaceChildren(...groups);
}

function setHelpTab(tab) {
  helpTab = tab;
  for (const btn of document.querySelectorAll('.help-tab')) {
    btn.classList.toggle('is-on', btn.dataset.tab === tab);
  }
  $('help-filter').hidden = tab !== 'commands';
  if (tab === 'tips') renderHelpTips();
  else void renderHelpCommands($('help-filter').value);
}

function openHelp() {
  closeDrawer();
  $('help-sheet').classList.add('is-open');
  setHelpTab(helpTab);
}

$('btn-help').addEventListener('click', openHelp);
$('btn-help-close').addEventListener('click', () => $('help-sheet').classList.remove('is-open'));
$('help-sheet').addEventListener('click', (e) => {
  if (e.target === $('help-sheet')) $('help-sheet').classList.remove('is-open');
});
for (const btn of document.querySelectorAll('.help-tab')) {
  btn.addEventListener('click', () => setHelpTab(btn.dataset.tab));
}
$('help-filter').addEventListener('input', () => void renderHelpCommands($('help-filter').value));

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
  $('server-label').textContent = connName(conn);
  show('list');
  renderSessions();
  renderFavourites();
  try {
    const data = await api('/api/servers');
    const first = data.servers[0];
    if (!first) {
      $('server-label').textContent = 'no servers configured';
      return;
    }
    state.serverId = first.id;
    // Remember what the hub calls itself, so the drawer and the quick-switch chips can
    // show a name rather than an address without waiting on a request of their own.
    if (first.label && first.label !== conn.hubLabel) {
      saveConnections(
        state.connections.map((c) => (c.id === conn.id ? { ...c, hubLabel: first.label } : c)),
      );
      renderFavourites();
      if ($('drawer').classList.contains('is-open')) renderConnections();
    }
    $('server-label').textContent = connName(activeConn());
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
markSession();
updateComposer();
routeStart();
