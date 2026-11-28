// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  SPACE_VARIANTS_UNREACHABLE,
  runSpaceCatalogVariants,
  runSpaceVariantSets,
  type SpaceCatalogVariantsDeps
} from '../apps/web/src/team/product-catalog/spaceCatalogVariants';
import { spaceLaunchVariantSets } from '../apps/web/src/team/launches/useSpaceLaunchVariants';

/**
 * 057 T099: the page that created an R2 catalog with variations hands them to the member's
 * agent one at a time. The server says what each variation needs; the page draws its pictures and
 * gives the run to the agent, closes a run that failed so the server opens the next, waits on a
 * run an earlier page already handed over, and stops on what this computer cannot do.
 */

const TEAM = '05797000-0000-4000-8000-000000000001';
const SET = '05797000-0000-4000-8000-000000000002';
const op = (index: number, attempt = 1) =>
  `05797000-0000-4000-8000-0000000001${index}${attempt}`.slice(0, 36);
const grant = (purpose: string) => ({
  ticket: 't'.repeat(43),
  purpose,
  expiresAt: '2026-11-28T12:00:00.000Z',
  maxRangeBytes: 33554432,
  maxUses: 10
});
const defaults = {
  operation: 'restitch',
  startImageIds: [],
  endImageIds: [],
  sourceMode: 'drive',
  fitMode: 'cover',
  finalDurationMode: 'custom',
  customFinalDurationSeconds: 2520,
  configured: true,
  updatedAt: '',
  updatedBy: null
};
const runAnswer = (index: number, attempt = 1) => ({
  state: 'run' as const,
  index,
  operationId: op(index, attempt),
  sourceGrant: grant('process_input'),
  finalizeGrant: grant('finalize'),
  defaults
});

function deps(overrides: Partial<SpaceCatalogVariantsDeps> = {}) {
  const made: string[] = [];
  const base: SpaceCatalogVariantsDeps = {
    run: vi.fn(async ({ index }) => runAnswer(index)) as never,
    canRestitch: vi.fn(async () => 'yes' as const),
    prepareScreens: vi.fn(async () => ({
      kind: 'ready' as const,
      screens: [{ slot: 'end', materialId: 'p' } as never]
    })),
    ensureImages: vi.fn(async () => undefined),
    process: vi.fn(async request => {
      made.push(request.operationId);
      return { operationId: request.operationId, state: 'succeeded', materialId: 'out' } as never;
    }),
    cancel: vi.fn(async () => undefined),
    remember: vi.fn()
  };
  return { deps: { ...base, ...overrides }, made };
}

const input = (onMade = vi.fn()) => ({
  teamId: TEAM,
  setId: SET,
  count: 3,
  signal: new AbortController().signal,
  onMade
});

describe('handing an R2 catalog’s variations to the agent', () => {
  it('makes each in turn with the server’s settings and its own pictures', async () => {
    const f = deps();
    const onMade = vi.fn();
    expect(await runSpaceCatalogVariants(input(onMade), f.deps)).toEqual({ kind: 'done' });
    expect(f.made).toEqual([op(0), op(1), op(2)]);
    expect(onMade).toHaveBeenCalledTimes(3);
    expect(f.deps.run).toHaveBeenCalledWith({
      teamId: TEAM,
      setId: SET,
      index: 0,
      toolContractVersion: 2
    });
    // Remembered as a space run before the agent is called: it is handed space-storage.
    expect(f.deps.remember).toHaveBeenCalledWith(op(0));
    expect(vi.mocked(f.deps.process).mock.calls[0]![0]).toEqual({
      operationId: op(0),
      toolId: 'restitch',
      options: {
        defaults,
        prepared: null,
        screens: [{ slot: 'end', materialId: 'p' }],
        teamId: TEAM
      },
      sourceGrant: grant('process_input'),
      finalizeGrant: grant('finalize')
    });
  });

  it('skips what is made, and closes a failed run so the server opens the next one', async () => {
    let attempt = 0;
    const f = deps({
      run: vi.fn(async ({ index }) =>
        index === 0
          ? { state: 'registered' as const, index, outputMaterialId: SET }
          : index === 1
            ? runAnswer(1, ++attempt)
            : runAnswer(index)
      ) as never,
      process: vi.fn(async request => {
        if (request.operationId === op(1, 1)) throw new Error('PROCESS_FAILED');
        return { operationId: request.operationId, state: 'succeeded', materialId: 'out' } as never;
      })
    });
    expect(await runSpaceCatalogVariants(input(), f.deps)).toEqual({ kind: 'done' });
    expect(f.deps.cancel).toHaveBeenCalledWith(TEAM, op(1, 1));
    expect(vi.mocked(f.deps.process).mock.calls.map(([request]) => request.operationId)).toEqual([
      op(1, 1),
      op(1, 2),
      op(2)
    ]);
  });

  it('waits on a variation the background agent holds and makes the rest (T106)', async () => {
    const f = deps({
      run: vi.fn(async ({ index }) =>
        index === 1 ? { state: 'background' as const, index } : runAnswer(index)
      ) as never
    });
    expect(await runSpaceCatalogVariants(input(), f.deps)).toEqual({ kind: 'waiting' });
    expect(f.made).toEqual([op(0), op(2)]);
    expect(f.deps.cancel).not.toHaveBeenCalled();
  });

  it('waits on a run the agent is already making, and ends when one cannot be made', async () => {
    const busy = deps({
      process: vi.fn(async request => {
        if (request.operationId === op(0)) throw new Error('WRONG_STATE');
        return { operationId: request.operationId, state: 'succeeded', materialId: 'out' } as never;
      })
    });
    expect(await runSpaceCatalogVariants(input(), busy.deps)).toEqual({ kind: 'waiting' });
    expect(busy.deps.cancel).not.toHaveBeenCalled();
    const ended = deps({
      run: vi.fn(async ({ index }) => ({ state: 'failed' as const, index })) as never
    });
    expect(await runSpaceCatalogVariants(input(), ended.deps)).toEqual({ kind: 'ended' });
    expect(ended.deps.process).not.toHaveBeenCalled();
  });

  it('stops on what this computer cannot do, before or during a run', async () => {
    const old = deps({ canRestitch: vi.fn(async () => 'too-old' as const) });
    expect(await runSpaceCatalogVariants(input(), old.deps)).toEqual({
      kind: 'stopped',
      code: 'AGENT_UPDATE_REQUIRED'
    });
    expect(old.deps.run).not.toHaveBeenCalled();
    const full = deps({
      process: vi.fn(async () => {
        throw Object.assign(new Error('x'), { code: 'STORAGE_QUOTA_EXCEEDED' });
      })
    });
    expect(await runSpaceCatalogVariants(input(), full.deps)).toEqual({
      kind: 'stopped',
      code: 'STORAGE_QUOTA_EXCEEDED'
    });
    expect(full.deps.cancel).not.toHaveBeenCalled();
  });

  it('stops quietly when Soty on this computer is not reachable (T119)', async () => {
    const away = deps({ canRestitch: vi.fn(async () => 'unreachable' as const) });
    // Not «update Soty»: background work may make them, and the server says when nothing does.
    expect(await runSpaceCatalogVariants(input(), away.deps)).toEqual({
      kind: 'stopped',
      code: SPACE_VARIANTS_UNREACHABLE
    });
    expect(away.deps.run).not.toHaveBeenCalled();
  });

  it('syncs the owner’s library first when the space draws no pool pictures', async () => {
    const f = deps({ prepareScreens: vi.fn(async () => ({ kind: 'legacy' as const })) });
    await runSpaceCatalogVariants({ ...input(), count: 1 }, f.deps);
    expect(f.deps.ensureImages).toHaveBeenCalledWith(TEAM, defaults);
    expect(vi.mocked(f.deps.process).mock.calls[0]![0].options).toEqual({
      defaults,
      prepared: null
    });
  });
});

