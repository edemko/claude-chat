import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CC_DIR, REGISTRY_PATH } from './config.js';
import type { MatchConfidence } from './types.js';

interface CreatedEntry {
  uuid: string;
  serverId: string;
  dir: string;
  tmuxSession: string;
  createdAt: number;
  skipPermissions: boolean;
}

interface MappingEntry {
  uuid: string;
  transcript: string;
  confidence: MatchConfidence;
  resolvedAt: number;
}

interface RegistryShape {
  /** Sessions this app launched — their uuid is known exactly, never inferred. */
  created: Record<string, CreatedEntry>;
  /** Cache of resolved pane→transcript mappings, keyed by server:pane:procStart. */
  mappings: Record<string, MappingEntry>;
  /**
   * Names given to sessions from this app.
   *
   * Held here rather than pushed into the agent because the two agents disagree about
   * where a name lives: Claude Code's `/rename` writes a `custom-title` record into the
   * transcript, while Codex's writes only to its SQLite index and leaves the transcript
   * byte-identical. A name stored here works the same for both, takes effect at once,
   * and needs nothing installed to read back.
   */
  names: Record<string, string>;
}

const EMPTY: RegistryShape = { created: {}, mappings: {}, names: {} };

function load(): RegistryShape {
  if (!existsSync(REGISTRY_PATH)) return structuredClone(EMPTY);
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as Partial<RegistryShape>;
    return {
      created: parsed.created ?? {},
      mappings: parsed.mappings ?? {},
      names: parsed.names ?? {},
    };
  } catch (err) {
    console.error('[registry] unreadable, starting fresh:', err);
    return structuredClone(EMPTY);
  }
}

let state: RegistryShape = load();

/** Atomic write so a crash mid-save cannot truncate the registry. */
function persist(): void {
  if (!existsSync(CC_DIR)) mkdirSync(CC_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${REGISTRY_PATH}.tmp`;
  if (!existsSync(dirname(REGISTRY_PATH))) mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, REGISTRY_PATH);
}

/**
 * The claude pid is part of the key so a restarted session in the same pane, or a
 * recycled pane id, cannot inherit a stale mapping. pid is used rather than the
 * process start time because start time is derived from whole-second `etimes` and
 * jitters by a second between calls, which silently broke cache lookups.
 */
function mappingKey(serverId: string, paneId: string, pid: number): string {
  return `${serverId}:${paneId}:${pid}`;
}

export function getMapping(
  serverId: string,
  paneId: string,
  pid: number,
): MappingEntry | undefined {
  return state.mappings[mappingKey(serverId, paneId, pid)];
}

export function putMapping(
  serverId: string,
  paneId: string,
  pid: number,
  entry: Omit<MappingEntry, 'resolvedAt'>,
): void {
  state.mappings[mappingKey(serverId, paneId, pid)] = { ...entry, resolvedAt: Date.now() };
  persist();
}

export function recordCreated(entry: CreatedEntry): void {
  state.created[entry.uuid] = entry;
  persist();
}

export function getCreated(uuid: string): CreatedEntry | undefined {
  return state.created[uuid];
}

/** Drop mapping cache entries for panes that no longer exist. */
export function pruneMappings(liveKeys: Set<string>): void {
  let changed = false;
  for (const key of Object.keys(state.mappings)) {
    if (!liveKeys.has(key)) {
      delete state.mappings[key];
      changed = true;
    }
  }
  if (changed) persist();
}

export function liveMappingKey(serverId: string, paneId: string, pid: number): string {
  return mappingKey(serverId, paneId, pid);
}

/* ---------- names given from this app ---------- */

const nameKey = (serverId: string, key: string): string => `${serverId}:${key}`;

/**
 * Look up a name by session uuid, then by pane.
 *
 * Both keys are written on rename, because a session's uuid is not stable across its
 * whole life: one that has never been spoken to has no transcript and therefore no
 * real uuid, and it gains one the moment its first message lands. Keying on the pane
 * as well is what carries a name across that transition — and across a `/clear`,
 * which swaps the uuid under the same pane.
 */
export function getName(serverId: string, uuid: string, paneId: string): string | undefined {
  return state.names[nameKey(serverId, uuid)] ?? state.names[nameKey(serverId, `pane:${paneId}`)];
}

export function setName(
  serverId: string,
  uuid: string,
  paneId: string,
  name: string | null,
): void {
  const keys = [nameKey(serverId, uuid), nameKey(serverId, `pane:${paneId}`)];
  for (const key of keys) {
    if (name) state.names[key] = name;
    else delete state.names[key];
  }
  persist();
}

export function reload(): void {
  state = load();
}
