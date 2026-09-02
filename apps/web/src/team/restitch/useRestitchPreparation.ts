/**
 * Preparing a whole space, from one button.
 *
 * Three things happen, in this order: the space's Soty folder is made (or found, if a member
 * has since renamed or moved it), every video in the space is listed, and each one is looked at
 * once so that no later download has to. What is found is written back to the space, so the
 * member who prepares is not the only one who benefits.
 *
 * **Why it feeds the agent in small batches.** A transfer grant lives twenty minutes and each
 * material costs a transfer plus six to fourteen seconds of reading. Handing over fifty grants
 * at once would mean the last of them expired long before their turn; a handful at a time keeps
 * every grant well inside its life, and costs one extra local round trip per batch.
 *
 * **Already-prepared materials are skipped**, so pressing the button again after adding two
 * videos costs two inspections rather than fifty.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { usablePrep, type TeamMaterialRow } from '@video-compressor/shared';
import {
  agentCanRestitch,
  cancelTeamRestitchPreparation,
  prepareTeamRestitchMaterials,
  readTeamRestitchPreparation
} from '../../api/client';
import { teamApi } from '../../api/team';
import { completeTeamWorkflow, startTeamWorkflow } from '../../analytics/service';

/** Grants stay comfortably inside their twenty minutes at this size. */
const BATCH = 5;
const POLL_MS = 700;

export type RestitchPreparationPhase =
  | 'idle'
  | 'folder'
  | 'listing'
  | 'running'
  | 'finished'
  | 'canceled'
  | 'failed';

export interface RestitchPreparationState {
  phase: RestitchPreparationPhase;
  done: number;
  total: number;
  /** The tally SC-006 asks for: how many are ready, and how many could not be. */
  ready: number;
  unsupported: number;
  failed: number;
  /**
   * A machine code, translated by the caller.
   *
   * Also set when the run itself completed but every material inside it failed for the same
   * reason — an expired grant or a lost permission reads as "50 could not be prepared", which
   * tells a member nothing they can act on.
   */
  errorCode: string | null;
}

