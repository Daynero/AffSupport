import { useEffect, useRef, useState } from 'react';
import { isRequestAborted, TeamApiError, type DriveCatalogResyncResult } from '../../api/team';
import { TERMINAL_SYNC_STATES, type FolderSyncStatus } from '../syncStatus';

/**
 * Manual folder sync, browser side (028).
 *
 * The server owns the job; this hook owns the person's view of it. Every wait
 * here is bounded and every abort reaches the network, so a request that
 * hangs can never leave the button dead or the spinner on for good. A lost
 * answer is reported as exactly that — not as a failed scan — and the job id
 * is remembered per browser, so a second tab or a reload finds the same work
 * instead of starting a twin. Each click carries a key the server keeps, so
 * even a click whose answer was lost can be found again, and "Stop" acts on
 * that one request rather than on whatever job it happened to share.
 */

/** A request accepted, or refused, inside this: beyond it, "could not reach the server". */
export const ACCEPT_TIMEOUT_MS = 15_000;
/** One status read. The server job keeps running; only the watcher gives up. */
export const STATUS_TIMEOUT_MS = 15_000;
/** The final list refresh after the job succeeded. */
export const FINAL_REFRESH_TIMEOUT_MS = 30_000;
/** No change in the job's progress for this long is reported, not endured. */
export const STALL_TIMEOUT_MS = 10 * 60_000;
export const POLL_INTERVAL_MS = 5_000;

/** The browser asked, the server never answered: the job may or may not exist. */
const UNKNOWN_JOB = 'unknown';
const MEMORY_PREFIX = 'soty:folder-resync:';

export type FolderResyncOutcome =
  | 'succeeded'
  | 'failed'
  /** The accept call got no answer in time; the next click looks the job up first. */
  | 'unreachable'
  /** A status read failed or timed out; the server job continues. */
  | 'disconnected'
  /** The job reported no progress for STALL_TIMEOUT_MS. */
  | 'stalled'
  /** The job waits on something a person must fix; the status says what. */
  | 'blocked'
  /** This person's request was stopped and the job with it. */
  | 'canceled'
  /** This person's request was stopped; the job goes on for others. */
  | 'detached';

export interface FolderResyncLookup {
  syncJobId: string;
  state: string;
  createdAt: string;
}

export interface FolderResyncClient {
  resyncFolder?: (
    teamId: string,
    folderId: string,
    options?: { signal?: AbortSignal; requestKey?: string }
  ) => Promise<DriveCatalogResyncResult>;
  getFolderSyncStatus?: (
    teamId: string,
    jobId: string,
    options?: { signal?: AbortSignal }
  ) => Promise<FolderSyncStatus>;
  /** `folderId` null means the whole space. */
  findFolderSyncRequest?: (
    teamId: string,
    folderId: string | null,
    options?: { signal?: AbortSignal }
  ) => Promise<FolderResyncLookup | null>;
  findFolderSyncRequestByKey?: (
    teamId: string,
    requestKey: string,
    options?: { signal?: AbortSignal }
  ) => Promise<{ syncJobId: string; requestId: string; state: string } | null>;
  cancelFolderSync?: (
    teamId: string,
    requestId: string
  ) => Promise<{ jobState: string; requestOutcome: string }>;
}

function memoryKey(teamId: string, folderId: string): string {
  return `${MEMORY_PREFIX}${teamId}:${folderId}`;
}

function readMemory(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeMemory(key: string, value: string | null): void {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // A blocked storage API only limits recovery across tabs and reloads.
  }
}

/** Forgets every remembered job — on sign-out, so the next account starts clean. */
export function clearFolderResyncMemory(teamId?: string): void {
  try {
    const prefix = teamId ? memoryKey(teamId, '') : MEMORY_PREFIX;
    const doomed: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(prefix)) doomed.push(key);
    }
    for (const key of doomed) window.localStorage.removeItem(key);
  } catch {
    // Nothing remembered, nothing to forget.
  }
}

