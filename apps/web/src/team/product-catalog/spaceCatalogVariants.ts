import { useEffect, useRef, useState } from 'react';
import { RESTITCH_CONTRACT_VERSION, type TeamAgentProcessRequest } from '@video-compressor/shared';
import { agentCanRunSpaceVariants, startTeamAgentProcess } from '../../api/client';
import { rememberSpaceRun } from '../../api/space-operations';
import { spaceStorageApi, type SpaceCatalogVariantRun } from '../../api/space-storage';
import { teamApi } from '../../api/team';
import { ensureRestitchImages } from '../restitch/images';
import { prepareRestitchScreens } from '../restitch/screens';

/**
 * 057 T100 (research.md R15): the re-stitched variations of a catalog being created in an R2
 * space are made by the member's own agent, handed over from this page one at a time.
 *
 * The server owns everything that matters — which variations exist, the settings and the
 * duration each one uses, the run it is on, at most three runs each — and answers it through
 * space-storage `/catalog-variants/run`. This only draws each variation's pictures (as a single
 * re-stitch does) and gives the run to the agent, which reads the source from the space and
 * writes the output back to it; the run's finalize registers the output with the catalog. A run
 * outlives the page: a reloaded page hands the same run over again, and an agent already doing
 * it says so (WRONG_STATE) instead of starting twice. With the page closed, the member's delegated
 * agent finishes the rest in the background (T107); a variation it holds answers `background`
 * here, and the page waits for it instead of making it a second time.
 *
 * T119: a Launch's page runs the same passes over each of its sets (one per video), so an R2
 * Launch runs on the member's open Soty in the foreground as a Drive one does. A computer whose
 * Soty is not reachable stops a pass quietly (AGENT_UNREACHABLE): background work may be making
 * them, and when nothing is, the server's progress says so (`waitReason: AGENT_REQUIRED`).
 */

export interface SpaceCatalogVariantsDeps {
  run: typeof spaceStorageApi.runCatalogVariant;
  canRestitch: () => Promise<'yes' | 'too-old' | 'unreachable'>;
  prepareScreens: typeof prepareRestitchScreens;
  ensureImages: typeof ensureRestitchImages;
  process: (request: TeamAgentProcessRequest) => ReturnType<typeof startTeamAgentProcess>;
  cancel: (teamId: string, operationId: string) => Promise<unknown>;
  remember: (operationId: string) => void;
}

const defaultDeps: SpaceCatalogVariantsDeps = {
  run: input => spaceStorageApi.runCatalogVariant(input),
  canRestitch: () => agentCanRunSpaceVariants(),
  prepareScreens: (teamId, defaults) => prepareRestitchScreens(teamId, defaults),
  ensureImages: (teamId, defaults) => ensureRestitchImages(teamId, defaults),
  process: request => startTeamAgentProcess(request),
  cancel: (teamId, operationId) => teamApi.cancelOperation(teamId, operationId),
  remember: rememberSpaceRun
};

export type SpaceCatalogVariantsOutcome =
  /** Every variation has its output; the creation can be resumed. */
  | { kind: 'done' }
  /** Some are being made elsewhere (an earlier page's run): read again later. */
  | { kind: 'waiting' }
  /** A variation cannot be made (three runs failed) or the creation was canceled. */
  | { kind: 'ended' }
  /** This computer cannot make them now; the code says why. */
  | { kind: 'stopped'; code: string };

function codeOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
    return error.code;
  return error instanceof Error ? error.message : 'PROCESS_FAILED';
}

/**
 * The code of a pass that stopped because Soty on this computer is not reachable: not a failure
 * to show, the server's progress says when nothing else makes the variations.
 */
export const SPACE_VARIANTS_UNREACHABLE = 'AGENT_UNREACHABLE';

/** Codes that say this computer, not this run, is the problem: trying the next run is pointless. */
const STOPPING = new Set([
  'AGENT_UPDATE_REQUIRED',
  'AGENT_REQUIRED',
  'AGENT_UNREACHABLE',
  'UPDATE_PENDING',
  'DISK_FULL',
  'RESTITCH_POOL_EMPTY',
  'RESTITCH_SOURCE_FORBIDDEN',
  'RESTITCH_INVALID',
  'PERMISSION_DENIED',
  'STORAGE_QUOTA_EXCEEDED'
]);

async function makeOne(
  teamId: string,
  answer: Extract<SpaceCatalogVariantRun, { state: 'run' }>,
  deps: SpaceCatalogVariantsDeps
): Promise<void> {
  const drawn = await deps.prepareScreens(teamId, answer.defaults);
  if (drawn.kind === 'too-old') throw new Error('AGENT_UPDATE_REQUIRED');
  if (drawn.kind === 'legacy') await deps.ensureImages(teamId, answer.defaults);
  deps.remember(answer.operationId);
  const finished = await deps.process({
    operationId: answer.operationId,
    toolId: 'restitch',
    options: {
      defaults: answer.defaults,
      prepared: null,
      ...(drawn.kind === 'ready' ? { screens: drawn.screens, teamId } : {})
    },
    sourceGrant: answer.sourceGrant,
    finalizeGrant: answer.finalizeGrant
  });
  if (finished.state !== 'succeeded' || !finished.materialId) throw new Error('PROCESS_FAILED');
}