describe('handing an R2 Launch’s variations to this computer’s Soty (T119)', () => {
  const OTHER = '05797000-0000-4000-8000-000000000003';
  it('makes every set of the Launch in turn, one machine per variation', async () => {
    const f = deps({
      run: vi.fn(async ({ setId, index }) =>
        setId === OTHER && index === 0
          ? { state: 'background' as const, index }
          : { ...runAnswer(index), operationId: setId === SET ? op(index) : op(index, 2) }
      ) as never
    });
    const outcome = await runSpaceVariantSets(
      {
        teamId: TEAM,
        sets: [
          { setId: SET, count: 2 },
          { setId: OTHER, count: 2 }
        ],
        signal: new AbortController().signal
      },
      f.deps
    );
    // The variation background work holds is left to it; the page looks again later.
    expect(outcome).toEqual({ kind: 'waiting' });
    expect(f.made).toEqual([op(0), op(1), op(1, 2)]);
    expect(vi.mocked(f.deps.run).mock.calls.map(([call]) => [call.setId, call.index])).toEqual([
      [SET, 0],
      [SET, 1],
      [OTHER, 0],
      [OTHER, 1]
    ]);
  });

  it('stops at the first set this computer cannot make', async () => {
    const away = deps({ canRestitch: vi.fn(async () => 'unreachable' as const) });
    expect(
      await runSpaceVariantSets(
        {
          teamId: TEAM,
          sets: [
            { setId: SET, count: 1 },
            { setId: OTHER, count: 1 }
          ],
          signal: new AbortController().signal
        },
        away.deps
      )
    ).toEqual({ kind: 'stopped', code: SPACE_VARIANTS_UNREACHABLE });
    expect(away.deps.canRestitch).toHaveBeenCalledTimes(1);
  });

  it('hands over only an R2 generation’s unfinished sets while it prepares', () => {
    const generation = (state: string, video: Record<string, unknown> | null) =>
      ({ id: 'g', state, videoGeneration: video }) as never;
    const video = {
      setId: SET,
      requestedCount: 3,
      registeredCount: 1,
      state: 'preparing',
      spaceSets: [
        { setId: SET, requestedCount: 2, registeredCount: 2 },
        { setId: OTHER, requestedCount: 1, registeredCount: 0 }
      ]
    };
    expect(spaceLaunchVariantSets(generation('accepted', video))).toEqual([
      { setId: OTHER, count: 1 }
    ]);
    // A Drive generation names no space sets; a canceled or finished one hands nothing over.
    expect(
      spaceLaunchVariantSets(generation('accepted', { ...video, spaceSets: undefined }))
    ).toEqual([]);
    expect(spaceLaunchVariantSets(generation('cancel_requested', video))).toEqual([]);
    expect(spaceLaunchVariantSets(generation('accepted', { ...video, state: 'ready' }))).toEqual(
      []
    );
    expect(spaceLaunchVariantSets(generation('accepted', null))).toEqual([]);
  });
});
