import { useEffect, useRef, useState } from 'react';
import { TeamApiError, type DriveCatalogResyncResult } from '../../api/team';

function pendingKey(teamId: string, folderId: string): string {
  return `soty:folder-resync:${teamId}:${folderId}`;
}

function readPending(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePending(key: string, jobId: string | null): void {
  try {
    if (jobId) window.sessionStorage.setItem(key, jobId);
    else window.sessionStorage.removeItem(key);
  } catch {
    // A blocked storage API only limits recovery across navigation.
  }
}

export interface FolderResyncClient {
  resyncFolder?: (teamId: string, folderId: string) => Promise<DriveCatalogResyncResult>;
  getFolderResyncStatus?: (
    teamId: string,
    jobId: string
  ) => Promise<'running' | 'succeeded' | 'failed'>;
}

/** Poll only after an explicit click; no permanent workspace polling or Realtime dependency. */
export function useFolderResync(input: {
  teamId: string;
  folderId: string | null;
  /** Current folder and its ancestors, so an accepted parent scan stays visible inside a child. */
  scopeFolderIds?: readonly string[];
  client: FolderResyncClient;
  onComplete: () => Promise<void>;
  onOutcome: (outcome: 'succeeded' | 'failed' | 'timeout') => void;
}) {
  const [running, setRunning] = useState(false);
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
    const pendingFolderId = [...scope].reverse().find(id => readPending(pendingKey(teamId, id)));
    if (pendingFolderId && client.getFolderResyncStatus) {
      void monitor(pendingFolderId);
    }
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [input.teamId, input.folderId, scopeKey]);

  const monitor = async (scopeFolderId: string, requestedJobId?: string) => {
    const { teamId, client } = input;
    if (active.current || !client.getFolderResyncStatus) return;
    const key = pendingKey(teamId, scopeFolderId);
    if (!requestedJobId && !readPending(key)) return;
    const controller = new AbortController();
    active.current = controller;
    setRunning(true);
    // A hung request also releases the button; the server job can still finish independently.
    const timeout = window.setTimeout(() => {
      if (active.current !== controller) return;
      controller.abort();
      active.current = null;
      setRunning(false);
      latest.current.onOutcome('timeout');
    }, 5 * 60_000);
    controller.signal.addEventListener('abort', () => window.clearTimeout(timeout), { once: true });
    try {
      const jobId = requestedJobId ?? readPending(key);
      if (!jobId) return;
      while (!controller.signal.aborted) {
        const status = await client.getFolderResyncStatus(teamId, jobId);
        if (controller.signal.aborted) return;
        if (status === 'failed') {
          writePending(key, null);
          throw new Error('FOLDER_RESYNC_FAILED');
        }
        if (status === 'succeeded') {
          await latest.current.onComplete();
          if (!controller.signal.aborted) {
            writePending(key, null);
            latest.current.onOutcome('succeeded');
          }
          return;
        }
        await new Promise<void>(resolve => {
          const done = () => {
            window.clearTimeout(timer);
            controller.signal.removeEventListener('abort', done);
            resolve();
          };
          const timer = window.setTimeout(done, 5_000);
          controller.signal.addEventListener('abort', done, { once: true });
        });
      }
    } catch (error) {
      // The server retains completed jobs for a bounded period. An old tab can
      // still remember a deleted job; discard that id so the next click queues
      // a fresh scan instead of polling the missing job forever.
      if (error instanceof TeamApiError && error.code === 'INVALID_RESPONSE') {
        writePending(key, null);
      }
      if (!controller.signal.aborted) latest.current.onOutcome('failed');
    } finally {
      controller.abort();
      window.clearTimeout(timeout);
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
      !client.getFolderResyncStatus
    )
      return;
    const key = pendingKey(teamId, folderId);
    const pending = readPending(key);
    if (pending) return monitor(folderId, pending);
    accepting.current = true;
    acceptingFolderId.current = folderId;
    setRunning(true);
    try {
      const job = await client.resyncFolder(teamId, folderId);
      writePending(key, job.syncJobId);
      const latestScope =
        latest.current.scopeFolderIds ?? (latest.current.folderId ? [latest.current.folderId] : []);
      if (latest.current.teamId !== teamId || !latestScope.includes(folderId)) return;
      return await monitor(folderId, job.syncJobId);
    } catch {
      latest.current.onOutcome('failed');
    } finally {
      accepting.current = false;
      acceptingFolderId.current = null;
      if (!active.current) setRunning(false);
    }
  };
  return { running, start };
}
