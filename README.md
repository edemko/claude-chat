# claude-chat

Chat with the coding-agent sessions running on your servers, from your phone.
**Claude Code and OpenAI Codex**, in one list.

One tmux-hosted session = one conversation. It exists to solve a narrow, real problem:
typing into a terminal over SSH on Android is miserable, but talking to a coding agent is
just messaging — so make it messaging, with a real keyboard, autocorrect and dictation.

Sessions keep running when you close the app. They are ordinary `claude` processes in
tmux, so you can attach to the same session from your laptop and carry on.

```
phone ──── HTTP + WebSocket over Tailscale ────►  hub (this repo, :7420)
 chat list                                        ├─ discovery: tmux + /proc + transcripts
 chat view, compose box, key bar                   ├─ stream:    tail -F → JSONL → events
 screenshot upload                                 ├─ input:     tmux send-keys
 ntfy app for push                                 └─ registry:  ~/.claude-chat/
```

Two clients, same API: a **PWA** served by the hub itself (no build step, updates on
reload) and a **native Android app** in `flutter_client/`. The PWA is the one to start
with — it is also the only one with the newer features.

### Two agents, one list

The agent is a property of the **pane**, not of the machine: one server routinely runs
`claude` in one pane and `codex` in another, in the same repo, at the same time. So both
appear in one list with a provider badge, and the filter chips above it narrow rather
than switch. A mode that hid one agent would mean a notification could arrive for a
session the interface was pretending did not exist.

Which agents a machine has is reported by the hub, so a server without Codex never
offers it.

The two are not symmetrical, and the asymmetry is the interesting part:

| | Claude Code | Codex |
|---|---|---|
| transcript | `~/.claude/projects/<slug>/<uuid>.jsonl` | `~/.codex/sessions/<date>/rollout-…-<uuid>.jsonl` |
| pane → session | **inferred** — nothing holds the file open | **exact** — the process holds it on an fd |
| match confidence | `exact`/`strong`/`weak`/`pending` | `exact` or `pending`, never a guess |
| context + limits | computed privately; scraped off the status line | fields in the transcript |
| clears the composer | `Escape` | `C-u` — Escape leaves the text |
| bypass flag | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` |

Codex holding its transcript open is the whole reason its provider is a third the size
of Claude Code's: `readlink /proc/<pid>/fd/*` answers the question that the confidence
ladder, birth-time correlation, screen-content matching and manual picker all exist to
guess at.

## What you need

- A Linux/macOS machine running Claude Code sessions inside **tmux**
- **Node 20+** on that machine (22 recommended)
- **Tailscale**, or another private path from your phone to the machine — see
  [Reaching it from your phone](#reaching-it-from-your-phone). Do not put this on a
  public port.
- A phone. Android for the native client; the PWA works on anything with a browser.

## Setup

```bash
git clone https://github.com/edemko/claude-chat.git
cd claude-chat
npm install && npm run build
```

Bind it to your private address. `CC_HOST` defaults to loopback, so an unconfigured hub is
not reachable from anywhere:

```bash
CC_HOST=$(tailscale ip -4) npm start
```

The startup log prints a URL containing the master token. That works on its own, but for
day-to-day use set a password instead — you can remember one and type it on a new device:

```bash
npm run build                        # cc-user.mjs imports from dist/
node scripts/cc-user.mjs set erik    # prompts twice, input hidden
node scripts/cc-user.mjs list        # users and logged-in devices
node scripts/cc-user.mjs logout-all  # revoke every device
```

Open `http://<your-tailscale-ip>:7420/` on the phone and sign in. Add it to the home
screen and it behaves like an app.

### Run it as a service

```bash
ln -sf "$PWD/deploy/claude-chat.service" ~/.config/systemd/user/claude-chat.service

# Host-specific settings go in a drop-in, NOT in the unit — that file is tracked in
# git, so editing it in place is undone by the next pull, and the change is silent:
# systemd keeps running the old copy until something reloads it, then the hub comes
# back bound to loopback and unreachable.
mkdir -p ~/.config/systemd/user/claude-chat.service.d
printf '[Service]\nEnvironment=CC_HOST=%s\n' "$(tailscale ip -4)" \
  > ~/.config/systemd/user/claude-chat.service.d/local.conf

systemctl --user daemon-reload && systemctl --user enable --now claude-chat
loginctl enable-linger "$USER"        # survive logout
journalctl --user -u claude-chat -f
```

Check what it actually bound to, not what you asked for:

```bash
ss -tlpn | grep 7420        # want your 100.x.y.z address, never 0.0.0.0
```

### Keeping a second machine up to date

For a box that runs the hub but is not where you edit, deploy from git rather than
copying files around:

```bash
git clone https://github.com/edemko/claude-chat.git ~/claude-chat
cd ~/claude-chat && npm ci && npm run build
scripts/deploy-update.sh --force      # pull, typecheck, build, restart
```

To pick up pushes on its own, install the timer:

```bash
ln -sf ~/claude-chat/deploy/claude-chat-update.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now claude-chat-update.timer
systemctl --user list-timers claude-chat-update    # when it next fires
journalctl --user -u claude-chat-update -f         # what it did
```

It polls every five minutes rather than taking a webhook, because a deployment box
worth having has no inbound ports open. The script exits immediately when the remote
has not moved, and **typechecks and builds before restarting** — a bad push leaves
that machine on the previous build instead of taking it down.

Keep host-specific settings out of the clone: the unit file it ships is generic, so
give the machine its own `~/.config/systemd/user/claude-chat.service` or a drop-in,
otherwise the next pull silently repoints the service.

### Configuration

| Env | Default | Meaning |
|---|---|---|
| `CC_HOST` | `127.0.0.1` | Bind address. Set to your Tailscale address. **Never `0.0.0.0`.** Falls back to loopback if the address is unavailable — fails closed. |
| `CC_PORT` | `7420` | |
| `CC_DIR` | `~/.claude-chat` | State: token, users, sessions, pane→transcript registry, uploads. |
| `CC_REPO_ROOTS` | `~/Dev` | Comma-separated roots scanned for git repos in the create-session picker. |
| `CC_TOKEN` | generated | Master bearer token; otherwise read from `$CC_DIR/token` (0600). |
| `CC_NTFY_URL` / `CC_NTFY_TOPIC` | `http://127.0.0.1:8080` / `claude-sessions` | Used by the notification hook. |
| `CC_NTFY_LABEL` | *(empty)* | Prefixed to notification titles. Set per host once more than one hub publishes to a topic. |
| `CC_APP_URL` | `http://127.0.0.1:7420/` | Where tapping a notification goes. Set per host. |

### The address is the whole configuration

The hub binds to **one** interface. Whatever `CC_HOST` names is the only address it
answers on — that bind is the security boundary, so a machine with a public IP still
answers only on its tailnet address. Reaching one at its public IP therefore fails in a
way that looks exactly like Tailscale being off, which is why "add a server" now says so
explicitly when the address you typed is a public IPv4.

Use the `100.x.y.z` address, or the `<machine>.ts.net` MagicDNS name.

### Reaching it from your phone

**The bind address is the security boundary.** Any credential here is effectively shell
access to the machine, so the port must not be reachable from the internet. In order of
preference:

1. **Tailscale** (what this is built for) — `CC_HOST=$(tailscale ip -4)`, no inbound
   firewall rule, nothing public. `tailscale serve` on top gives a real Let's Encrypt
   certificate on your `*.ts.net` name, which is worth doing.
2. **Cloudflare Tunnel** — bind to `127.0.0.1`, point `cloudflared` at it. Real HTTPS, no
   open ports. Put Cloudflare Access in front for a second auth layer.
3. **SSH port-forward** — `ssh -L 7420:127.0.0.1:7420 you@host`, hub on loopback. Most
   conservative; least convenient on a phone, since Android kills backgrounded tunnels.
4. **A public port.** Don't.

### Push notifications (optional)

```bash
cd deploy && docker compose -f ntfy-compose.yml up -d   # set the bind address first
```

Then point Claude Code's `Stop` and `Notification` hooks at `scripts/cc-notify.py` in
`~/.claude/settings.json`:

```json
"hooks": {
  "Stop": [{ "hooks": [{ "type": "command",
    "command": "python3 /path/to/claude-chat/scripts/cc-notify.py Stop" }] }],
  "Notification": [{ "hooks": [{ "type": "command",
    "command": "python3 /path/to/claude-chat/scripts/cc-notify.py Notification" }] }]
}
```

Hooks fire in-process with Claude Code, so `cc-notify.py` always exits 0 and never blocks
a session. Subscribe the ntfy Android app to the server address and topic.

With **more than one hub**, publish to the same ntfy and topic so the phone keeps one
subscription, and set two variables per host — in the hook command itself, not the
environment, because hooks inherit whatever started Claude Code and a tmux-launched
session is a non-interactive login shell:

```json
"command": "CC_NTFY_URL=http://<ntfy-host>:8080 CC_NTFY_LABEL=staging CC_APP_URL=http://staging.example.ts.net:7420/ python3 …/cc-notify.py Stop"
```

`CC_NTFY_LABEL` prefixes the title (`staging · b2b-miner`); `CC_APP_URL` decides which hub
a tap opens. Without the second one, every notification opens whichever host is the
default.

## Using it

- **Sessions list** — grouped by the project each session runs in. A git repo is
  highlighted; a plain folder is dimmed and labelled as one. Work here is organised by
  project because conversation names repeat across them and a repo is the unit of work.
- **New session** — pick a repo from `CC_REPO_ROOTS`, or browse to any folder on the
  machine and create one. The hub launches `claude --session-id <uuid>` in a fresh tmux
  session.
- **Chat** — messages and expandable tool chips. Markdown, with bold and italic in their
  own colours. Code blocks have a copy button; tap inline code to copy it.
- **Slash commands** — type `/` and a menu of matching commands opens, with descriptions.
  ↑/↓ move, Tab or Enter completes, Esc closes. The name is coloured in the compose box
  as you type, and a command the session will not recognise is flagged before you send
  it. See below for where the list comes from.
- **Key bar** — `esc`, `^C`, arrows, `tab`, `enter`, plus `screen` (peek at the raw pane)
  and `conversation` (fix a wrong transcript match).
- **Screenshot** — the picture button sends an image; on a desktop you can also drag one
  onto the conversation or paste it from the clipboard. Whatever is in the compose box
  becomes the caption.
- **ⓘ** — model, effort, context tokens, branch, turn counts, uptime, and the pane's own
  status line scraped verbatim.
- **☰** — server browser, and **Help & commands**: what everything does, plus every
  command this session accepts. Star a server and it appears in a quick-switch bar under
  the session list; switching slides the list the direction you moved. Servers can also
  be renamed, and signing in again refreshes the token without losing the name.

  Three names can exist for one server, in this order of authority: one you typed, the
  label the hub reports for itself (learned on first connection and cached, so the drawer
  and the chips can show it without a request), then the bare address. The automatic
  label assigned at first sign-in *is* the address, so it counts as unnamed rather than
  as a choice — otherwise the drawer showed `100.75.240.46` while the header, reading the
  hub's own label, said `sam`.
- **↓** — appears while scrolled up, and turns orange when something arrives while you
  are reading back. The view never jumps to the bottom on its own.

### On a wide screen

Past 900 px the app splits: sessions stay in a sidebar on the left, the conversation
fills the rest, and there is no back button because there is nothing to go back to. The
thread is held to a readable column rather than stretching across a monitor. `Enter`
sends and `Shift-Enter` starts a new line — on a phone the ↑ button still sends, since
`Enter` there is the keyboard's newline.

### Where the command list comes from

`GET /api/servers/:id/commands?cwd=…` merges three sources:

- **Built-ins** — a curated list in `src/commands.ts`, topped up by reading the
  definitions out of the installed `claude` binary. That scan costs ~60 ms and is cached
  against the binary's size and mtime, so an upgrade picks up new commands by itself.
  Extraction only ever *adds* entries; if it finds nothing the curated list still works.
- **Your commands** — `~/.claude/commands/**.md`, and `.claude/commands/**.md` in the
  project. A nested folder namespaces the command: `commands/review/api.md` is
  `/review:api`. The `description:` in its frontmatter is what the menu shows; without
  frontmatter the first line of prose is used.
- **Skills** — `SKILL.md` under `~/.claude/skills/*/` and the project's.

A project command shadows a user one of the same name, and either shadows a built-in —
the same order Claude Code resolves them in.

## How it works

**Reading** — `~/.claude/projects/<slug>/<uuid>.jsonl` is already a structured chat log,
so nothing here emulates a terminal. Records become message bubbles and tool chips. No
ANSI parsing anywhere. Reasoning blocks are dropped: the chat shows what a normal Claude
Code session prints.

**Paged history** — `GET …/history?limit=&before=` returns the *newest* page plus a
`cursor`, the byte offset of the oldest record returned. Opening a chat reads ~48 KB from
the end rather than converting a 2 MB transcript; both clients load older pages as you
scroll up. Cursors are byte offsets at record boundaries, computed with
`Buffer.byteLength` because transcripts are not ASCII.

**Session names** — `/rename` writes a `custom-title` record; the automatic titler writes
`ai-title`. Claude Code emits **both on every turn, with `ai-title` after**, so "whichever
is later wins" silently discards the rename. A custom title therefore outranks the
automatic one regardless of position.

**Writing** — `tmux send-keys` into the live pane, so the running session keeps its full
context. Multi-line text goes through `load-buffer` + `paste-buffer -p` so newlines don't
submit early. Every send re-checks that the pane is still running claude — otherwise the
text would land in a shell prompt and execute.

**Creating** — `tmux new-session -d -c <dir> "zsh -lc 'claude --session-id <uuid>'"`.
Generating the uuid up front makes the pane→transcript mapping exact by construction.

**Screenshots** — Claude Code is handed an image by being given a *path*, so the hub
writes the upload on the machine the session runs on and types that path into the pane.
`Content-Type` is a claim, so the leading bytes are checked against it; the write is
confirmed with `stat` before the path is sent.

**Multi-server, two ways** — different axes, both present:

1. *Client-side*: each client keeps its own list of hubs, each with its own login. The ☰
   menu adds one. This is the one to use for other machines — each runs its own hub.
2. *Hub-side*: one hub reaching other machines over SSH, behind the `Executor` interface in
   `src/exec.ts`. Add an entry to `$CC_DIR/servers.json`:

```json
[
  { "id": "sam",   "label": "sam (local)", "kind": "local" },
  { "id": "other", "label": "other box",   "kind": "ssh", "host": "other.example" }
]
```

Note: the clients currently read only the **first** entry of the hub-side list, so option 2
needs a server picker that does not exist yet. Option 1 works fully.

## The hard part: which transcript belongs to which pane

For sessions this app creates, the answer is exact — it chose the uuid. For sessions that
were already running, it genuinely cannot be known for certain. A session can be
`--resume`d into an older transcript, `/clear`ed into a new one, and have its model
switched mid-conversation. No process holds the `.jsonl` open, so there is no fd to
inspect.

So the resolver ranks evidence and is honest about the result:

| `confidence` | Meaning |
|---|---|
| `exact` | Launched with `--session-id`, or you pinned it, or birth-time **and** on-screen content agree |
| `strong` | Transcript created within 120 s of the process starting, or its recent text is on the pane's screen |
| `weak` | A guess. The UI says so and offers a picker |
| `pending` | No transcript exists yet — the session has not been spoken to |

Birth-time ranks above screen content: it is mechanical and precise, while a screen match
is fuzzy enough that one coincidental line let a pane steal another's transcript. Stub
transcripts (< 8 KB, usually abandoned by an immediate `/resume`) are never chosen as a
fallback. Only a transcript **modified since the pane's claude started** can be the one it
is writing — without that rule a freshly opened session inherited the previous
conversation in the same repo, name and history included. Any pane can be pinned from the
**conversation** button, and the choice persists.

## Security

**The bind address is the real control**: private-network only, never `0.0.0.0`, no public
port. Everything below is defence in depth rather than the boundary.

Two credential types, both compared in constant time:

| | |
|---|---|
| **Session token** | Minted by `POST /api/login` from a username and password. 32 random bytes, stored on the device, revocable per device, 90-day idle expiry. Only its SHA-256 is written to `sessions.json`, so that file is not itself a key. |
| **Master token** | `$CC_DIR/token` (0600), generated on first run. Not revocable and does not expire — it exists for scripts and the APK download link. Delete the file and restart to rotate. |

Passwords are hashed with scrypt (N=16384, r=8, 64-byte key, per-user random salt) in
`users.json` (0600). A wrong password and an unknown username return an identical 401 and
both pay the full scrypt cost, so neither response nor timing reveals whether an account
exists. Five failures triggers an escalating lockout.

`/api/login` and `/api/auth-mode` are the only endpoints reachable without a credential.
`/api` sends `Access-Control-Allow-Origin: *`, which is safe *here specifically* because
authentication is a bearer token in a header, never a cookie: the browser attaches nothing
automatically, and a hostile page cannot read another origin's stored token. It exists so
a PWA served by one hub can be pointed at another. Were this cookie-based it would be a
hole — and for the same reason CSRF is not a vector.

Deliberately **not** here: TLS (use `tailscale serve` or a tunnel), per-user authorisation
(any account can drive any session), and audit logging beyond a line per login.

**Sessions created from the app default to `--dangerously-skip-permissions`** (a toggle in
the create sheet). That means a phone can run unattended commands on the server. Decide
whether you want that before pointing this at anything you care about.

## Development

```bash
npm run build          # tsc
npm run typecheck
node scripts/test-discovery.mjs    # dedupe + status-line scraping, no server needed
node scripts/test-markdown.mjs     # markdown renderer against a DOM stub
node scripts/test-commands.mjs     # slash-command parsing and ranking
node scripts/test-codex.mjs        # Codex record shapes, against real fixtures
node scripts/smoke-ws.mjs          # end-to-end live stream, throwaway session
```

The PWA in `web/` has no build step — edit and reload. Bump `CACHE` in `web/sw.js` so the
service worker picks up a change.

To actually look at it on a machine with no display:

```bash
CC_URL=http://100.x.y.z:7420 node scripts/screenshot.mjs --scene cmd --size 1280x860
```

Headless Chrome over the DevTools protocol — navigate, click, screenshot, and print what
the DOM measured. The measurements matter more than the picture, in both directions: a
sidebar that renders wrong is obvious as `list: [0, 0, 1113, 668]` and easy to talk
yourself out of by eye, and a drop overlay that *looked* far too pale turned out to be
exactly right (`[96, 98, 102]` against a `[246, 248, 252]` sidebar). Scenes cover the
list, a chat, the command menu and hint, an unknown command, the drawer, both help tabs,
the add-server and rename modals, and the drag-and-drop overlay. `--theme dark|light`
forces a palette, which is the only way to check the one your system is not set to.
Chrome is found in the puppeteer cache or via `$CHROME`; nothing is installed.

Android client:

```bash
scripts/build-apk.sh          # test, build, stamp the version in, publish
scripts/build-apk.sh --no-publish
```

That script is the supported path. It passes the pubspec version and a UTC build time via
`--dart-define`, then greps the compiled Dart snapshot to prove the stamp is really there
before publishing — a mistyped flag would otherwise ship an APK labelled `dev build`. The
stamp shows in the drawer footer and the ⓘ sheet, which is the only way to tell which
build a phone is running when the APK is delivered by file sync.

Three Android details that would each have silently broken a release build:

- `INTERNET` is only in the **debug** manifest by default, so a release APK would have
  had no network at all.
- Cleartext HTTP is blocked from API 28. `network_security_config.xml` permits it for
  `*.ts.net` and loopback specifically, not globally. A bare IP needs its own entry.
- Flutter's template signs release builds with the **debug** key. Use a real release key
  configured via `android/key.properties` (gitignored) and **keep it** — Android refuses
  an update signed with a different key.

## Gotchas discovered the hard way

- The transcript file appears on the **first message**, not at session start — a brand-new
  session must still be listable, or it is unreachable by `send`.
- `zsh -lc claude` **exec's** into claude, so for app-created sessions the pane's own
  process *is* claude; there is no child to find under `pane_pid`.
- If `claude` is on `PATH` only via `.zshrc`, a tmux-launched `zsh -lc claude` will not
  find it — `.zshrc` is for interactive shells. Put it in `.zprofile`.
- The directory trust prompt blocks startup and `--dangerously-skip-permissions` does
  **not** skip it. The hub detects and answers it, which is only acceptable because the
  directory came from the user's own picker.
- Don't key caches on a process start time derived from `ps -o etimes` — whole seconds,
  jitters ±1 s, silently breaks every lookup. Key on pid.
- Never `pkill node` on a box running Claude Code; every session is a node process. And
  `pkill -f dist/server.js` matches your own shell — use `lsof -ti tcp:7420`.
- Codex's `token_count` has two usage blocks and only one of them is the context:
  `total_token_usage` is cumulative for the whole session, `last_token_usage` is the
  live context. On a real session the cumulative figure was 510639 against a
  258400-token window — 198% of a context that was in fact about a quarter full. The
  SQLite index's `tokens_used` mirrors the cumulative one, so it is the same trap.
- Codex writes `turn_context` once **per turn**, at the start of that turn — so on a
  session with long turns the newest one is far from the end of the file (684 KB back,
  measured). Reading the tail silently loses the model and approval mode; grep for it.
- `FileChange.changes` is an object keyed by absolute path, not an array of records.
  Read as an array, every edit chip was labelled with a fragment of its own diff.
- Codex content blocks are inconsistently cased: `{type:"text"}` in a `UserMessage`,
  `{type:"Text"}` in an `AgentMessage`. Match on the presence of `text`, not the tag.
- A grep window cut mid-record leaves an **unterminated** JSON string, so a pattern
  that requires the closing quote matches nothing. This cost a debugging round: the
  session titles came back empty while the same grep worked fine in a shell.
- A file containing a stray NUL byte is treated as *binary* by grep, which then reports
  nothing at all for a pattern that is plainly present. One had crept into a template
  literal in `commands.ts` — harmless at runtime, invisible to `tsc`, and it silently
  broke every `grep` against that file until it was found by reading bytes.
- A flex item will not shrink below its content unless given `min-width: 0`. One long
  `cwd` in the sidebar made it 1113 px wide instead of 340, and `flex: 0 0 340px` looked
  like it should have prevented exactly that.
- A `<textarea>` with `overflow: auto` reserves a scrollbar gutter as soon as its content
  approaches its height, so an autogrowing one shows a permanent track on a single line.
  Keep it `hidden` and switch to `auto` only once the height is clamped.
- `.ghost` lost to `.add-form button` — a bare class is less specific than a class plus an
  element, so the "cancel" button came out filled with the accent, identical to the
  primary beside it. `button.ghost` is the fix.
- The drawer is `z-index: 25` and sheets are `20`, so a modal opened *from* the drawer
  rendered beneath the drawer's own scrim and looked like a theme bug. Close the drawer
  first, as the help sheet already did.
- A pane that slides its contents needs `overflow-x: clip` or the outgoing content
  travels across whatever is beside it. `clip`, not `hidden`: `hidden` would make the
  pane a scroll container and take over the inner list's scrolling.
- Typing a slash command opens the TUI's *own* completion menu. Verified before building
  on it: one `Enter` still submits, and typing a space closes the menu first — so
  `send-keys` needs no special case. Worth re-checking if it ever starts eating sends.

## Layout

```
src/exec.ts        Executor interface, LocalExecutor, SshExecutor
src/proc.ts        one-round-trip probe: clock, home, panes, process table
src/discovery.ts   orchestrator: asks each provider off one probe, merges, dedupes
src/providers/     one file per agent — the only place the two differ
  index.ts         the Provider interface, registry, and per-machine availability
  claude.ts        record meaning + the pane→transcript inference it needs
  codex.ts         rollout parsing; discovery is a readlink, so it is much shorter
src/transcript.ts  slug rules, JSONL parsing, record→chat-event mapping
src/stream.ts      ref-counted `tail -F` per transcript, coalesced batches
src/input.ts       send-keys, bracketed paste, key whitelist, not-claude guard
src/create.ts      --session-id launch, trust prompt, startup settle, repo picker
src/info.ts        the ⓘ sheet: scraped status line + transcript-derived facts
src/upload.ts      screenshots: magic-byte check, write on the session's machine
src/commands.ts    slash commands: curated built-ins, binary scan, custom + skills
src/auth.ts        scrypt passwords, session tokens, lockout
src/server.ts      HTTP + WebSocket, token auth, static PWA
web/               the PWA (vanilla, no build step)
web/markdown.js    DOM-building markdown renderer (never innerHTML)
web/commands.js    command matching and help copy — pure, testable, no DOM
flutter_client/    native Android client against the same API
scripts/           notification hook, APK build/publish, headless tests, screenshots
deploy/            systemd user unit, ntfy compose
```

## Status

Personal tool, published because it might be useful. It works and is in daily use, but it
is shaped by one person's setup — expect rough edges outside the paths described above.
Issues and PRs welcome; no support promised.
