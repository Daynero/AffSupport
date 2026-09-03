/**
 * One re-stitched download, from the click to the file.
 *
 * Kept out of the row menu on purpose: a menu is a menu, and this holds a running operation,
 * a remembered folder, a result that outlives the run and a request that may be waiting for a
 * space to be configured. The menu asks; this does.
 *
 * The order matters and is the whole feature: read the space's defaults, read anything already
 * known about the material, and hand both to the agent. With a preparation in hand the agent
 * skips reading the file's keyframe index and searching it for existing screens — six to
 * fourteen seconds, measured — which is what makes ten seconds achievable at all. Without one
 * it does the work and hands back what it found, and that is stored so nobody pays twice.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MaterialRestitchPrep, TeamRestitchDefaults } from '@video-compressor/shared';
import { usablePrep } from '@video-compressor/shared';
import {
  agentCanRestitch,
  cancelTeamDownload,
  downloadTeamFileWithAgent
} from '../../api/client';
import { teamApi } from '../../api/team';
import { completeTeamWorkflow, startTeamWorkflow } from '../../analytics/service';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';

export type RestitchDeliveryPhase =
  /** Waiting for the person to say where it goes — asked once per space, then remembered. */
  | 'choosing'
  | 'transferring'
  | 'inspecting'
  | 'stitching'
  | 'saving';

export type RestitchDeliveryState =
  | { kind: 'idle' }
  | { kind: 'running'; phase: RestitchDeliveryPhase; fileName: string }
  | { kind: 'delivered'; fileName: string }
  | { kind: 'failed'; message: string }
  /** The space has no defaults yet; the caller raises the toast that offers to set them. */
  | { kind: 'unconfigured' };

export interface RestitchDeliveryTarget {
  materialId: string;
  fileName: string;
  driveVersion: string | null;
}

/** Where this member's re-stitched files land, remembered per space in their own browser. */
function folderKey(teamId: string): string {
  return `wishly.team-restitch-folder.v1:${teamId}`;
}

function rememberedFolder(teamId: string): string | null {
  try {
    return localStorage.getItem(folderKey(teamId));
  } catch {
    // A browser that refuses storage simply asks where to save every time.
    return null;
  }
}

function rememberFolder(teamId: string, folder: string): void {
  try {
    localStorage.setItem(folderKey(teamId), folder);
  } catch {
    // A browser that refuses storage simply asks where to save every time, which is the
    // behaviour this exists to avoid rather than to guarantee.
  }
}

export function forgetRestitchFolder(teamId: string): void {
  try {
    localStorage.removeItem(folderKey(teamId));
  } catch {
    // Nothing to do: the next delivery asks, which is the behaviour being restored anyway.
  }
}

/** Phase from the agent's progress, so the row names a step rather than a percentage. */
function phaseFor(progress: number): RestitchDeliveryPhase {
  if (progress < 5) return 'transferring';
  if (progress < 45) return 'inspecting';
  if (progress < 95) return 'stitching';
  return 'saving';
}

