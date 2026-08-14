import type { Executor } from './exec.js';
import { enrichClaudeProcs, findClaudeInPane, probe } from './proc.js';
import { getCreated, getMapping, liveMappingKey, pruneMappings, putMapping } from './registry.js';
import { normaliseForMatch, q } from './shell.js';
import {
  listTranscripts,
  projectDirFor,
  readLastTitle,
  readRecords,
  summarise,
  type Candidate,
  type TranscriptSummary,
} from './transcript.js';
import type { ClaudeProc, MatchConfidence, PaneInfo, SessionInfo } from './types.js';

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
  proc: ClaudeProc;
}

/**
 * Which of these directories are git repos, in one round trip.
 *
 * `-e` rather than `-d`: inside a worktree or a submodule, `.git` is a file pointing
 * at the real directory, and testing for a directory would call those plain folders.
 */
async function repoDirs(exec: Executor, dirs: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (dirs.length === 0) return out;
  const script = `${dirs.map((d) => `[ -e ${q(d)}/.git ] && printf '%s\\n' ${q(d)}`).join('\n')}\ntrue`;
  try {
    const { stdout } = await exec.runShell(script, { timeoutMs: 10_000 });
    for (const line of stdout.split('\n')) {
      if (line.trim()) out.add(line.trim());
    }
  } catch (err) {
    // Not knowing costs a colour in the list, nothing more.
    console.error('[discovery] repo test failed:', err);
  }
  return out;
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
      console.error(`[discovery] cannot read ${cand.path}:`, err);
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
    // No plausible transcript: leave the pane unresolved. listSessions still lists it,
    // as a session with no messages yet, which is the truth and is sendable.
    if (cand) assign({ entry, cand, content: false, delta: Infinity }, 'weak', true);
  }

  return result;
}

export async function listSessions(exec: Executor, serverId: string): Promise<SessionInfo[]> {
  const p = await probe(exec);
  const etimesByPid = new Map(p.ps.map((r) => [r.pid, r.etimes]));

  const paneByClaudePid = new Map<number, PaneInfo>();
  for (const pane of p.panes) {
    const claude = findClaudeInPane(pane, p.ps);
    if (claude) paneByClaudePid.set(claude.pid, pane);
  }

  const procs = await enrichClaudeProcs(exec, [...paneByClaudePid.keys()], p.now, etimesByPid);

  // TMUX_PANE from the process itself is authoritative; prefer it over the tree walk.
  const entries: Entry[] = [];
  for (const proc of procs) {
    const pane = p.panes.find((x) => x.paneId === proc.paneId) ?? paneByClaudePid.get(proc.pid);
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

  const repos = await repoDirs(exec, [...byCwd.keys()]);

  const resolutions = new Map<string, Resolution>();
  for (const group of byCwd.values()) {
    try {
      for (const [paneId, res] of await resolveGroup(exec, serverId, p.home, group)) {
        resolutions.set(paneId, res);
      }
    } catch (err) {
      console.error('[discovery] group resolution failed:', err);
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
    if (res) {
      try {
        const records = await readRecords(exec, res.transcript, 60_000);
        const s = summarise(records);
        const aiTitle = s.aiTitle ?? (await readLastTitle(exec, res.transcript));
        if (aiTitle) title = aiTitle;
        lastMessage = s.lastAssistantText ?? s.lastUserText ?? null;
        lastActivity = s.lastEventTs || null;
      } catch (err) {
        console.error(`[discovery] summary failed for ${res.transcript}:`, err);
      }
    }

    const created = res ? getCreated(res.uuid) : undefined;
    const age = lastActivity ? Date.now() - lastActivity : Infinity;

    sessions.push({
      serverId,
      // A pane with no transcript yet still needs a stable, URL-safe id to be
      // addressed by — it must be sendable, since that first message is what
      // creates the transcript.
      uuid: res?.uuid ?? pendingId(entry.proc.paneId),
      transcript: res?.transcript ?? '',
      paneId: entry.proc.paneId,
      tmuxSession: entry.pane.tmuxSession,
      pid: entry.proc.pid,
      cwd: entry.proc.cwd,
      isRepo: repos.has(entry.proc.cwd),
      title,
      status: age < WORKING_WINDOW_MS ? 'working' : 'idle',
      confidence: res?.confidence ?? 'pending',
      lastActivity,
      lastMessage: lastMessage ? lastMessage.replace(/\s+/g, ' ').slice(0, 160) : null,
      skipPermissions: created ? created.skipPermissions : null,
    });
  }

  sessions.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  return dedupeByTranscript(sessions);
}

/** Ranking for which pane keeps a transcript when two claim it. */
const CONFIDENCE_RANK: Record<MatchConfidence, number> = {
  exact: 3,
  strong: 2,
  weak: 1,
  pending: 0,
};

/**
 * One transcript, one conversation — even when two panes resolve to it.
 *
 * That happens for real (`--resume` the same session in a second pane) and by
 * mis-resolution, and either way listing it twice produces two rows with the same
 * name and the same history, where sending to one is invisible in the other. The
 * better-evidenced pane wins, then the more recently started one, since that is the
 * pane the transcript is actually being written from.
 *
 * Sessions with no transcript are never folded together: each is its own empty
 * conversation.
 */
export function dedupeByTranscript(sessions: readonly SessionInfo[]): SessionInfo[] {
  const best = new Map<string, SessionInfo>();
  const kept: SessionInfo[] = [];

  for (const session of sessions) {
    if (!session.transcript) {
      kept.push(session);
      continue;
    }
    const rival = best.get(session.transcript);
    if (!rival) {
      best.set(session.transcript, session);
      continue;
    }
    const better =
      CONFIDENCE_RANK[session.confidence] > CONFIDENCE_RANK[rival.confidence] ||
      (session.confidence === rival.confidence && session.pid > rival.pid);
    if (better) best.set(session.transcript, session);
  }

  kept.push(...best.values());
  kept.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  return kept;
}

/** Locate a pane and its claude process, for the manual-binding endpoints. */
async function locatePane(
  exec: Executor,
  paneId: string,
): Promise<{ pane: PaneInfo; proc: ClaudeProc; home: string }> {
  const p = await probe(exec);
  const pane = p.panes.find((x) => x.paneId === paneId);
  if (!pane) throw new Error(`no such pane: ${paneId}`);
  const claude = findClaudeInPane(pane, p.ps);
  if (!claude) throw new Error(`pane ${paneId} is not running a Claude session`);
  const etimes = new Map(p.ps.map((r) => [r.pid, r.etimes]));
  const [proc] = await enrichClaudeProcs(exec, [claude.pid], p.now, etimes);
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
