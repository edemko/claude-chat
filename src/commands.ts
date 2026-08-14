/**
 * The slash commands a session will accept, for the composer's autocomplete and the
 * help sheet.
 *
 * Two sources, and they answer different questions:
 *
 *   - **Built-ins** ship with Claude Code. A curated list lives below because it is
 *     the one thing that always works — no filesystem, no parsing, no version
 *     guessing. It is then *topped up* by reading the installed binary, which is how
 *     commands added after this file was written still show up. Extraction only ever
 *     adds entries and fills blank descriptions; the curated text always wins.
 *   - **Custom commands and skills** live in `~/.claude` and `<project>/.claude`.
 *     These cannot be guessed at all, and they are the half a static list can never
 *     know — which is the main reason this module exists.
 */

import type { Executor } from './exec.js';
import { q } from './shell.js';

export type CommandSource = 'builtin' | 'user' | 'project' | 'skill';

export interface SlashCommand {
  /** Without the leading slash, as Claude Code names it. */
  name: string;
  description: string;
  /** What goes after the name, e.g. `[name]`. Null when it takes no arguments. */
  argumentHint: string | null;
  source: CommandSource;
  /** Where a custom command or skill was found. Null for built-ins. */
  path: string | null;
}

export interface CommandCatalogue {
  commands: SlashCommand[];
  /** Directories that were searched, so the help sheet can say where to add one. */
  searched: string[];
}

/**
 * Built-ins worth offering, with descriptions taken from Claude Code itself.
 *
 * Deliberately shorter than the full set: `/heapdump`, `/stickers` and friends exist
 * but do not belong in a list you scroll on a phone. To refresh this, the binary
 * carries its own definitions — see `extractBuiltins` below, which is the mechanism
 * that keeps a stale list from being wrong rather than merely incomplete.
 */
const CURATED: readonly [string, string, string | null][] = [
  ['clear', 'Start a new session with empty context; the old one stays resumable', '[name]'],
  ['compact', 'Free up context by summarising the conversation so far', '[instructions]'],
  ['context', 'Show current context usage', null],
  ['usage', 'Show session cost, plan usage, and activity stats', null],
  ['resume', 'Resume a previous conversation', '[id or search term]'],
  ['rename', 'Rename the current conversation', '[name]'],
  ['model', 'Set the model for this session', '<model>'],
  ['effort', 'Set the reasoning effort level', null],
  ['status', 'Version, model, account, connectivity and tool status', null],
  ['init', 'Create a CLAUDE.md with codebase documentation', null],
  ['memory', 'Edit CLAUDE.md files and memory settings', null],
  ['config', 'Set a setting by key', 'key=value'],
  ['permissions', 'Manage allow and deny tool permission rules', null],
  ['hooks', 'View hook configurations for tool events', null],
  ['mcp', 'Manage MCP servers', '[reconnect|enable|disable]'],
  ['plugin', 'Manage Claude Code plugins', null],
  ['skills', 'List available skills', null],
  ['agents', 'Create and manage subagents', null],
  ['add-dir', 'Add another working directory', '<path>'],
  ['cd', 'Move this session to a new working directory', '<path>'],
  ['plan', 'Enable plan mode or view the current session plan', '[open|share|<description>]'],
  ['rewind', 'Rewind the conversation, the code, or both', null],
  ['branch', 'Branch the conversation at this point', '[name]'],
  ['fork', 'Spawn a background agent that inherits the conversation', '<directive>'],
  ['subtask', 'Send a subagent off with your full context', '<task>'],
  ['btw', 'Ask a side question without interrupting the main thread', '[question]'],
  ['goal', 'Set a goal Claude checks before stopping', '[<condition> | clear]'],
  ['tasks', 'View and manage everything running in the background', null],
  ['export', 'Export the current conversation to a file or clipboard', '[filename]'],
  ['copy', "Copy Claude's last response to the clipboard", '[N]'],
  ['help', 'Show help and available commands', null],
  ['statusline', "Set up Claude Code's status line", null],
  ['theme', 'Change the theme', null],
  ['login', 'Sign in with your Anthropic account', null],
  ['logout', 'Sign out from your Anthropic account', null],
  ['feedback', 'Send feedback to Anthropic or report a bug', '[report]'],
  ['exit', 'End this session', null],
];