const IDLE: RestitchPreparationState = {
  phase: 'idle',
  done: 0,
  total: 0,
  ready: 0,
  unsupported: 0,
  failed: 0,
  errorCode: null
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Every video in the space, with the version each preparation will be keyed to. */
async function listVideos(teamId: string, signal: AbortSignal): Promise<TeamMaterialRow[]> {
  const folders = await teamApi.listFolderTree(teamId);
  const parents: (string | null)[] = [null, ...folders.map(folder => folder.id)];
  const rows: TeamMaterialRow[] = [];
  for (const parentFolderId of parents) {
    let after = null as Parameters<typeof teamApi.listFolderPage>[1]['after'];
    do {
      if (signal.aborted) return rows;
      const page = await teamApi.listFolderPage(teamId, {
        parentFolderId,
        kinds: ['video'],
        after,
        limit: 100
      });
      rows.push(...page.rows.filter(row => row.kind === 'video'));
      after = page.next;
    } while (after);
  }
  return rows;
}

export function useRestitchPreparation(teamId: string) {
  const [state, setState] = useState<RestitchPreparationState>(IDLE);
  const running = useRef<AbortController | null>(null);
  const operation = useRef<string | null>(null);

  // Leaving the settings does not abandon the agent's run — it keeps going and keeps writing
  // what it finds — but this page stops following it.
  useEffect(() => () => running.current?.abort(), []);

  const cancel = useCallback(async () => {
    const id = operation.current;
    running.current?.abort();
    if (id) await cancelTeamRestitchPreparation(id).catch(() => false);
    setState(current => ({ ...current, phase: 'canceled' }));
  }, []);

  const prepare = useCallback(async () => {
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    const signal = controller.signal;
    setState({ ...IDLE, phase: 'folder' });
    // How long preparing a space actually takes, and how it ends. Cold by definition: it is
    // the run that makes everything after it warm.
    const flow = startTeamWorkflow({ category: 'video', cacheState: 'cold', stage: 'processing' });

    try {
      if (!(await agentCanRestitch())) {
        setState({ ...IDLE, phase: 'failed', errorCode: 'AGENT_UPDATE_REQUIRED' });
        return;
      }
      // The folder is made by this button and by nothing else: no member is ever asked to
      // create it, name it or find it (FR-016).
      await teamApi.ensureWorkspaceFolder(teamId);
      if (signal.aborted) return;

      setState(current => ({ ...current, phase: 'listing' }));
      const videos = await listVideos(teamId, signal);
      if (signal.aborted) return;

      // Skipping what somebody already looked at is what makes a second press cheap.
      const known = await teamApi.getMaterialRestitchPrep(
        teamId,
        videos.map(video => video.id)
      );
      const pending = videos.filter(
        video => !usablePrep(known.get(video.id) ?? null, video.driveVersion)
      );
      const already = videos.length - pending.length;
      setState({
        phase: 'running',
        done: already,
        total: videos.length,
        ready: already,
        unsupported: 0,
        failed: 0,
        errorCode: null
      });

      for (let index = 0; index < pending.length; index += BATCH) {
        if (signal.aborted) return;
        const batch = pending.slice(index, index + BATCH);
        const materials = [];
        let transferUrl = '';
        for (const video of batch) {
          const grant = await teamApi.requestDownload(teamId, video.id, 'agent');
          if (grant.kind !== 'agent') throw new Error('AGENT_UPDATE_REQUIRED');
          transferUrl = grant.transferUrl;
          materials.push({
            materialId: video.id,
            driveVersion: video.driveVersion ?? '',
            fileName: video.name,
            transferGrant: grant.grant
          });
        }
        if (signal.aborted) return;

        const operationId = crypto.randomUUID();
        operation.current = operationId;
        await prepareTeamRestitchMaterials({
          operationId,
          teamId,
          transferUrl,
          materials,
          audio: { sampleRate: 48000, channels: 2 }
        });
        await follow(operationId, signal, setState);
      }

      if (!signal.aborted) setState(current => ({ ...current, phase: 'finished' }));
      completeTeamWorkflow(flow, {
        outcome: signal.aborted ? 'cancelled' : 'success',
        retryable: false,
        stage: 'finalizing'
      });
    } catch (error) {
      completeTeamWorkflow(flow, { outcome: 'failure', retryable: true, stage: 'processing' });
      if (signal.aborted) return;
      setState(current => ({
        ...current,
        phase: 'failed',
        errorCode: error instanceof Error ? error.message : 'PREPARE_FAILED'
      }));
    } finally {
      operation.current = null;
    }
  }, [teamId]);

  return { state, prepare, cancel, reset: () => setState(IDLE) };
}

/**
 * Follows one batch to its end, storing each finding as it lands.
 *
 * Storing as they land rather than at the end is deliberate: a run that is stopped, or a page
 * that is closed, keeps everything it had already found (FR-020).
 */
async function follow(
  operationId: string,
  signal: AbortSignal,
  setState: (update: (current: RestitchPreparationState) => RestitchPreparationState) => void
): Promise<void> {
  const stored = new Set<string>();
  for (;;) {
    if (signal.aborted) return;
    const report = await readTeamRestitchPreparation(operationId);
    // An agent that has forgotten the run — restarted, or the run aged out — is not a failure
    // of the materials: what was stored stays stored, and the next press picks up the rest.
    if (!report) return;

    for (const finding of report.findings) {
      if (finding.state === 'inspecting' || stored.has(finding.materialId)) continue;
      stored.add(finding.materialId);
      if (finding.prep) {
        await teamApi.setMaterialRestitchPrep(finding.prep).catch(() => {
          // Storing is what makes the next download fast; failing to store loses that
          // advantage and nothing else, so the run carries on.
        });
      }
      setState(current => ({
        ...current,
        done: current.done + 1,
        ready: current.ready + (finding.state === 'prepared' ? 1 : 0),
        unsupported: current.unsupported + (finding.state === 'unsupported' ? 1 : 0),
        failed: current.failed + (finding.state === 'failed' ? 1 : 0),
        // Kept rather than counted only: "could not be prepared" is not something a member can
        // act on, and "permission denied" is.
        errorCode: finding.state === 'failed' ? finding.reason : current.errorCode
      }));
    }
    if (report.state !== 'running') return;
    await sleep(POLL_MS, signal);
  }
}