export function useRestitchDelivery(teamId: string) {
  const { t } = useI18n();
  const [states, setStates] = useState<Record<string, RestitchDeliveryState>>({});
  const [pending, setPending] = useState<RestitchDeliveryTarget | null>(null);
  const defaults = useRef<TeamRestitchDefaults | null>(null);
  const running = useRef(new AbortController());
  /** The agent-side run behind each material, so it can be stopped by name. */
  const operations = useRef(new Map<string, string>());

  // Leaving the folder or the page ends a delivery as cleanly as pressing cancel: the run is
  // abandoned rather than left writing into a view nobody is looking at (FR-013).
  useEffect(() => {
    const controller = running.current;
    return () => controller.abort();
  }, []);

  const set = useCallback((materialId: string, state: RestitchDeliveryState) => {
    setStates(current => ({ ...current, [materialId]: state }));
  }, []);

  const deliver = useCallback(
    async (target: RestitchDeliveryTarget): Promise<void> => {
      const known = defaults.current ?? (await teamApi.getRestitchDefaults(teamId));
      defaults.current = known;
      if (!known) {
        // Not a failure — the space simply has not been set up. The caller offers to do it,
        // and remembers what was asked for so it can continue afterwards.
        setPending(target);
        set(target.materialId, { kind: 'unconfigured' });
        return;
      }
      if (!(await agentCanRestitch())) {
        set(target.materialId, { kind: 'failed', message: t('teamRestitchAgentTooOld') });
        return;
      }

      const operationId = crypto.randomUUID();
      operations.current.set(target.materialId, operationId);
      const folder = rememberedFolder(teamId);
      // The first delivery in a space opens the app's own folder picker, and the wait for it
      // is a person deciding — not a machine working. Saying "transferring" through that is
      // how a two-second choice reads as a thirty-second hang.
      set(target.materialId, {
        kind: 'running',
        phase: folder ? 'transferring' : 'choosing',
        fileName: target.fileName
      });
      // Timed from the click, and told apart by whether the space had been prepared — the one
      // comparison that says whether preparation is earning its keep (SC-001, SC-003).
      let flow: ReturnType<typeof startTeamWorkflow> | null = null;
      try {
        const found = await teamApi.getMaterialRestitchPrep(teamId, [target.materialId]);
        const prepared = usablePrep(found.get(target.materialId) ?? null, target.driveVersion);
        flow = startTeamWorkflow({
          category: 'video',
          cacheState: prepared ? 'warm' : 'cold',
          stage: 'downloading'
        });
        set(target.materialId, {
          kind: 'running',
          phase: prepared ? 'stitching' : 'inspecting',
          fileName: target.fileName
        });

        const grant = await teamApi.requestDownload(teamId, target.materialId, 'agent');
        if (grant.kind !== 'agent') throw new Error('AGENT_UPDATE_REQUIRED');

        const saved = await downloadTeamFileWithAgent({
          operationId,
          transferUrl: grant.transferUrl,
          transferGrant: grant.grant,
          fileName: target.fileName,
          destination: folder,
          process: { tool: 'restitch', defaults: known, prepared }
        });

        // What the run had to work out is worth more than this delivery: stored, the next
        // member's download of the same material skips it entirely.
        const discovered = (saved as { discovered?: unknown }).discovered;
        if (discovered && target.driveVersion) {
          const record = discovered as Omit<
            MaterialRestitchPrep,
            'materialId' | 'driveVersion' | 'preparedAt'
          > & { detectorVersion?: number };
          await teamApi
            .setMaterialRestitchPrep({
              ...record,
              materialId: target.materialId,
              driveVersion: target.driveVersion,
              /* The agent's own stamp, never one invented here: the agent ships separately
                 and can be older than this page. An agent that sends none leaves a record at
                 version zero, which no build claims, so it is simply never reused. */
              detectorVersion: Math.max(0, Math.trunc(record.detectorVersion ?? 0)),
              unsupportedReason: null,
              preparedAt: new Date().toISOString()
            })
            .catch(() => {
              // Storing it is an optimisation for next time, never a reason to fail a file
              // the member already has.
            });
        }
        // Asked once, then never again for this space.
        if (saved.destination) rememberFolder(teamId, saved.destination);
        set(target.materialId, { kind: 'delivered', fileName: saved.fileName });
        if (flow) completeTeamWorkflow(flow, { outcome: 'success', retryable: false });
      } catch (error) {
        const canceled = error instanceof Error && error.message === 'DOWNLOAD_CANCELED';
        // A download somebody stopped is not a failure, and a red message for a button they
        // pressed themselves reads as one.
        set(
          target.materialId,
          canceled
            ? { kind: 'idle' }
            : { kind: 'failed', message: teamErrorMessageFor(error, t) }
        );
        if (flow) {
          const canceled = error instanceof Error && error.message === 'PROCESS_CANCELED';
          completeTeamWorkflow(flow, {
            outcome: canceled ? 'cancelled' : 'failure',
            retryable: !canceled
          });
        }
      }
    },
    [teamId, set, t]
  );

  /**
   * Continue the delivery that met an unconfigured space.
   *
   * Called once the settings are saved, so the member gets the file they asked for without a
   * second click (FR-011).
   */
  const resume = useCallback(async () => {
    const target = pending;
    if (!target) return;
    setPending(null);
    defaults.current = null;
    await deliver(target);
  }, [pending, deliver]);

  /** Abandons the run behind one material; the agent stops the transfer and the work with it. */
  const cancel = useCallback((materialId: string) => {
    const operationId = operations.current.get(materialId);
    if (!operationId) return;
    void cancelTeamDownload(operationId).catch(() => undefined);
  }, []);

  return {
    states,
    pending,
    deliver,
    resume,
    cancel,
    clearPending: () => setPending(null),
    phaseFor
  };
}