/**
 * Names never offered, whatever the binary says: internal plumbing, developer tools,
 * and the handful that would be actively unpleasant to fire by accident from a phone.
 */
const NEVER_OFFER = new Set([
  'heapdump', 'debug-tool-call', 'ant-trace', 'input-debug', 'render-debug',
  'mock-limits', 'simulate-usage', 'reset-limits', 'oauth-refresh', 'perf-issue',
  'stickers', 'radio', 'pride', 'powerup', 'onboarding', 'passes', 'drains',
  'setup-bedrock', 'setup-vertex', 'pro-trial-expired', 'rate-limit-options',
  'extra-usage', 'design-consent', 'design-revoke',
]);

/**
 * Command definitions in the shipped bundle, e.g.
 *
 *   {type:"local-jsx",name:"add-dir",description:"Add a new working directory",…}
 *
 * The bundle is minified, so this reads one object shape and knowingly misses the
 * others (some declare `get description(){…}`, which has no literal to read). That is
 * why it tops up a curated list instead of replacing one: a miss costs a line in a
 * list, never a broken feature.
 */
const DEF_RE = /\{type:"(?:local|local-jsx|prompt)",name:"([a-z0-9_-]+)"([^}]{0,400})/g;

function field(blob: string, key: string): string | null {
  const m = new RegExp(`${key}:"((?:[^"\\\\]|\\\\.)*)"`).exec(blob);
  if (!m?.[1]) return null;
  // The bundle stores non-ASCII as \uXXXX escapes; JSON.parse is the cheapest correct
  // way to get "…" back rather than a literal backslash-u.
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1];
  }
}

/** Locate the `claude` executable: from a running session if there is one, else PATH. */
async function claudeBinary(exec: Executor): Promise<string | null> {
  // /proc/<pid>/exe of a live session is authoritative and free — and it sidesteps
  // the PATH problem, since `claude` is nvm-installed and a non-interactive login
  // shell does not source the rc file that puts it on PATH.
  const script = [
    'p=$(pgrep -x claude 2>/dev/null | head -n 1)',
    '[ -n "$p" ] && readlink -f "/proc/$p/exe" 2>/dev/null && exit 0',
    'command -v claude 2>/dev/null && exit 0',
    'ls -1 "$HOME"/.local/bin/claude "$HOME"/.nvm/versions/node/*/bin/claude 2>/dev/null | head -n 1',
  ].join('\n');
  const { stdout } = await exec.runShell(script, { timeoutMs: 10_000 });
  const path = stdout.split('\n').map((l) => l.trim()).find(Boolean);
  return path ?? null;
}

interface BuiltinCache {
  /** Binary identity — path, size and mtime — so an upgrade invalidates this. */
  key: string;
  commands: SlashCommand[];
}
const builtinCache = new Map<string, BuiltinCache>();

