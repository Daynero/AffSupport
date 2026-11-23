import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { TeamMaterialRow } from '@video-compressor/shared';
import { useI18n } from '../../i18n';
import { useToasts } from '../../components/toast';
import { teamErrorMessageFor } from '../errors';
import type { TailClient } from '../materials/tail';
import { AgentQueuePanel } from '../processing/AgentQueueProvider';
import type { AgentQueue } from './useAgentQueue';
import type { useOptionalWorkspaceOperations } from './WorkspaceOperationsProvider';
import type { useExplorerRestitch } from './useExplorerRestitch';
import { BulkTrashPanel } from './BulkTrashPanel';
import { ProcessPanel } from './ProcessPanel';

/**
 * What a re-stitched download is doing, in words and as a share.
 *
 * The shares are the honest shape of the work rather than a guess at seconds: the transfer is
 * most of a prepared delivery, and the cut that follows it is quick. They only ever move
 * forward, which is what the panel needs.
 */
const RESTITCH_PHASE_KEYS = {
  checking: 'teamRestitchPhaseChecking',
  choosing: 'teamRestitchPhaseChoosing',
  transferring: 'teamRestitchPhaseTransferring',
  inspecting: 'teamRestitchPhaseInspecting',
  stitching: 'teamRestitchPhaseStitching',
  saving: 'teamRestitchPhaseSaving'
} as const;

/*
 * Where a step starts and how much of the bar it owns.
 *
 * The agent reports each step's own percentage now — bytes while the video arrives, the join
 * while it is stitched — so the bar is that percentage placed inside the step's own share of
 * the whole. Fetching and stitching are the two real waits and take the bar between them;
 * the rest are moments.
 */
const RESTITCH_PHASE_SPAN = {
  checking: { from: 0, to: 0 },
  choosing: { from: 0, to: 5 },
  transferring: { from: 5, to: 45 },
  inspecting: { from: 45, to: 50 },
  stitching: { from: 50, to: 95 },
  saving: { from: 95, to: 100 }
} as const;

function restitchProgress(phase: keyof typeof RESTITCH_PHASE_SPAN, within?: number): number {
  const span = RESTITCH_PHASE_SPAN[phase];
  if (within === undefined) return span.from;
  const fraction = Math.max(0, Math.min(100, within)) / 100;
  return Math.round(span.from + (span.to - span.from) * fraction);
}

/**
 * The explorer's long jobs, in one corner (070, FR-001, out of `ExplorerShell`): the bulk
 * trash groups, the local queue when the explorer has no space around it, and a re-stitched
 * download.
 *
 * Long jobs report in one corner. Inside a space that corner is the space's, so a re-stitched
 * download and the queue stack instead of covering each other; the explorer's own panels are
 * portalled into it.
 */
export function ExplorerProcessStack({
  stack,
  bulkTrash,
  rows,
  canDelete,
  tailClient,
  onChanged,
  showQueue,
  queue,
  delivering,
  onCancelDelivery
}: {
  /** The space's corner, when there is a space; otherwise the panels draw their own. */
  stack: HTMLElement | null | undefined;
  bulkTrash: NonNullable<ReturnType<typeof useOptionalWorkspaceOperations>>['bulkTrash'];
  rows: TeamMaterialRow[];
  canDelete: boolean;
  tailClient: TailClient;
  onChanged: () => void;
  /** The local queue's panel — only when no space owns the queue. */
  showQueue: boolean;
  queue: AgentQueue;
  delivering: ReturnType<typeof useExplorerRestitch>['deliveringMaterial'];
  onCancelDelivery: (materialId: string) => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const panels: ReactNode = (
    <>
      {/* A group the catalog manager is showing is reported there, once. */}
      {bulkTrash?.groups
        .filter(group => !bulkTrash?.claimed?.has(group.id))
        .slice(0, 3)
        .map(group => (
          <BulkTrashPanel
            key={group.id}
            group={group}
            historicalReceipts={bulkTrash?.historicalReceipts?.get(group.id)}
            rows={rows}
            names={bulkTrash?.names}
            executing={bulkTrash?.executing?.has(group.id)}
            uncertain={bulkTrash?.uncertain ?? true}
            onVisible={bulkTrash!.acknowledgeVisible}
            onDismiss={bulkTrash!.dismiss}
            onRetry={
              canDelete && bulkTrash?.owns(group)
                ? () => {
                    void bulkTrash
                      ?.retry(group, rows, tailClient)
                      .then(onChanged)
                      .catch(cause => push({ tone: 'error', text: teamErrorMessageFor(cause, t) }));
                  }
                : undefined
            }
          />
        ))}
      {showQueue && (queue.active || queue.queued.length > 0) && (
        <AgentQueuePanel queue={queue} t={t} />
      )}

      {/* 015 — a re-stitched download reports itself the same way every other long job does:
            one panel, a named step, and a way out. It used to say only "downloading…" in a
            toast, which on a thirty-second wait reads as a hang. */}
      {delivering && (
        <ProcessPanel
          title={t('teamRestitchDownloadTitle')}
          detail={delivering.state.fileName}
          phase={t(RESTITCH_PHASE_KEYS[delivering.state.phase])}
          progress={restitchProgress(delivering.state.phase, delivering.state.progress)}
          active
          actions={[
            {
              label: t('teamQueueStopNow'),
              run: () => onCancelDelivery(delivering.materialId),
              destructive: true
            }
          ]}
        />
      )}
    </>
  );
  return stack ? createPortal(panels, stack) : <div className="team-process-stack">{panels}</div>;
}
