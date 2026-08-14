/**
 * Look at the PWA, on a machine with no display.
 *
 *   node scripts/screenshot.mjs                          # 1280x860, session list
 *   node scripts/screenshot.mjs --size 420x880 --scene chat
 *   node scripts/screenshot.mjs --scene cmd --out /tmp/menu.png
 *
 * Headless Chrome driven over the DevTools protocol: navigate, click things, take a
 * picture, and print what the DOM actually measured. The measurements are the point —
 * a screenshot shows you something is wrong, `listW: 1113` tells you what.
 *
 * Chrome is found in the puppeteer cache (`~/.cache/puppeteer/chrome/*`) or via
 * $CHROME. No npm dependency: this speaks CDP directly over the `ws` the hub already
 * uses, so nothing is installed for a tool you run occasionally.
 *
 * Env: CC_URL (default http://127.0.0.1:7420), CC_TOKEN (default ~/.claude-chat/token).
 */
import { spawn } from 'node:child_process';
import { globSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import wsPkg from 'ws';

// `ws` exports the class as the module itself under CommonJS and as a named property
// under its ESM entry, and which one you get depends on how it resolved.
const WebSocket = wsPkg.WebSocket ?? wsPkg;

/* ---------- arguments ---------- */

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};

const [width, height] = arg('size', '1280x860').split('x').map(Number);
const scene = arg('scene', 'list');
// Every new surface consumes the palette, and the palette has three states. Forcing
// one is the only way to check the other without a system-wide setting.
const theme = arg('theme', null);
const out = arg('out', `claude-chat-${scene}.png`);
const port = Number(arg('port', '9412'));

const base = process.env.CC_URL ?? 'http://127.0.0.1:7420';
const token =
  process.env.CC_TOKEN ??
  readFileSync(join(homedir(), '.claude-chat', 'token'), 'utf8').trim();

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const patterns = [
    join(homedir(), '.cache/puppeteer/chrome/*/chrome-linux64/chrome'),
    join(homedir(), '.cache/puppeteer/chrome-headless-shell/*/*/chrome-headless-shell'),
  ];
  for (const pattern of patterns) {
    const hit = globSync(pattern)[0];
    if (hit) return hit;
  }
  throw new Error('no chrome found — set $CHROME');
}

/* ---------- CDP ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  findChrome(),
  [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--remote-debugging-port=${port}`,
    `--window-size=${width},${height}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function debuggerUrl() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Not listening yet.
    }
    await sleep(250);
  }
  throw new Error('chrome never opened its debugging port');
}

const socket = new WebSocket(await debuggerUrl());
await new Promise((resolve) => socket.once('open', resolve));

let nextId = 0;
const pending = new Map();
socket.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  const settle = pending.get(msg.id);
  if (settle) {
    pending.delete(msg.id);
    settle(msg);
  }
});

function send(method, params = {}) {
  nextId += 1;
  const id = nextId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const reply = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const failed = reply.result?.exceptionDetails;
  if (failed) throw new Error(failed.exception?.description ?? 'evaluate failed');
  return reply.result?.result?.value;
}

/** Type into the composer the way a person would, so every listener fires. */
const typeInto = (text, caret = text.length) => evaluate(`
  (() => {
    const c = document.getElementById('compose');
    c.focus();
    c.value = ${JSON.stringify(text)};
    c.setSelectionRange(${caret}, ${caret});
    c.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()
`);

const openFirstSession = async () => {
  await evaluate(`document.querySelector('.session')?.click() ?? null`);
  await sleep(2500);
};

