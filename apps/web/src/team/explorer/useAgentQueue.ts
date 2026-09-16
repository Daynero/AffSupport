import { useCallback, useEffect, useRef, useState } from 'react';
import { teamApi } from '../../api/team';
import {
  cancelTeamAgentProcess,
  downloadTeamFileWithAgent,
  pauseTeamAgentProcess,
  startTeamAgentProcess
} from '../../api/client';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { useOptionalAgent } from '../../AgentContext';
import { teamErrorMessageFor } from '../errors';
import { useTeamOperation } from '../processing/useTeamOperation';
import { announceTaskAttachmentsChanged } from '../tasks/taskAttachmentEvents';
import type { MaterialActionsClient } from '../catalog/useMaterialActions';

/**
 * The explorer's one queue for work that runs on the local app (024, FR-095).
 *
 * Transcribing a video and compressing one are the same shape of job — pick
 * files, send them to Soty one at a time, watch the corner panel — and they
 * were 250 lines in the middle of `ExplorerShell`, tangled with the upload
 * zone, the clipboard, the tag writer, the keyboard handler and the view
 * state. Nothing about a queue needs to know what a folder row looks like.
 *
 * Moved whole rather than rewritten: every comment below is the one that was
 * there, because each of them records something that was learned the hard way
 * — a pause that has nothing to hold yet, a transcript that collects a
 * parenthesis every time it is remade, a failure that leaves an operation
 * running forever and refuses the next attempt at the same file.
 */

export type AgentQueueItem = {
  id: string;
  name: string;
  folderId: string | null;
  tool: 'transcription' | 'compressor';
  outputName: string;
  /** Overwrite-the-original: upload as a new version of this material. */
  versionOf?: string;
  /** 013 (B5): compress on the agent and save to a locally chosen folder. */
  local?: { embed: boolean; suffix: string };
  /**
   * The task this run was started from (024, FR-078). What it writes is put on
   * that task when it finishes, so a performer never has to go and find the
   * transcript they just asked for.
   */
  attachTo?: { taskId: string };
  options?: Record<string, unknown>;
};

/**
 * Was this the person stopping the work, rather than the work going wrong?
 *
 * The agent answers a cancelled run with the same shape as a failed one — a machine code on a
 * rejected promise — so the only thing separating "I pressed stop" from "it broke" is which
 * code it is.
 */
function deliberateStop(cause: unknown): boolean {
  const code = cause instanceof Error ? cause.message : String(cause);
  return code === 'PROCESS_CANCELED' || code === 'DOWNLOAD_CANCELED' || code === 'PREVIEW_CANCELED';
}

export interface AgentQueue {
  /** Add jobs, skipping anything already queued or running. */
  enqueue: (items: AgentQueueItem[]) => void;
  /** The convenience the explorer's Transcribe uses. */
  enqueueTranscriptions: (
    items: { id: string; name: string; folderId: string | null; attachTo?: { taskId: string } }[]
  ) => void;
  active: (AgentQueueItem & { operationId: string | null }) | null;
  queued: readonly AgentQueueItem[];
  done: number;
  total: number;
  paused: boolean;
  /** Whether the local app actually suspended the file in flight. */
  held: boolean;
  pause: (paused: boolean) => void;
  /** Drop what is queued; `all` takes the running file with it. */
  clearQueued: (all: boolean) => void;
  stopNow: () => Promise<void>;
  /** 0–100 for the file in flight, from whichever source is further along. */
  activeProgress: number;
}

