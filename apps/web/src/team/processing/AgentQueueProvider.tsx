import { createContext, useContext, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { defaultMaterialActionsClient } from '../catalog/material-actions-client';
import { ProcessPanel } from '../explorer/ProcessPanel';
import { useAgentQueue, type AgentQueue } from '../explorer/useAgentQueue';

interface SpaceAgentQueue {
  queue: AgentQueue;
  /** The corner stack, so another long job can report beside the queue, not on top of it. */
  stack: HTMLElement | null;
}

const AgentQueueContext = createContext<SpaceAgentQueue | null>(null);

/**
 * The local app's queue, owned by the space (024, FR-077).
 *
 * It lived inside Files, which meant two things nobody chose: only Files could
 * start a transcript or a compressed copy, and a run existed only while Files
 * was mounted. A performer on a task had to leave the task to ask for either.
 * Mounted once per space, the queue is reachable from a task attachment as
 * well, survives every section change, and its corner panel reports wherever
 * the person happens to be.
 */
export function AgentQueueProvider({
  teamId,
  onChanged,
  children
}: {
  teamId: string;
  onChanged: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const queue = useAgentQueue({
    teamId,
    actionsClient: defaultMaterialActionsClient,
    onChanged
  });
  const [stack, setStack] = useState<HTMLElement | null>(null);

  return (
    <AgentQueueContext.Provider value={{ queue, stack }}>
      {children}
      {/* One corner, one stack: the queue and any other long job share it. */}
      <div className="team-process-stack" ref={setStack}>
        {(queue.active || queue.queued.length > 0) && <AgentQueuePanel queue={queue} t={t} />}
      </div>
    </AgentQueueContext.Provider>
  );
}

/** The space's queue, or null outside a space (a Files shell mounted on its own). */
export function useOptionalSpaceAgentQueue(): SpaceAgentQueue | null {
  return useContext(AgentQueueContext);
}

export function AgentQueuePanel({
  queue,
  t
}: {
  queue: AgentQueue;
  t: ReturnType<typeof useI18n>['t'];
}) {
  return (
    <ProcessPanel
      title={t(
        queue.active?.tool === 'compressor' ? 'teamCompressQueueTitle' : 'teamTranscribeQueueTitle'
      )}
      detail={
        queue.active
          ? t('teamTranscribeQueueProgress', {
              done: queue.done + 1,
              total: queue.total,
              name: queue.active.name
            })
          : null
      }
      phase={
        queue.paused
          ? t(
              queue.active
                ? queue.held
                  ? 'teamQueuePausedHeld'
                  : 'teamQueuePausedRunning'
                : 'teamQueuePausedIdle',
              { count: queue.queued.length }
            )
          : null
      }
      progress={queue.activeProgress}
      active={!queue.paused}
      actions={[
        {
          label: t(queue.paused ? 'teamQueueResume' : 'teamQueuePause'),
          run: () => queue.pause(!queue.paused)
        },
        // The running file is the head of `queued`: "after the current one" means
        // something only when there is a second.
        ...(queue.queued.length > 1
          ? [
              {
                label: t('teamTranscribeQueueStop'),
                run: () => {
                  queue.clearQueued(Boolean(queue.active));
                  // "After the current one" has to have a current one that is still
                  // moving; stopping while paused would leave a suspended file as the
                  // last thing this panel ever did.
                  if (queue.paused) queue.pause(false);
                }
              }
            ]
          : []),
        ...(queue.active
          ? [
              {
                label: t('teamQueueStopNow'),
                run: () => void queue.stopNow(),
                destructive: true
              }
            ]
          : [])
      ]}
    />
  );
}