async function extractBuiltins(exec: Executor): Promise<Map<string, SlashCommand>> {
  const found = new Map<string, SlashCommand>();
  const bin = await claudeBinary(exec);
  if (!bin) return found;

  // Identity first: the scan is cheap but not free, and the answer only changes when
  // the binary does.
  const { stdout: ident } = await exec.runShell(
    `stat -c '%s %Y' ${q(bin)} 2>/dev/null || stat -f '%z %m' ${q(bin)} 2>/dev/null`,
    { timeoutMs: 10_000 },
  );
  const key = `${bin} ${ident.trim()}`;
  const hit = builtinCache.get(exec.id);
  if (hit?.key === key) {
    for (const cmd of hit.commands) found.set(cmd.name, cmd);
    return found;
  }

  // LC_ALL=C: the binary is not valid UTF-8, and without it grep gives up on the
  // whole file. -a for the same reason: it is binary, and we want the text in it.
  const { stdout } = await exec.runShell(
    `LC_ALL=C grep -aoE '\\{type:"(local|local-jsx|prompt)",name:"[a-z0-9_-]+"[^}]{0,300}' ${q(bin)} || true`,
    { timeoutMs: 30_000 },
  );

  for (const line of stdout.split('\n')) {
    DEF_RE.lastIndex = 0;
    const m = DEF_RE.exec(line);
    if (!m) continue;
    const [, name = '', blob = ''] = m;
    if (!name || name.startsWith('_') || NEVER_OFFER.has(name)) continue;
    // isHidden marks a command the TUI itself will not list; isEnabled:()=>!1 is an
    // unconditional "not available in this build". Conditional gates are left alone —
    // they may well be true here.
    if (blob.includes('isHidden:!0') || blob.includes('isEnabled:()=>!1')) continue;
    const description = field(blob, 'description');
    if (!description) continue;
    if (found.has(name)) continue;
    // A hint is a one-glance reminder of the shape of the arguments. A few run to a
    // full usage string, which would push the description out of a popup row.
    const hint = field(blob, 'argumentHint');
    found.set(name, {
      name,
      description,
      argumentHint: hint && hint.length > 44 ? `${hint.slice(0, 43)}…` : hint,
      source: 'builtin',
      path: null,
    });
  }

  builtinCache.set(exec.id, { key, commands: [...found.values()] });
  return found;
}

async function builtins(exec: Executor): Promise<SlashCommand[]> {
  let extracted = new Map<string, SlashCommand>();
  try {
    extracted = await extractBuiltins(exec);
  } catch (err) {
    // A missing binary or an unreadable one is not a reason to have no autocomplete.
    console.error('[commands] could not read built-ins from the binary:', err);
  }

  const out: SlashCommand[] = [];
  const taken = new Set<string>();
  for (const [name, description, argumentHint] of CURATED) {
    const live = extracted.get(name);
    // Curated text wins; the binary supplies the argument hint when we have none.
    out.push({
      name,
      description,
      argumentHint: argumentHint ?? live?.argumentHint ?? null,
      source: 'builtin',
      path: null,
    });
    taken.add(name);
  }
  for (const [name, cmd] of extracted) {
    if (!taken.has(name)) out.push(cmd);
  }
  return out;
}

/* ---------- custom commands and skills ---------- */

/** `description:` / `argument-hint:` out of a leading YAML frontmatter block. */
function frontmatter(text: string): Record<string, string> {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  const out: Record<string, string> = {};
  for (const line of text.slice(3, end).split('\n')) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (key && value) out[key] = value;
  }
  return out;
}

/** First non-empty, non-heading line — a description for a file that declares none. */
function firstProse(text: string): string {
  const body = text.startsWith('---') && text.indexOf('\n---', 3) >= 0
    ? text.slice(text.indexOf('\n---', 3) + 4)
    : text;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('---')) continue;
    return line.replace(/\s+/g, ' ').slice(0, 120);
  }
  return '';
}

interface Root {
  scope: 'user' | 'project';
  dir: string;
}

/**
 * Read every custom command and skill in one round trip.
 *
 * Markers are printed with a leading newline because `head -c` cuts wherever the byte
 * limit lands — mid-line as often as not — and without it the next marker would be
 * swallowed by the tail of the file before it.
 */