const SCENES = {
  list: async () => {},
  chat: openFirstSession,
  cmd: async () => {
    await openFirstSession();
    await typeInto('/co');
  },
  hint: async () => {
    await openFirstSession();
    await typeInto('/compact everything before today');
  },
  unknown: async () => {
    await openFirstSession();
    await typeInto('/nosuchthing here');
  },
  drawer: async () => {
    await evaluate(`document.getElementById('btn-menu').click(); 'ok'`);
  },
  addserver: async () => {
    await evaluate(`document.getElementById('btn-menu').click();
                    document.getElementById('btn-add-quick').click(); 'ok'`);
  },
  rename: async () => {
    await evaluate(`document.getElementById('btn-menu').click(); 'ok'`);
    await sleep(300);
    await evaluate(`document.querySelector('.conn-edit').click(); 'ok'`);
  },
  drop: async () => {
    await openFirstSession();
    // A synthetic drag: what matters is that the veil is gated on a *file* drag and
    // that the depth counter leaves it steady, both of which are pure JS.
    await evaluate(`
      (() => {
        const dt = new DataTransfer();
        dt.items.add(new File(['x'], 'shot.png', { type: 'image/png' }));
        window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
        return 'ok';
      })()
    `);
  },
  longmsg: async () => {
    await openFirstSession();
    await typeInto('a single line, which must not show a scrollbar');
  },
  help: async () => {
    await evaluate(`document.getElementById('btn-menu').click();
                    document.getElementById('btn-help').click(); 'ok'`);
  },
  commands: async () => {
    await evaluate(`document.getElementById('btn-menu').click();
                    document.getElementById('btn-help').click(); 'ok'`);
    await sleep(400);
    await evaluate(`document.querySelector('.help-tab[data-tab="commands"]').click(); 'ok'`);
    await sleep(1200);
  },
};

if (!SCENES[scene]) {
  console.error(`unknown scene "${scene}" — try: ${Object.keys(SCENES).join(', ')}`);
  process.exit(2);
}

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: `${base}/?t=${encodeURIComponent(token)}` });
await sleep(1200);
if (theme) {
  // Stored, then reloaded: the theme is applied by an inline script before first
  // paint, so setting it live would not exercise the same path.
  await evaluate(`localStorage.setItem('cc-theme', ${JSON.stringify(theme)}); 'ok'`);
  await send('Page.reload');
  await sleep(2000);
}
await sleep(2300);

// The hub binds to its tailnet address, not loopback, so the default URL is wrong as
// often as not. Say that, rather than failing later on a null element.
if (!(await evaluate(`Boolean(document.getElementById('compose'))`))) {
  console.error(`${base} did not serve the app — set CC_URL to the address the hub is bound to.`);
  chrome.kill();
  process.exit(1);
}

await SCENES[scene]();
await sleep(300);

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));

/*
 * Measurements, not just pixels. The layout bug this was written for — a sidebar
 * three times its stated width — is obvious as a number and easy to miss by eye.
 */
const box = (id) => `(() => {
  const el = document.getElementById(${JSON.stringify(id)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
})()`;

const report = await evaluate(`JSON.stringify({
  viewport: [window.innerWidth, window.innerHeight],
  bodyClass: document.body.className,
  list: ${box('screen-list')},
  chat: ${box('screen-chat')},
  menuOpen: !document.getElementById('cmd-pop').hidden,
  menuRows: document.querySelectorAll('.cmd-row').length,
  topMatch: document.querySelector('.cmd-row-name')?.textContent ?? null,
  hint: document.getElementById('cmd-hint').hidden
    ? null : document.getElementById('cmd-hint').textContent,
  token: document.querySelector('.cmd-tok')?.className ?? null,
  jumpShown: !document.getElementById('btn-bottom').hidden,
  composeOverflowY: getComputedStyle(document.getElementById('compose')).overflowY,
  composeScrolls: (() => {
    const c = document.getElementById('compose');
    return c.scrollHeight > c.clientHeight;
  })(),
  dropVeil: !document.getElementById('drop-veil').hidden,
  dropVeilPaint: (() => {
    const v = document.getElementById('drop-veil');
    const cs = getComputedStyle(v);
    const r = v.getBoundingClientRect();
    return { bg: cs.backgroundColor, z: cs.zIndex, box: [Math.round(r.width), Math.round(r.height)] };
  })(),
  // These two must be identical: the highlight layer sits on top of the real text.
  mirrorBox: ${box('compose-mirror')},
  textareaBox: ${box('compose')},
}, null, 2)`);

console.log(`wrote ${out}`);
console.log(report);

socket.close();
chrome.kill();
process.exit(0);
