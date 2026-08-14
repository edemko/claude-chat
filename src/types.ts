/** Which coding agent a session is running. */
export type ProviderId = 'claude' | 'codex';

export interface ServerConfig {
  id: string;
  label: string;
  kind: 'local' | 'ssh';
  /** ssh only: hostname or ~/.ssh/config alias. */
  host?: string;
}

/** A tmux pane as reported by `tmux list-panes`. */
export interface PaneInfo {
  paneId: string;          // stable `%N` id — always address panes by this
  panePid: number;         // the pane's shell, not the agent process
  cwd: string;
  title: string;
  tmuxSession: string;
  windowIndex: string;
  paneIndex: string;
  currentCommand: string;
}

/**
 * An agent process located inside a pane.
 *
 * `openFiles` matters for Codex, which holds its own transcript open — that one fd
 * turns pane→session from an inference problem into a lookup. Claude Code holds
 * nothing open, so it stays empty there.
 */
export interface AgentProc {
  pid: number;
  startEpoch: number;      // seconds since epoch, derived from `ps -o etimes`
  paneId: string;          // from the process's own TMUX_PANE
  cwd: string;             // from /proc/<pid>/cwd
  /** Open file paths matching the provider's transcript pattern, if it holds any. */
  openFiles: string[];
}

export type SessionStatus = 'working' | 'idle' | 'unknown';

/**
 * How confidently the transcript was matched to the pane.
 *
 * `pending`: the pane is running an agent but no transcript exists yet.
 * Codex only ever produces `exact` or `pending` — it holds its transcript open, so
 * there is nothing to infer. The middle two exist for Claude Code, which does not.
 */
export type MatchConfidence = 'exact' | 'strong' | 'weak' | 'pending';

export interface SessionInfo {
  serverId: string;
  provider: ProviderId;
  uuid: string;
  transcript: string;
  paneId: string;
  tmuxSession: string;
  pid: number;
  cwd: string;
  /** cwd holds a `.git`, so the session is working in a repo rather than a folder. */
  isRepo: boolean;
  title: string;
  status: SessionStatus;
  confidence: MatchConfidence;
  lastActivity: number | null;   // epoch ms of transcript mtime
  lastMessage: string | null;
  /**
   * Whether the session was launched with approvals bypassed. null when the session
   * predates this app, or when the provider does not record it.
   */
  skipPermissions: boolean | null;
}

export type ChatEvent =
  | { kind: 'user'; id: string; ts: number; text: string }
  | { kind: 'assistant'; id: string; ts: number; text: string }
  | { kind: 'tool'; id: string; ts: number; name: string; summary: string; input: unknown }
  | { kind: 'tool_result'; id: string; ts: number; toolUseId: string; ok: boolean; preview: string }
  | { kind: 'title'; id: string; ts: number; title: string; custom: boolean }
  | { kind: 'system'; id: string; ts: number; text: string };

/** Anything in a transcript that becomes chat events. */
export type ToEvents = (rec: Record<string, unknown>) => ChatEvent[];

export interface SessionDetail {
  /**
   * Rendered status line as it appears in the pane, one entry per line. Empty for
   * providers that publish the same numbers as data — there is nothing to scrape.
   */
  statusLine: string[];
  model: string | null;
  effort: string | null;
  version: string | null;
  gitBranch: string | null;
  /** Tokens in the *current* context — not the session's cumulative usage. */
  contextTokens: number | null;
  /** Size of the model's context window, when the provider states it. */
  contextWindow: number | null;
  outputTokens: number | null;
  turns: { user: number; assistant: number; tools: number };
  startedAt: number | null;
  transcriptBytes: number | null;
  /** Seconds the agent process has been running. */
  uptimeSeconds: number | null;
  /** Free-form provider extras for the ⓘ sheet, e.g. rate limits or plan mode. */
  extra: { label: string; value: string }[];
}

export interface CreateResult {
  uuid: string;
  tmuxSession: string;
  paneId: string | null;
  transcript: string;
  dir: string;
  transcriptReady: boolean;
  ready: boolean;
  trustPromptAnswered: boolean;
}

export type WsMessage =
  | { type: 'events'; sessionUuid: string; events: ChatEvent[] }
  | { type: 'sessions'; sessions: SessionInfo[]; home: string }
  | { type: 'error'; message: string };
