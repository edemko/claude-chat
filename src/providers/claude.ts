/**
 * The Claude Code provider.
 *
 * This is the harder of the two providers, and all of the difficulty is one fact:
 * **no process holds the transcript open.** Which `~/.claude/projects/<slug>/<uuid>.jsonl`
 * a pane is writing has to be inferred — hence the confidence ladder, the birth-time
 * correlation, the screen-content match, and the manual picker that exists because
 * inference cannot be made reliable for sessions this app did not launch.
 *
 * Compare `codex.ts`, where the agent holds its own transcript on a file descriptor
 * and the entire question collapses into one readlink.
 */

import { randomUUID } from 'node:crypto';

import { listCommands, type CommandCatalogue } from '../commands.js';
import { launchInTmux, resolveBinary, settleStartup, tmuxSafeName } from '../create.js';
import type { Executor } from '../exec.js';
import { claudeDetail } from '../info.js';
import { enrichAgentProcs, findAgentInPane, type Probe } from '../proc.js';
import {
  getCreated,
  getMapping,
  getName,
  liveMappingKey,
  pruneMappings,
  putMapping,
  recordCreated,
} from '../registry.js';
import { normaliseForMatch, q } from '../shell.js';
import { listTranscripts, readRecords, type Candidate } from '../transcript.js';
import type {
  AgentProc,
  ChatEvent,
  CreateResult,
  MatchConfidence,
  PaneInfo,
  SessionDetail,
  SessionInfo,
} from '../types.js';
import type { Provider } from './index.js';

/**
 * Claude Code derives a project directory name from the cwd by replacing both path
 * separators and dots with hyphens:
 *   /home/you/Dev/my-clinic  -> -home-you-Dev-my-clinic
 *   /home/you/.config        -> -home-you--config
 */
export function slugFor(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

export function projectDirFor(home: string, cwd: string): string {
  return `${home}/.claude/projects/${slugFor(cwd)}`;
}

/* ---------- records to chat events ---------- */

/** Wrapper text Claude Code injects that should never appear as a chat bubble. */
function isNoiseText(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith('<local-command-caveat>') ||
    t.startsWith('<command-name>') ||
    t.startsWith('<command-message>') ||
    t.startsWith('<system-reminder>') ||
    t.startsWith('Caveat: The messages below') ||
    t.includes('<local-command-stdout>')
  );
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const t = (block as { text?: unknown }).text;
      if (typeof t === 'string') parts.push(t);
    }
  }
  return parts.join('\n');
}

function oneLine(s: string, max = 100): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Short, scannable label for a tool chip. */
function toolSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const pick = (k: string): string => (typeof i[k] === 'string' ? (i[k] as string) : '');
  switch (name) {
    case 'Bash':
      return oneLine(pick('command'));
    case 'Read':
    case 'Write':
    case 'NotebookEdit':
      return oneLine(pick('file_path'));
    case 'Edit':
      return oneLine(pick('file_path'));
    case 'Grep':
      return oneLine([pick('pattern'), pick('path')].filter(Boolean).join('  in  '));
    case 'Glob':
      return oneLine(pick('pattern'));
    case 'Task':
    case 'Agent':
      return oneLine(pick('description') || pick('prompt'));
    case 'WebFetch':
      return oneLine(pick('url'));
    case 'WebSearch':
      return oneLine(pick('query'));
    case 'TodoWrite':
      return 'update task list';
    default:
      return oneLine(JSON.stringify(i), 80);
  }
}

function resultPreview(content: unknown): string {
  if (typeof content === 'string') return oneLine(content, 400);
  if (Array.isArray(content)) return oneLine(textFromContent(content), 400);
  return '';
}

/**
 * Convert one transcript record into zero or more chat events.
 *
 * Sidechain records belong to subagents and would interleave confusingly with the
 * main thread, so they are dropped. Meta records and the wrapper text Claude Code
 * injects around local commands are dropped too.
 */
