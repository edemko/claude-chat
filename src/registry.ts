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
}

const EMPTY: RegistryShape = { created: {}, mappings: {} };

function load(): RegistryShape {
  if (!existsSync(REGISTRY_PATH)) return structuredClone(EMPTY);
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as Partial<RegistryShape>;
    return { created: parsed.created ?? {}, mappings: parsed.mappings ?? {} };
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

export function reload(): void {
  state = load();
}