export function useAgentQueue({
  teamId,
  actionsClient,
  onChanged
}: {
  teamId: string;
  actionsClient: Pick<MaterialActionsClient, 'renameMaterial'>;
  /** Called after each job, so the folder listing picks up what appeared. */
  onChanged: () => void;
}): AgentQueue {
  const { t } = useI18n();
  const { push } = useToasts();
  const agentCtx = useOptionalAgent();
  const changed = onChanged;
  const [tQueue, setTQueue] = useState<AgentQueueItem[]>([]);
  const [tActive, setTActive] = useState<(AgentQueueItem & { operationId: string | null }) | null>(
    null
  );
  const [tDone, setTDone] = useState(0);
  const [tTotal, setTTotal] = useState(0);
  // The batch is held: nothing new starts, and the file already in flight is
  // suspended too when the local app can do that (`tHeld`). Both are needed —
  // a pause that leaves the machine at full load for the next twenty minutes
  // is not the pause anyone pressed.
  const [tPaused, setTPaused] = useState(false);
  const [tHeld, setTHeld] = useState(false);
  /** The operation this browser has already asked the local app to hold. */
  const heldAsked = useRef<string | null>(null);

  const enqueueJobs = (items: AgentQueueItem[]) => {
    const known = new Set(
      [...tQueue, ...(tActive ? [tActive] : [])].map(item => `${item.tool}:${item.id}`)
    );
    const fresh = items.filter(item => !known.has(`${item.tool}:${item.id}`));
    if (fresh.length === 0) return;
    setTQueue(current => [...current, ...fresh]);
    setTTotal(current => current + fresh.length);
    if (tActive || tQueue.length > 0) {
      push({ tone: 'success', text: t('teamTranscribeQueueAdded', { count: fresh.length }) });
    }
  };

  const enqueueTranscriptions = (
    items: { id: string; name: string; folderId: string | null; attachTo?: { taskId: string } }[]
  ) =>
    enqueueJobs(
      items.map(item => ({
        ...item,
        tool: 'transcription' as const,
        outputName: `${item.name.replace(/\.[^.]+$/u, '')}.txt`
      }))
    );

  // Takes the next queued video whenever nothing is running.
  useEffect(() => {
    if (tActive || tQueue.length === 0 || tPaused) return;
    const next = tQueue[0];
    setTActive({ ...next, operationId: null });
    void (async () => {
      let started: string | null = null;
      try {
        if (next.local) {
          // 013 (B5): no team operation — the agent downloads the source,
          // compresses it locally and saves into a natively chosen folder.
          const grant = await teamApi.requestDownload(teamId, next.id, 'agent');
          if (grant.kind !== 'agent') throw new Error('AGENT_UPDATE_REQUIRED');
          const saved = await downloadTeamFileWithAgent({
            transferUrl: grant.transferUrl,
            transferGrant: grant.grant,
            fileName: next.name,
            compress: next.local
          });
          push({ tone: 'success', text: t('teamCompressLocalSaved', { name: saved.fileName }) });
          return;
        }
        const result = await teamApi.startProcess({
          teamId,
          materialId: next.id,
          toolId: next.tool,
          optionsSummary: next.options ?? {},
          // The server's optionalDestination treats null as the space root; the
          // client type predates that and still says string.
          destinationFolderId: (next.folderId ?? null) as unknown as string,
          outputName: next.outputName,
          ...(next.versionOf ? { versionOfMaterialId: next.versionOf } : {}),
          conflictMode: 'keep_both',
          idempotencyKey: crypto.randomUUID(),
          agentContractVersion: 1,
          toolContractVersion: agentCtx?.toolContracts?.[next.tool] ?? 0
        });
        setTActive(current =>
          current && current.id === next.id
            ? { ...current, operationId: result.operationId }
            : current
        );
        started = result.operationId;
        const finished = await startTeamAgentProcess({
          operationId: result.operationId,
          toolId: next.tool,
          options: next.options ?? {},
          sourceGrant: result.sourceGrant,
          finalizeGrant: result.finalizeGrant
        });
        /*
         * A transcript is named after its video, including the second time.
         *
         * A repeat is written while the transcript it replaces is still there,
         * so the name it asked for is taken and the conflict rule hands it
         * "16-tail (2).txt". The old one is retired during that same finalize —
         * which frees the name — and the file keeps the parenthesis forever,
         * one more each time. Asking for the canonical name here costs one call
         * and is refused (never duplicated) if something live still holds it.
         */
        if (next.attachTo && finished.materialId) {
          await attachResultToTask({
            teamId,
            taskId: next.attachTo.taskId,
            materialId: finished.materialId,
            name: next.outputName,
            push,
            t
          });
        }
        if (next.tool === 'transcription' && finished.materialId) {
          await actionsClient
            .renameMaterial({
              teamId,
              materialId: finished.materialId,
              newName: next.outputName,
              conflictMode: 'cancel',
              idempotencyKey: crypto.randomUUID()
            })
            .catch(() => undefined);
        }
      } catch (cause) {
        // A run somebody stopped on purpose is not a failure, and saying so in red is how a
        // deliberate act starts looking like a fault. Everything below still happens — the
        // space is told the run is over either way.
        if (!deliberateStop(cause)) push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
        // Tell the space the run is over. Without this a failed item stays
        // `running` for good: nothing else ever revisits it, it holds its
        // output name reserved, and the next attempt at the same file is
        // refused for a conflict with a run that is not happening.
        if (started) await teamApi.cancelOperation(teamId, started).catch(() => undefined);
      } finally {
        setTDone(current => current + 1);
        setTActive(null);
        setTQueue(current => current.slice(1));
        changed();
      }
    })();
  }, [actionsClient, agentCtx?.toolContracts, changed, push, t, tActive, tPaused, tQueue, teamId]);

  // The queue drained: one closing toast, counters reset. A pause dies with the
  // queue it was holding; leaving it set would silently swallow the next batch.
  useEffect(() => {
    if (tActive || tQueue.length > 0 || tTotal === 0) return;
    push({ tone: 'success', text: t('teamTranscribeQueueDone', { count: tDone }) });
    setTDone(0);
    setTTotal(0);
    setTPaused(false);
    setTHeld(false);
  }, [push, t, tActive, tDone, tQueue.length, tTotal]);

  /**
   * Holds the batch, and the running file with it where that is possible.
   *
   * The local app is asked separately from the queue on purpose: an older build,
   * a transfer rather than an encode, or the moment between two children all
   * answer "nothing held", and the panel then says the current file is finishing
   * rather than claiming a quiet machine it cannot deliver.
   */
  const pauseQueue = useCallback(
    (paused: boolean) => {
      setTPaused(paused);
      const operationId = tActive?.operationId ?? null;
      heldAsked.current = paused ? operationId : null;
      if (!operationId) {
        setTHeld(false);
        return;
      }
      void pauseTeamAgentProcess(operationId, paused)
        .then(held => setTHeld(paused && held))
        .catch(() => setTHeld(false));
    },
    [tActive?.operationId]
  );

  /*
   * A hold the local app keeps only while this page keeps asking for it.
   *
   * A reload does not close the request the run is riding on — the socket stays
   * open and the agent keeps working, which is why a refresh costs no work. The
   * pause would survive that reload too, with nothing left to lift it, so the
   * page says "still paused" every half minute and the agent lets go on its own
   * if that stops arriving.
   */
  useEffect(() => {
    const operationId = tActive?.operationId ?? null;
    if (!tPaused || !tHeld || !operationId) return;
    const timer = window.setInterval(() => {
      void pauseTeamAgentProcess(operationId, true).catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [tActive?.operationId, tHeld, tPaused]);

  // Pause pressed in the second between "started" and "the operation has an
  // id": there was nothing to hold then, so the hold is taken as soon as there
  // is. Asked once per operation — an agent that cannot hold has answered, and
  // repeating the question on every render would be a request per frame.
  useEffect(() => {
    const operationId = tActive?.operationId ?? null;
    if (!tPaused || !operationId || tHeld || heldAsked.current === operationId) return;
    heldAsked.current = operationId;
    void pauseTeamAgentProcess(operationId, true)
      .then(held => setTHeld(held))
      .catch(() => undefined);
  }, [tActive?.operationId, tHeld, tPaused]);

  /**
   * Abandons the file being worked on, and everything queued behind it.
   *
   * The pause is lifted first: a stopped process is not delivered its termination signal
   * until it runs again, so cancelling a held run would otherwise wait for a resume nobody
   * is coming to give it.
   */
  const stopNow = useCallback(async () => {
    const operationId = tActive?.operationId ?? null;
    setTQueue([]);
    if (tPaused) pauseQueue(false);
    if (!operationId) return;
    await cancelTeamAgentProcess(operationId).catch(() => false);
  }, [pauseQueue, tActive?.operationId, tPaused]);

  const activeOperation = useTeamOperation({
    teamId,
    operationId: tActive?.operationId ?? null
  });
  const activeProgress = Math.max(
    activeOperation.operation?.progress ?? 0,
    activeOperation.localProgress?.progress ?? 0
  );

  return {
    enqueue: enqueueJobs,
    enqueueTranscriptions,
    active: tActive,
    queued: tQueue,
    done: tDone,
    total: tTotal,
    paused: tPaused,
    held: tHeld,
    pause: pauseQueue,
    clearQueued: all => {
      setTQueue(all ? [] : current => current.slice(0, 1));
      setTTotal(tDone + 1);
    },
    stopNow,
    activeProgress
  };
}

/**
 * Puts what a run made onto the task it was started from (024, FR-078).
 *
 * Quiet about everything that is not news: a result already on the task (a
 * reload during finalize attaches twice), and a task that is gone — nobody is
 * looking at it, and the file is still where it was written. The one sentence
 * worth saying is that it arrived, with the way to take it off again.
 */
export async function attachResultToTask({
  teamId,
  taskId,
  materialId,
  name,
  push,
  t
}: {
  teamId: string;
  taskId: string;
  materialId: string;
  name: string;
  push: ReturnType<typeof useToasts>['push'];
  t: ReturnType<typeof useI18n>['t'];
}): Promise<void> {
  try {
    const result = await teamApi.attachTaskMaterials({ teamId, taskId, materialIds: [materialId] });
    if (!result.attached.includes(materialId)) return;
  } catch {
    return;
  }
  announceTaskAttachmentsChanged(taskId);
  push({
    tone: 'success',
    text: t('teamTaskResultAttached', { name }),
    action: {
      label: t('teamTaskResultTakeOff'),
      run: async () => {
        await teamApi.detachTaskMaterial(teamId, taskId, materialId).catch(() => undefined);
        announceTaskAttachmentsChanged(taskId);
      }
    }
  });
}