export function recordToEvents(rec: Record<string, unknown>): ChatEvent[] {
  const type = rec['type'];
  if (rec['isSidechain'] === true) return [];

  const ts = typeof rec['timestamp'] === 'string' ? Date.parse(rec['timestamp'] as string) : 0;
  const baseId = typeof rec['uuid'] === 'string' ? (rec['uuid'] as string) : `${type}-${ts}`;

  /*
   * Two sources of session name:
   *   ai-title      the auto-generated summary
   *   custom-title  what /rename set
   *
   * Claude Code writes BOTH on every turn, with ai-title *after* custom-title, so
   * "whichever is later in the file" would always discard the rename. A custom title
   * therefore outranks the automatic one regardless of position; `custom` carries
   * that so clients can apply the same rule to live events.
   */
  if (type === 'ai-title' || type === 'custom-title') {
    const raw = type === 'custom-title' ? rec['customTitle'] : rec['aiTitle'];
    if (typeof raw !== 'string' || !raw.trim()) return [];
    const title = raw.trim();
    const custom = type === 'custom-title';
    // ai-title/custom-title records carry neither uuid nor timestamp, so keying off
    // baseId gave every title the same id.
    return [{ kind: 'title', id: `title-${custom ? 'c' : 'a'}-${title}`, ts, title, custom }];
  }

  if (type !== 'user' && type !== 'assistant') return [];
  if (rec['isMeta'] === true) return [];

  const message = rec['message'] as Record<string, unknown> | undefined;
  if (!message) return [];
  const content = message['content'];
  const events: ChatEvent[] = [];

  if (type === 'user') {
    // A user record carrying tool_result blocks is Claude's own tool plumbing,
    // not something the human typed.
    if (Array.isArray(content)) {
      let idx = 0;
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b['type'] === 'tool_result' && typeof b['tool_use_id'] === 'string') {
          events.push({
            kind: 'tool_result',
            id: `${baseId}-r${idx++}`,
            ts,
            toolUseId: b['tool_use_id'] as string,
            ok: b['is_error'] !== true,
            preview: resultPreview(b['content']),
          });
        }
      }
      if (events.length > 0) return events;
    }
    const text = textFromContent(content);
    if (!text.trim() || isNoiseText(text)) return [];
    return [{ kind: 'user', id: baseId, ts, text: text.trim() }];
  }

  if (!Array.isArray(content)) {
    const text = textFromContent(content);
    return text.trim() ? [{ kind: 'assistant', id: baseId, ts, text: text.trim() }] : [];
  }

  let idx = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    const id = `${baseId}-${idx++}`;
    switch (b['type']) {
      case 'text': {
        const t = typeof b['text'] === 'string' ? (b['text'] as string) : '';
        if (t.trim()) events.push({ kind: 'assistant', id, ts, text: t.trim() });
        break;
      }
      case 'thinking':
        // Reasoning is not shown: the chat mirrors what a normal Claude Code
        // session prints, which is assistant text and tool calls.
        break;
      case 'tool_use': {
        const name = typeof b['name'] === 'string' ? (b['name'] as string) : 'tool';
        events.push({
          kind: 'tool',
          // Use the tool_use id so tool_result events can attach to this chip.
          id: typeof b['id'] === 'string' ? (b['id'] as string) : id,
          ts,
          name,
          summary: toolSummary(name, b['input']),
          input: b['input'],
        });
        break;
      }
      default:
        break;
    }
  }
  return events;
}