async function customCommands(exec: Executor, roots: readonly Root[]): Promise<SlashCommand[]> {
  if (roots.length === 0) return [];

  const script = roots
    .flatMap((root) => [
      `find ${q(`${root.dir}/commands`)} -type f -name '*.md' 2>/dev/null | sort | while IFS= read -r f; do`,
      `  printf '\\n###CMD\\t${root.scope}\\t${root.dir}\\t%s\\n' "$f"`,
      `  head -c 1200 "$f" 2>/dev/null`,
      `done`,
      `find ${q(`${root.dir}/skills`)} -mindepth 2 -maxdepth 2 -name SKILL.md 2>/dev/null | sort | while IFS= read -r f; do`,
      `  printf '\\n###SKILL\\t${root.scope}\\t${root.dir}\\t%s\\n' "$f"`,
      `  head -c 1200 "$f" 2>/dev/null`,
      `done`,
    ])
    .join('\n');

  const { stdout } = await exec.runShell(script, { timeoutMs: 25_000 });
  const out: SlashCommand[] = [];

  for (const chunk of stdout.split('\n###').slice(1)) {
    const nl = chunk.indexOf('\n');
    if (nl < 0) continue;
    const [kind, scope, dir, file] = chunk.slice(0, nl).split('\t');
    if (!kind || !scope || !dir || !file) continue;
    const text = chunk.slice(nl + 1);
    const meta = frontmatter(text);

    let name: string;
    if (kind === 'SKILL') {
      // .../skills/<name>/SKILL.md
      name = meta['name'] ?? file.split('/').slice(-2)[0] ?? '';
    } else {
      // Nested folders namespace a command: commands/review/api.md -> /review:api
      const rel = file.startsWith(`${dir}/commands/`) ? file.slice(dir.length + 10) : file;
      name = rel.replace(/\.md$/, '').replace(/^\/+/, '').replace(/\//g, ':');
    }
    if (!name) continue;

    out.push({
      name,
      description: meta['description'] ?? firstProse(text) ?? '',
      argumentHint: meta['argument-hint'] ?? null,
      source: kind === 'SKILL' ? 'skill' : (scope as 'user' | 'project'),
      path: file,
    });
  }
  return out;
}

interface CacheEntry {
  at: number;
  catalogue: CommandCatalogue;
}
const catalogueCache = new Map<string, CacheEntry>();
const CATALOGUE_TTL_MS = 30_000;

/**
 * Everything this session can be sent as a slash command.
 *
 * `cwd` brings in that project's `.claude/commands` and `.claude/skills`; without it
 * only the user-wide ones are listed.
 */
export async function listCommands(
  exec: Executor,
  home: string,
  cwd: string | null,
): Promise<CommandCatalogue> {
  const cacheKey = `${exec.id} ${cwd ?? ''}`;
  const hit = catalogueCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CATALOGUE_TTL_MS) return hit.catalogue;

  const roots: Root[] = [{ scope: 'user', dir: `${home}/.claude` }];
  // A session already rooted at home would otherwise read the same directory twice.
  if (cwd && cwd !== home) roots.push({ scope: 'project', dir: `${cwd}/.claude` });

  const [builtin, custom] = await Promise.all([
    builtins(exec),
    customCommands(exec, roots).catch((err: unknown) => {
      console.error('[commands] custom command scan failed:', err);
      return [] as SlashCommand[];
    }),
  ]);

  // A project command shadows a user one of the same name, exactly as Claude Code
  // resolves them; a custom command of a built-in's name shadows the built-in.
  const byName = new Map<string, SlashCommand>();
  for (const cmd of builtin) byName.set(cmd.name, cmd);
  for (const cmd of custom.filter((c) => c.source === 'user' || c.source === 'skill')) {
    byName.set(cmd.name, cmd);
  }
  for (const cmd of custom.filter((c) => c.source === 'project')) byName.set(cmd.name, cmd);

  const catalogue: CommandCatalogue = {
    commands: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    searched: roots.flatMap((r) => [`${r.dir}/commands`, `${r.dir}/skills`]),
  };
  catalogueCache.set(cacheKey, { at: Date.now(), catalogue });
  return catalogue;
}
