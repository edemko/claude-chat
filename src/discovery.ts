/**
 * Discovery: every agent session running on a machine, whichever agent it is.
 *
 * This file does the part that is genuinely shared. Each provider is asked for its
 * own sessions from **one** process probe — panes and the process table are read once
 * no matter how many providers are installed — and what comes back is merged,
 * annotated and sorted here.
 *
 * The per-provider hard parts live in `providers/`: Claude Code has to infer which
 * transcript a pane is writing, Codex reads it off a file descriptor. Nothing above
 * this layer needs to know which.
 */

import type { Executor } from './exec.js';
import { probe } from './proc.js';
import { availableProviders, providerFor, PROVIDERS } from './providers/index.js';
import { q } from './shell.js';
import type { MatchConfidence, ProviderId, SessionInfo } from './types.js';

export { listPaneCandidates, bindPane, type CandidateInfo } from './providers/claude.js';

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

export async function listSessions(exec: Executor, serverId: string): Promise<SessionInfo[]> {
  const p = await probe(exec);
  const installed = new Set(await availableProviders(exec, p.home));

  /*
   * Every installed provider is asked, in parallel, off the same probe. A provider
   * that throws is logged and skipped rather than taking the whole list down with it:
   * one agent's discovery failing must not hide the other agent's sessions.
   */
  const results = await Promise.all(
    PROVIDERS.filter((provider) => installed.has(provider.id)).map(async (provider) => {
      try {
        return await provider.discover(exec, serverId, p);
      } catch (err) {
        console.error(`[discovery] ${provider.id} discovery failed:`, err);
        return [] as SessionInfo[];
      }
    }),
  );

  const sessions = results.flat();

  // One batched test for every distinct cwd across all providers.
  const repos = await repoDirs(exec, [...new Set(sessions.map((s) => s.cwd))]);
  for (const session of sessions) session.isRepo = repos.has(session.cwd);

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
 * conversation. Nor are sessions from different providers, which cannot share a file.
 */
export function dedupeByTranscript(sessions: readonly SessionInfo[]): SessionInfo[] {
  const best = new Map<string, SessionInfo>();
  const kept: SessionInfo[] = [];

  for (const session of sessions) {
    if (!session.transcript) {
      kept.push(session);
      continue;
    }
    const key = `${session.provider}:${session.transcript}`;
    const rival = best.get(key);
    if (!rival) {
      best.set(key, session);
      continue;
    }
    const better =
      CONFIDENCE_RANK[session.confidence] > CONFIDENCE_RANK[rival.confidence] ||
      (session.confidence === rival.confidence && session.pid > rival.pid);
    if (better) best.set(key, session);
  }

  kept.push(...best.values());
  kept.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  return kept;
}

/** Per-provider counts for the client's filter chips. */
export function countByProvider(sessions: readonly SessionInfo[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sessions) out[s.provider] = (out[s.provider] ?? 0) + 1;
  return out;
}

export { providerFor };
export type { ProviderId };