function newRequestKey(): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `web-${random}`;
}

/**
 * A signal that aborts when the parent does or when `ms` pass, on the window
 * timer so tests can drive it. `AbortSignal.timeout` runs on timers the fake
 * clock cannot see.
 */
function deadline(
  parent: AbortSignal | null,
  ms: number
): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), ms);
  const onParentAbort = () => controller.abort();
  parent?.addEventListener('abort', onParentAbort, { once: true });
  if (parent?.aborted) controller.abort();
  return {
    signal: controller.signal,
    clear: () => {
      window.clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    }
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = window.setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

function progressMark(status: FolderSyncStatus): string {
  return [
    status.state,
    status.phase,
    status.lastProgressAt ?? '',
    status.progressRevision,
    status.filesListed,
    status.foldersDone,
    status.pendingFolders ?? ''
  ].join('|');
}

/** A remembered job that ended longer ago than this is old news, not a result to report. */
const STALE_RESULT_MS = 10 * 60_000;

/** The job is gone or was never this scope's: forget it and start over on the next click. */
function isMissingJob(error: unknown): boolean {
  return (
    error instanceof TeamApiError &&
    (error.code === 'NOT_FOUND' || error.code === 'INVALID_RESPONSE')
  );
}

/** Poll only after an explicit click; no permanent workspace polling or Realtime dependency. */
export function useFolderResync(input: {
  teamId: string;
  folderId: string | null;
  /** Current folder and its ancestors, so an accepted parent scan stays visible inside a child. */
  scopeFolderIds?: readonly string[];
  client: FolderResyncClient;
  onComplete: () => Promise<void>;
  onOutcome: (outcome: FolderResyncOutcome) => void;
  /** Progress moved: a bounded chance to show what was written so far. */
  onProgress?: (status: FolderSyncStatus) => void;
}) {
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<FolderSyncStatus | null>(null);
  const active = useRef<AbortController | null>(null);
  const accepting = useRef(false);
  const acceptingFolderId = useRef<string | null>(null);
  const latest = useRef(input);
  latest.current = input;
  const scopeKey = (input.scopeFolderIds ?? (input.folderId ? [input.folderId] : [])).join('|');

  useEffect(() => {
    const { teamId, folderId, client } = input;
    const scope = input.scopeFolderIds ?? (folderId ? [folderId] : []);
    setRunning(
      Boolean(
        accepting.current && acceptingFolderId.current && scope.includes(acceptingFolderId.current)
      )
    );
    setStatus(null);
    // Deepest scope first: a folder's own job over an ancestor's, over the space's.
    const remembered = [...scope].reverse().find(id => {
      const value = readMemory(memoryKey(teamId, id));
      return value !== null && value !== UNKNOWN_JOB;
    });
    if (remembered && client.getFolderSyncStatus) {
      void monitor(remembered);
    }
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [input.teamId, input.folderId, scopeKey]);

  /** True while the job belongs to what the screen shows now. */
  const inScope = (teamId: string, scopeFolderId: string): boolean => {
    const current = latest.current;
    const scope = current.scopeFolderIds ?? (current.folderId ? [current.folderId] : []);
    return current.teamId === teamId && scope.includes(scopeFolderId);
  };

  const monitor = async (scopeFolderId: string, requestedJobId?: string) => {
    const { teamId, client } = input;
    if (active.current || !client.getFolderSyncStatus) return;
    const key = memoryKey(teamId, scopeFolderId);
    const jobId = requestedJobId ?? readMemory(key);
    const resumed = requestedJobId === undefined;
    if (!jobId || jobId === UNKNOWN_JOB) return;
    const controller = new AbortController();
    active.current = controller;
    setRunning(true);
    const report = (outcome: FolderResyncOutcome) => {
      if (!controller.signal.aborted && inScope(teamId, scopeFolderId)) {
        latest.current.onOutcome(outcome);
      }
    };
    const forget = () => {
      writeMemory(key, null);
      writeMemory(`${key}:request`, null);
      writeMemory(`${key}:key`, null);
    };
    let lastMark: string | null = null;
    let lastRevision: number | null = null;
    let lastChangeAt = Date.now();
    try {
      while (!controller.signal.aborted) {
        const read = deadline(controller.signal, STATUS_TIMEOUT_MS);
        let current: FolderSyncStatus;
        try {
          current = await client.getFolderSyncStatus(teamId, jobId, { signal: read.signal });
        } catch (error) {
          if (controller.signal.aborted) return;
          if (isMissingJob(error)) {
            forget();
            report('failed');
            return;
          }
          // A hung read, a dropped connection, an expired token: the job is
          // not known to have failed, so it is not reported as failed.
          report('disconnected');
          return;
        } finally {
          read.clear();
        }
        if (controller.signal.aborted) return;
        // Picked up from this browser's memory rather than started now, and long over: a scan
        // that failed or was stopped yesterday is not news on today's visit — and a later sync
        // may well have refreshed the folder since. Forget it without a panel or a toast.
        if (
          resumed &&
          lastRevision === null &&
          (current.state === 'failed' || current.state === 'canceled') &&
          current.completedAt &&
          Date.now() - Date.parse(current.completedAt) > STALE_RESULT_MS
        ) {
          forget();
          return;
        }
        if (inScope(teamId, scopeFolderId)) setStatus(current);
        if (current.requestId) writeMemory(`${key}:request`, current.requestId);
        if (lastRevision !== null && current.progressRevision !== lastRevision) {
          if (inScope(teamId, scopeFolderId)) latest.current.onProgress?.(current);
        }
        lastRevision = current.progressRevision;
        if (current.state === 'canceled') {
          forget();
          report('canceled');
          return;
        }
        if (current.state === 'failed') {
          forget();
          report('failed');
          return;
        }
        if (current.state === 'succeeded') {
          const refresh = deadline(controller.signal, FINAL_REFRESH_TIMEOUT_MS);
          try {
            await Promise.race([
              latest.current.onComplete(),
              new Promise<never>((_, reject) =>
                refresh.signal.addEventListener(
                  'abort',
                  () => reject(new Error('REFRESH_TIMEOUT')),
                  { once: true }
                )
              )
            ]);
          } catch (error) {
            if (controller.signal.aborted) return;
            // The job did succeed; only the screen is behind. Keep the id so
            // the next click repeats the refresh rather than the scan.
            report(
              error instanceof Error && error.message === 'REFRESH_TIMEOUT'
                ? 'disconnected'
                : 'failed'
            );
            return;
          } finally {
            refresh.clear();
          }
          if (controller.signal.aborted) return;
          forget();
          report('succeeded');
          return;
        }
        if (current.state === 'blocked') {
          // Something a person must fix, or a feed the sweeper will restore.
          // Either way, polling it every five seconds tells nobody anything new.
          report('blocked');
          return;
        }
        const mark = progressMark(current);
        if (mark !== lastMark) {
          lastMark = mark;
          lastChangeAt = Date.now();
        } else if (Date.now() - lastChangeAt >= STALL_TIMEOUT_MS) {
          report('stalled');
          return;
        }
        await sleep(POLL_INTERVAL_MS, controller.signal);
      }
    } finally {
      controller.abort();
      if (active.current === controller) {
        active.current = null;
        setRunning(false);
      }
    }
  };

  const start = async () => {
    const { teamId, folderId, client } = input;
    if (
      active.current ||
      accepting.current ||
      !folderId ||
      !client.resyncFolder ||
      !client.getFolderSyncStatus
    )
      return;
    const key = memoryKey(teamId, folderId);
    const remembered = readMemory(key);
    if (remembered && remembered !== UNKNOWN_JOB) return monitor(folderId, remembered);
    accepting.current = true;
    acceptingFolderId.current = folderId;
    setRunning(true);
    const accept = deadline(null, ACCEPT_TIMEOUT_MS);
    // The key outlives a lost answer: the server keeps it, so the next click
    // asks "what did you do with this?" before it asks for anything new.
    const requestKey = readMemory(`${key}:key`) ?? newRequestKey();
    writeMemory(`${key}:key`, requestKey);
    try {
      let jobId: string | null = null;
      if (remembered === UNKNOWN_JOB) {
        if (client.findFolderSyncRequestByKey) {
          const byKey = await client.findFolderSyncRequestByKey(teamId, requestKey, {
            signal: accept.signal
          });
          if (byKey) {
            jobId = byKey.syncJobId;
            writeMemory(`${key}:request`, byKey.requestId);
          }
        }
        if (!jobId && client.findFolderSyncRequest) {
          const found = await client.findFolderSyncRequest(
            teamId,
            folderId === '__root__' ? null : folderId,
            { signal: accept.signal }
          );
          jobId = found?.syncJobId ?? null;
        }
      }
      if (!jobId) {
        const job = await client.resyncFolder(teamId, folderId, {
          signal: accept.signal,
          requestKey
        });
        jobId = job.syncJobId;
        if (job.requestId) writeMemory(`${key}:request`, job.requestId);
      }
      writeMemory(key, jobId);
      if (!inScope(teamId, folderId)) return;
      return await monitor(folderId, jobId);
    } catch (error) {
      if (isRequestAborted(error) || accept.signal.aborted) {
        writeMemory(key, UNKNOWN_JOB);
        if (inScope(teamId, folderId)) latest.current.onOutcome('unreachable');
      } else if (inScope(teamId, folderId)) {
        writeMemory(`${key}:key`, null);
        latest.current.onOutcome('failed');
      }
    } finally {
      accept.clear();
      accepting.current = false;
      acceptingFolderId.current = null;
      if (!active.current) setRunning(false);
    }
  };

  /**
   * Stops this person's request. The server decides whether the job goes too:
   * a job others share, or the space's feed, only loses this request.
   */
  const cancel = async () => {
    const { teamId, client } = input;
    const scope = input.scopeFolderIds ?? (input.folderId ? [input.folderId] : []);
    const scopeFolderId =
      [...scope].reverse().find(id => {
        const value = readMemory(memoryKey(teamId, id));
        return value !== null && value !== UNKNOWN_JOB;
      }) ?? input.folderId;
    if (!scopeFolderId || !client.cancelFolderSync) return;
    const key = memoryKey(teamId, scopeFolderId);
    const requestId = status?.requestId ?? readMemory(`${key}:request`);
    if (!requestId) return;
    try {
      const result = await client.cancelFolderSync(teamId, requestId);
      if (result.requestOutcome === 'detached' || result.jobState === 'canceled') {
        active.current?.abort();
        active.current = null;
        writeMemory(key, null);
        writeMemory(`${key}:request`, null);
        writeMemory(`${key}:key`, null);
        setRunning(false);
        // The panel shows what just happened, not the last poll before it.
        setStatus(current =>
          result.jobState === 'canceled' && current
            ? { ...current, state: 'canceled', phase: 'done', cancelable: false }
            : null
        );
        latest.current.onOutcome(result.jobState === 'canceled' ? 'canceled' : 'detached');
      } else if (result.jobState === 'canceling') {
        // The worker will notice at its next write; keep watching, say so now.
        setStatus(current => (current ? { ...current, state: 'canceling' } : current));
      }
    } catch {
      latest.current.onOutcome('failed');
    }
  };

  /** Hides a finished job's panel. A terminal job is already forgotten, so it stays hidden. */
  const dismiss = () => {
    setStatus(current => (current && TERMINAL_SYNC_STATES.has(current.state) ? null : current));
  };

  return { running, status, start, cancel, dismiss };
}