function unescapeJsonString(raw: string): string {
  try {
    // Re-parse so JSON escapes (\n, \", \uXXXX) come back as real characters.
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/**
 * The session's name, scanning the whole file.
 *
 * Titles are written rarely, so they usually fall outside the tail window that
 * everything else is read from — but the name is how a person recognises which
 * conversation they are looking at, so it is worth a dedicated scan. A `/rename`
 * (custom-title) always wins over the auto-generated ai-title.
 */
export interface TitlePair {
  /** Set by `/rename`. Outranks the automatic title wherever it appears. */
  custom: string | null;
  /** The generated summary. */
  ai: string | null;
}

/**
 * Both kinds of title, scanned over the whole file, reported separately.
 *
 * Returning them apart rather than collapsed matters: the caller has to know *which*
 * kind it got, or it cannot tell the client whether the name was chosen or generated —
 * and without that the client happily overwrites a rename with the next `ai-title` it
 * sees. An earlier version returned a single string and did exactly that.
 *
 * Two greps over the file, ~35 ms on a 16 MB transcript, behind a 4-second list cache.
 */
export async function readTitlePair(exec: Executor, path: string): Promise<TitlePair> {
  const { stdout } = await exec.runShell(
    `grep -o '"customTitle":"[^"]*"' ${q(path)} 2>/dev/null | tail -1; ` +
      `grep -o '"aiTitle":"[^"]*"' ${q(path)} 2>/dev/null | tail -1`,
  );
  const custom = /"customTitle":"(.*)"/.exec(stdout);
  const ai = /"aiTitle":"(.*)"/.exec(stdout);
  return {
    custom: custom?.[1] ? unescapeJsonString(custom[1]) : null,
    ai: ai?.[1] ? unescapeJsonString(ai[1]) : null,
  };
}

/** A single resolved name, for callers that do not care where it came from. */
export async function readLastTitle(exec: Executor, path: string): Promise<string | null> {
  const { custom, ai } = await readTitlePair(exec, path);
  return custom ?? ai;
}

export interface TranscriptSummary {
  /** Resolved name: a `/rename` if there is one, otherwise the automatic title. */
  aiTitle: string | null;
  /** Set only by `/rename`; takes precedence over the automatic title. */
  customTitle: string | null;
  lastUserText: string | null;
  lastAssistantText: string | null;
  lastEventTs: number;
}

export function summarise(records: readonly Record<string, unknown>[]): TranscriptSummary {
  let autoTitle: string | null = null;
  let customTitle: string | null = null;
  let lastUserText: string | null = null;
  let lastAssistantText: string | null = null;
  let lastEventTs = 0;

  for (const rec of records) {
    for (const ev of recordToEvents(rec)) {
      if (ev.ts > lastEventTs) lastEventTs = ev.ts;
      if (ev.kind === 'title') {
        if (ev.custom) customTitle = ev.title;
        else autoTitle = ev.title;
      } else if (ev.kind === 'user') lastUserText = ev.text;
      else if (ev.kind === 'assistant') lastAssistantText = ev.text;
    }
  }
  return {
    aiTitle: customTitle ?? autoTitle,
    customTitle,
    lastUserText,
    lastAssistantText,
    lastEventTs,
  };
}

/* ---------- pane → transcript inference ---------- */

/** Birth time within this many seconds of process start counts as a match. */
const BIRTH_TOLERANCE_S = 120;
/** Only the most recent transcripts in a project are worth content-checking. */
const MAX_CANDIDATES = 6;
/**
 * Transcripts below this size are almost always abandoned stubs — a session that
 * started and was immediately `/resume`d into a different one. Never prefer one as
 * a fallback while a substantial transcript is available.
 */
const STUB_BYTES = 8_192;
/** Transcript modified this recently means the session is mid-turn. */
const WORKING_WINDOW_MS = 15_000;
/** Slack between `stat` mtime and `ps` start time when deciding "written since". */
const WRITE_SLACK_S = 5;

/** Spinner glyphs Claude Code prefixes onto the terminal title while it works. */
const TITLE_GLYPHS = /^[\s✳✻✽✢·◐◑◒◓●○◔◕*]+/u;

export function stripGlyph(title: string): string {
  return title.replace(TITLE_GLYPHS, '').trim();
}

/**
 * Identity for a pane whose session has not written a transcript yet. Kept free of
 * `%` and `:` so it survives a URL path unescaped, as real uuids do.
 */
function pendingId(paneId: string): string {
  return `pane-${paneId.replace('%', '')}`;
}

interface Entry {
  pane: PaneInfo;
  proc: AgentProc;
}

/**
 * Does this transcript's recent text appear on the pane's screen?
 *
 * Compared with all non-alphanumerics stripped, because the TUI hard-wraps lines
 * and decorates them. Several windows are tried since a long message may be only
 * partly on screen.
 */
function contentMatches(paneNorm: string, summary: TranscriptSummary): boolean {
  const texts = [summary.lastAssistantText, summary.lastUserText].filter(
    (t): t is string => typeof t === 'string',
  );
  for (const text of texts) {
    const norm = normaliseForMatch(text);
    if (norm.length < 24) continue;
    const windows = [
      norm.slice(0, 60),
      norm.slice(-60),
      norm.slice(Math.max(0, Math.floor(norm.length / 2) - 30), Math.floor(norm.length / 2) + 30),
    ];
    for (const w of windows) {
      if (w.length >= 20 && paneNorm.includes(w)) return true;
    }
  }
  return false;
}

async function capturePanes(
  exec: Executor,
  paneIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (paneIds.length === 0) return out;

  const script = paneIds
    .map(
      (id) =>
        `echo "###C${id.replace('%', '')}"; tmux capture-pane -p -S -300 -t ${q(id)} 2>/dev/null || true`,
    )
    .join('\n');
  const { stdout } = await exec.runShell(script);

  let current: string | null = null;
  const buf: string[] = [];
  const flush = () => {
    if (current) out.set(current, buf.join('\n'));
    buf.length = 0;
  };
  for (const line of stdout.split('\n')) {
    if (line.startsWith('###C')) {
      flush();
      current = `%${line.slice(4).trim()}`;
    } else if (current) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

interface Resolution {
  uuid: string;
  transcript: string;
  confidence: MatchConfidence;
}

/**
 * Resolve every pane sharing a project directory at once, assigning each transcript
 * to at most one pane. Doing them independently would hand two panes in the same
 * repo the same "most recent" transcript.
 */
async function resolveGroup(
  exec: Executor,
  serverId: string,
  home: string,
  entries: readonly Entry[],
): Promise<Map<string, Resolution>> {
  const result = new Map<string, Resolution>();
  const first = entries[0];
  if (!first) return result;

  const taken = new Set<string>();
  const pending: Entry[] = [];

  // Sessions we launched, and panes resolved before, need no inference. This is
  // checked before the transcripts are even listed, because a session created with
  // --session-id is known exactly yet has no transcript until its first message.
  for (const entry of entries) {
    const cached = getMapping(serverId, entry.proc.paneId, entry.proc.pid);
    if (cached) {
      result.set(entry.proc.paneId, {
        uuid: cached.uuid,
        transcript: cached.transcript,
        confidence: cached.confidence,
      });
      taken.add(cached.transcript);
    } else {
      pending.push(entry);
    }
  }
  if (pending.length === 0) return result;

  const dir = projectDirFor(home, first.proc.cwd);
  const all = await listTranscripts(exec, dir);
  const candidates = all.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_CANDIDATES);
  if (candidates.length === 0) return result;

  const captures = await capturePanes(exec, pending.map((e) => e.proc.paneId));
  const normByPane = new Map<string, string>();
  for (const entry of pending) {
    normByPane.set(entry.proc.paneId, normaliseForMatch(captures.get(entry.proc.paneId) ?? ''));
  }

  // Read each candidate once; content-matching is the expensive part.
  const summaries = new Map<string, TranscriptSummary>();
  for (const cand of candidates) {
    if (taken.has(cand.path)) continue;
    try {
      summaries.set(cand.path, summarise(await readRecords(exec, cand.path, 60_000)));
    } catch (err) {
      console.error(`[claude] cannot read ${cand.path}:`, err);
    }
  }

  const birthDelta = (entry: Entry, cand: Candidate): number =>
    cand.birth > 0 ? Math.abs(cand.birth - entry.proc.startEpoch) : Infinity;

  interface Pair {
    entry: Entry;
    cand: Candidate;
    content: boolean;
    delta: number;
  }
  const pairs: Pair[] = [];
  for (const entry of pending) {
    for (const cand of candidates) {
      if (taken.has(cand.path)) continue;
      const summary = summaries.get(cand.path);
      pairs.push({
        entry,
        cand,
        content: summary ? contentMatches(normByPane.get(entry.proc.paneId) ?? '', summary) : false,
        delta: birthDelta(entry, cand),
      });
    }
  }

  const assigned = new Set<string>();
  const assign = (pair: Pair, confidence: MatchConfidence, allowShared = false) => {
    if (assigned.has(pair.entry.proc.paneId)) return;
    if (!allowShared && taken.has(pair.cand.path)) return;
    assigned.add(pair.entry.proc.paneId);
    taken.add(pair.cand.path);
    const resolution: Resolution = {
      uuid: pair.cand.uuid,
      transcript: pair.cand.path,
      confidence,
    };
    result.set(pair.entry.proc.paneId, resolution);
    // Only cache confident matches. Caching a guess would make it permanent.
    if (confidence !== 'weak') {
      putMapping(serverId, pair.entry.proc.paneId, pair.entry.proc.pid, resolution);
    }
  };

  // Born with the process *and* visible on its screen — as certain as inference gets.
  for (const p of pairs.filter((p) => p.content && p.delta <= BIRTH_TOLERANCE_S)) assign(p, 'exact');
  // Birth time is a precise, mechanical signal (observed within 5s), so it outranks
  // the fuzzy screen match. Trusting content first let one pane steal another's
  // transcript on a single coincidental line.
  for (const p of pairs.filter((p) => p.delta <= BIRTH_TOLERANCE_S).sort((a, b) => a.delta - b.delta)) {
    assign(p, 'strong');
  }
  // On screen only — the one signal that survives `--resume` into an older transcript.
  for (const p of pairs.filter((p) => p.content)) assign(p, 'strong');

  // Nothing matched. Guess, but never at the cost of picking an abandoned stub, and
  // allow two panes to share a transcript: after a `/resume` that is the truth.
  //
  // Only transcripts *written since this process started* are eligible. A file the
  // pane is writing must have been touched after the pane's claude began, so an older
  // one cannot be its conversation. Without this filter a freshly opened session —
  // which has no transcript at all until its first message — inherited the previous
  // conversation in the same repo, its name and its whole history along with it.
  for (const entry of pending) {
    if (assigned.has(entry.proc.paneId)) continue;
    const live = candidates.filter((c) => c.mtime >= entry.proc.startEpoch - WRITE_SLACK_S);
    const cand =
      live.find((c) => !taken.has(c.path) && c.size >= STUB_BYTES) ??
      live.find((c) => c.size >= STUB_BYTES) ??
      live.find((c) => !taken.has(c.path)) ??
      live[0];
    // No plausible transcript: leave the pane unresolved. Discovery still lists it,
    // as a session with no messages yet, which is the truth and is sendable.
    if (cand) assign({ entry, cand, content: false, delta: Infinity }, 'weak', true);
  }

  return result;
}

const COMMS = ['claude'] as const;

async function discover(exec: Executor, serverId: string, p: Probe): Promise<SessionInfo[]> {
  const etimesByPid = new Map(p.ps.map((r) => [r.pid, r.etimes]));

  const paneByAgentPid = new Map<number, PaneInfo>();
  for (const pane of p.panes) {
    const agent = findAgentInPane(pane, p.ps, COMMS);
    if (agent) paneByAgentPid.set(agent.pid, pane);
  }

  const procs = await enrichAgentProcs(exec, [...paneByAgentPid.keys()], p.now, etimesByPid);

  // TMUX_PANE from the process itself is authoritative; prefer it over the tree walk.
  const entries: Entry[] = [];
  for (const proc of procs) {
    const pane = p.panes.find((x) => x.paneId === proc.paneId) ?? paneByAgentPid.get(proc.pid);
    if (pane) entries.push({ pane, proc });
  }

  pruneMappings(
    new Set(entries.map((e) => liveMappingKey(serverId, e.proc.paneId, e.proc.pid))),
  );

  const byCwd = new Map<string, Entry[]>();
  for (const entry of entries) {
    const list = byCwd.get(entry.proc.cwd);
    if (list) list.push(entry);
    else byCwd.set(entry.proc.cwd, [entry]);
  }

  const resolutions = new Map<string, Resolution>();
  for (const group of byCwd.values()) {
    try {
      for (const [paneId, res] of await resolveGroup(exec, serverId, p.home, group)) {
        resolutions.set(paneId, res);
      }
    } catch (err) {
      console.error('[claude] group resolution failed:', err);
    }
  }

  const sessions: SessionInfo[] = [];
  for (const entry of entries) {
    const res = resolutions.get(entry.proc.paneId);

    let lastActivity: number | null = null;
    let lastMessage: string | null = null;
    // A fresh session's pane title is just "Claude Code" until it earns an ai-title;
    // the repo name is far more useful in a list of sessions.
    const paneTitle = stripGlyph(entry.pane.title);
    const repo = entry.proc.cwd.split('/').filter(Boolean).pop() ?? 'session';
    let title = !paneTitle || /^claude(\s+code)?$/i.test(paneTitle) ? repo : paneTitle;
    let titleIsCustom = false;
    if (res) {
      try {
        const records = await readRecords(exec, res.transcript, 60_000);
        const s = summarise(records);
        /*
         * A whole-file scan whenever the tail shows no rename.
         *
         * The old condition only fell back when the tail had *no* title at all, so a
         * rename older than the 60 KB window lost to the `ai-title` Claude Code writes
         * on every turn, and was simply invisible.
         */
        const scan = s.customTitle ? null : await readTitlePair(exec, res.transcript);
        const custom = s.customTitle ?? scan?.custom ?? null;
        const resolved = custom ?? s.aiTitle ?? scan?.ai ?? null;
        if (resolved) title = resolved;
        titleIsCustom = custom !== null;
        lastMessage = s.lastAssistantText ?? s.lastUserText ?? null;
        lastActivity = s.lastEventTs || null;
      } catch (err) {
        console.error(`[claude] summary failed for ${res.transcript}:`, err);
      }
    }

    // A name given from this app outranks anything in the transcript: it is the most
    // recent explicit statement of what the session is called.
    const given = getName(serverId, res?.uuid ?? pendingId(entry.proc.paneId), entry.proc.paneId);
    if (given) {
      title = given;
      titleIsCustom = true;
    }

    const created = res ? getCreated(res.uuid) : undefined;
    const age = lastActivity ? Date.now() - lastActivity : Infinity;

    sessions.push({
      serverId,
      provider: 'claude',
      // A pane with no transcript yet still needs a stable, URL-safe id to be
      // addressed by — it must be sendable, since that first message is what
      // creates the transcript.
      uuid: res?.uuid ?? pendingId(entry.proc.paneId),
      transcript: res?.transcript ?? '',
      paneId: entry.proc.paneId,
      tmuxSession: entry.pane.tmuxSession,
      pid: entry.proc.pid,
      cwd: entry.proc.cwd,
      isRepo: false, // filled in by the orchestrator, which batches the test
      title,
      titleIsCustom,
      status: age < WORKING_WINDOW_MS ? 'working' : 'idle',
      confidence: res?.confidence ?? 'pending',
      lastActivity,
      lastMessage: lastMessage ? lastMessage.replace(/\s+/g, ' ').slice(0, 160) : null,
      skipPermissions: created ? created.skipPermissions : null,
    });
  }
  return sessions;
}

/* ---------- correcting a bad match ---------- */

/** Locate a pane and its claude process, for the manual-binding endpoints. */
async function locatePane(
  exec: Executor,
  paneId: string,
): Promise<{ pane: PaneInfo; proc: AgentProc; home: string }> {
  const { probe } = await import('../proc.js');
  const p = await probe(exec);
  const pane = p.panes.find((x) => x.paneId === paneId);
  if (!pane) throw new Error(`no such pane: ${paneId}`);
  const agent = findAgentInPane(pane, p.ps, COMMS);
  if (!agent) throw new Error(`pane ${paneId} is not running a Claude session`);
  const etimes = new Map(p.ps.map((r) => [r.pid, r.etimes]));
  const [proc] = await enrichAgentProcs(exec, [agent.pid], p.now, etimes);
  if (!proc) throw new Error(`cannot inspect the claude process in ${paneId}`);
  return { pane, proc, home: p.home };
}

export interface CandidateInfo {
  uuid: string;
  transcript: string;
  size: number;
  lastActivity: number | null;
  title: string | null;
  lastMessage: string | null;
}

/**
 * Every transcript in this pane's project, so the user can correct a bad match.
 *
 * Inference cannot be made reliable for sessions this app did not launch: a session
 * can be resumed into an older transcript, cleared into a new one, or have its model
 * switched mid-conversation, and a transcript's writing process changes over its
 * life. A two-tap manual override is the honest answer.
 *
 * Codex needs none of this, which is why it lives here rather than in shared code.
 */
export async function listPaneCandidates(
  exec: Executor,
  paneId: string,
): Promise<CandidateInfo[]> {
  const { proc, home } = await locatePane(exec, paneId);
  const dir = projectDirFor(home, proc.cwd);
  const all = (await listTranscripts(exec, dir)).sort((a, b) => b.mtime - a.mtime);

  const out: CandidateInfo[] = [];
  for (const cand of all.slice(0, 12)) {
    let title: string | null = null;
    let lastMessage: string | null = null;
    let lastActivity: number | null = null;
    try {
      const s = summarise(await readRecords(exec, cand.path, 40_000));
      title = s.aiTitle ?? (await readLastTitle(exec, cand.path));
      lastMessage = (s.lastAssistantText ?? s.lastUserText ?? '').replace(/\s+/g, ' ').slice(0, 140) || null;
      lastActivity = s.lastEventTs || cand.mtime * 1000;
    } catch {
      lastActivity = cand.mtime * 1000;
    }
    out.push({
      uuid: cand.uuid,
      transcript: cand.path,
      size: cand.size,
      lastActivity,
      title,
      lastMessage,
    });
  }
  return out;
}

/** Pin a pane to a transcript the user picked. Persisted, and treated as exact. */
export async function bindPane(
  exec: Executor,
  serverId: string,
  paneId: string,
  transcriptUuid: string,
): Promise<{ uuid: string; transcript: string }> {
  const { proc, home } = await locatePane(exec, paneId);
  const dir = projectDirFor(home, proc.cwd);
  const match = (await listTranscripts(exec, dir)).find((c) => c.uuid === transcriptUuid);
  if (!match) throw new Error(`no transcript ${transcriptUuid} in ${dir}`);

  putMapping(serverId, proc.paneId, proc.pid, {
    uuid: match.uuid,
    transcript: match.path,
    confidence: 'exact',
  });
  return { uuid: match.uuid, transcript: match.path };
}

/* ---------- creating a session ---------- */

/**
 * Claude Code asks whether a directory is trusted the first time it opens one, and
 * `--dangerously-skip-permissions` does not skip it.
 */
const TRUST_PROMPT = /Is this a project you created or one you trust|Yes, I trust this folder/i;
const READY_HINT = /❯|for shortcuts|Try "how do I/;

/**
 * Start a session with a pre-generated uuid.
 *
 * `--session-id` is what makes anything this app launches exempt from the inference
 * above: the pane→transcript mapping is known from birth.
 */
async function create(
  exec: Executor,
  serverId: string,
  dir: string,
  bypass: boolean,
): Promise<CreateResult> {
  // Absolute path for the same reason as Codex: an nvm-installed `claude` is on the
  // hub's PATH only by luck. It happens to be in /usr/local/bin on this host, which is
  // precisely why this hazard stayed hidden until a second agent arrived.
  const bin = await resolveBinary(exec, 'claude', [
    '"$HOME"/.local/bin/claude',
    '"$HOME"/.nvm/versions/node/*/bin/claude',
  ]);
  if (!bin) {
    throw new Error(
      'claude is not installed, or its binary could not be found (looked on PATH, ' +
        'in ~/.local/bin and under ~/.nvm)',
    );
  }

  const uuid = randomUUID();
  const name = tmuxSafeName(dir, uuid);
  const inner =
    `${q(bin)} --session-id ${uuid}` + (bypass ? ' --dangerously-skip-permissions' : '');

  const spec = {
    dir,
    name,
    inner,
    trustPrompt: TRUST_PROMPT,
    readyHint: READY_HINT,
    comms: COMMS,
  };
  const { paneId, proc, home } = await launchInTmux(exec, spec);
  const transcript = `${projectDirFor(home, dir)}/${uuid}.jsonl`;

  if (proc) {
    putMapping(serverId, proc.paneId, proc.pid, { uuid, transcript, confidence: 'exact' });
  }

  recordCreated({
    uuid,
    serverId,
    dir,
    tmuxSession: name,
    createdAt: Date.now(),
    skipPermissions: bypass,
  });

  const startup = paneId
    ? await settleStartup(
        exec,
        paneId,
        spec,
        async () => (await exec.run(['test', '-f', transcript])).code === 0,
      )
    : { transcriptReady: false, ready: false, trustPromptAnswered: false };

  return { uuid, tmuxSession: name, paneId, transcript, dir, ...startup };
}

export const claudeProvider: Provider = {
  id: 'claude',
  label: 'claude',
  comms: COMMS,
  // Escape clears Claude Code's prompt.
  clearKey: 'Escape',
  exitCommand: '/exit',

  async available(exec: Executor, home: string): Promise<boolean> {
    // The projects directory means Claude Code has run here at least once, which is a
    // better signal than PATH: it is nvm-installed and absent from a non-interactive
    // login shell's PATH, so `command -v` reports MISSING on a machine using it daily.
    const { code } = await exec.runShell(
      `command -v claude >/dev/null 2>&1 || [ -d ${q(`${home}/.claude/projects`)} ] ` +
        `|| ls ${q(home)}/.nvm/versions/node/*/bin/claude >/dev/null 2>&1`,
    );
    return code === 0;
  },

  discover,
  toEvents: recordToEvents,

  detail(exec: Executor, session: SessionInfo): Promise<SessionDetail> {
    return claudeDetail(exec, session);
  },

  create,

  commands(exec: Executor, home: string, cwd: string | null): Promise<CommandCatalogue> {
    return listCommands(exec, home, cwd);
  },
};