/** One pass over the set's variations, in order; each is made at most once per pass and try. */
export async function runSpaceCatalogVariants(
  input: {
    teamId: string;
    setId: string;
    count: number;
    signal: AbortSignal;
    /** After each variation that this pass made. */
    onMade?: () => void;
  },
  deps: SpaceCatalogVariantsDeps = defaultDeps
): Promise<SpaceCatalogVariantsOutcome> {
  const capability = await deps.canRestitch();
  if (capability === 'unreachable') return { kind: 'stopped', code: SPACE_VARIANTS_UNREACHABLE };
  if (capability !== 'yes') return { kind: 'stopped', code: 'AGENT_UPDATE_REQUIRED' };
  let waiting = false;
  for (let index = 0; index < input.count; index++) {
    // Each variation gets as many runs as the server allows; it says when there are no more.
    for (;;) {
      if (input.signal.aborted) return { kind: 'waiting' };
      let answer: SpaceCatalogVariantRun;
      try {
        answer = await deps.run({
          teamId: input.teamId,
          setId: input.setId,
          index,
          toolContractVersion: RESTITCH_CONTRACT_VERSION
        });
      } catch (error) {
        return { kind: 'stopped', code: codeOf(error) };
      }
      if (answer.state !== 'run') {
        if (answer.state === 'registered') break;
        // The member's agent is making it in the background (T107): look again later.
        if (answer.state === 'background') {
          waiting = true;
          break;
        }
        return { kind: 'ended' };
      }
      const run = answer;
      try {
        await makeOne(input.teamId, run, deps);
        input.onMade?.();
        break;
      } catch (error) {
        const code = codeOf(error);
        // The agent is already making this one (a page before this one handed it over).
        if (code === 'WRONG_STATE') {
          waiting = true;
          break;
        }
        if (STOPPING.has(code)) return { kind: 'stopped', code };
        // This run failed on this computer: it is closed, and the server opens the next one.
        await deps.cancel(input.teamId, run.operationId).catch(() => undefined);
      }
    }
  }
  return waiting ? { kind: 'waiting' } : { kind: 'done' };
}

/** How long a pass that found work elsewhere, or stopped, waits before it looks again. */
export const SPACE_VARIANTS_RETRY_MS = 20_000;

/** One set of variations to make: the dialog's one, or one per video of a Launch (T119). */
export interface SpaceVariantSetWork {
  setId: string;
  count: number;
}

/** Passes over the sets in order; the first that stops (or is aborted) decides the outcome. */
export async function runSpaceVariantSets(
  input: {
    teamId: string;
    sets: readonly SpaceVariantSetWork[];
    signal: AbortSignal;
    onMade?: () => void;
  },
  deps: SpaceCatalogVariantsDeps = defaultDeps
): Promise<SpaceCatalogVariantsOutcome> {
  let waiting = false;
  let ended = false;
  for (const set of input.sets) {
    const outcome = await runSpaceCatalogVariants(
      {
        teamId: input.teamId,
        setId: set.setId,
        count: set.count,
        signal: input.signal,
        ...(input.onMade ? { onMade: input.onMade } : {})
      },
      deps
    );
    if (outcome.kind === 'stopped') return outcome;
    if (outcome.kind === 'waiting') waiting = true;
    if (outcome.kind === 'ended') ended = true;
    if (input.signal.aborted) return { kind: 'waiting' };
  }
  return waiting ? { kind: 'waiting' } : ended ? { kind: 'ended' } : { kind: 'done' };
}

/**
 * Runs passes while the page shows an R2 creation whose variations are not all made — the
 * catalog dialog's set, or each set of a Launch (T119). A pass never starts twice for the same
 * sets at once; leaving stops new hand-overs (a run already with the agent goes on).
 */
export function useSpaceCatalogVariantRunner(input: {
  active: boolean;
  teamId: string;
  sets: readonly SpaceVariantSetWork[];
  onMade(): void;
  onStopped(code: string): void;
}): void {
  const running = useRef<string | null>(null);
  const [tick, setTick] = useState(0);
  const latest = useRef(input);
  latest.current = input;
  const { active, teamId } = input;
  const key = input.sets.map(set => `${set.setId}:${set.count}`).join(',');
  useEffect(() => {
    if (!active || !key || running.current === key) return;
    const controller = new AbortController();
    running.current = key;
    let timer: ReturnType<typeof setTimeout> | null = null;
    void runSpaceVariantSets({
      teamId,
      sets: latest.current.sets,
      signal: controller.signal,
      onMade: () => latest.current.onMade()
    })
      .then(outcome => {
        if (controller.signal.aborted) return;
        latest.current.onMade();
        if (outcome.kind === 'stopped') latest.current.onStopped(outcome.code);
        if (outcome.kind === 'waiting' || outcome.kind === 'stopped')
          timer = setTimeout(() => setTick(value => value + 1), SPACE_VARIANTS_RETRY_MS);
      })
      .finally(() => {
        if (running.current === key) running.current = null;
      });
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
      if (running.current === key) running.current = null;
    };
  }, [active, teamId, key, tick]);
}
