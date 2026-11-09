import { expect, it, vi } from 'vitest';
import { STITCH_ERROR_CODES } from '@video-compressor/shared';
import { settleCatalogVariantProcess } from '../apps/agent/src/team-bridge/catalog-variant-closure';
const operation = 'c1680000-0000-4000-8000-000000000010',
  output = 'c1680000-0000-4000-8000-000000000011';
it('all closed local stitch failures are bookkept only after the original bridge finally drains', async () => {
  for (const code of STITCH_ERROR_CODES) {
    let drained = false;
    const complete = vi.fn(async () => {
      expect(drained).toBe(true);
      return { kind: 'terminal', operationId: operation, state: 'failed' };
    });
    await expect(
      settleCatalogVariantProcess({
        operationId: operation,
        signal: new AbortController().signal,
        run: async () => {
          try {
            throw Error(code);
          } finally {
            await Promise.resolve();
            drained = true;
          }
        },
        complete
      })
    ).rejects.toThrow(code);
    expect(complete).toHaveBeenCalledWith('failed', code);
  }
});
it('a known local failure can read back original registered success instead of making another process', async () => {
  const complete = vi.fn(async () => ({
    kind: 'registered',
    operationId: operation,
    outputId: output
  }));
  expect(
    await settleCatalogVariantProcess({
      operationId: operation,
      signal: new AbortController().signal,
      run: async () => {
        throw Error('RESTITCH_SCREEN_PREVIOUS_FAILURES');
      },
      complete
    })
  ).toMatchObject({ operationId: operation, materialId: output, state: 'succeeded' });
});
it('unknown upload ownership stays uncertain rather than rewriting it as an image failure', async () => {
  await expect(
    settleCatalogVariantProcess({
      operationId: operation,
      signal: new AbortController().signal,
      run: async () => {
        throw Error('STITCH_TOOL_FAILED');
      },
      complete: async () => ({ kind: 'unknown', operationId: operation })
    })
  ).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
});
it('uncertain interruption and unrecognized raw failure never request terminal bookkeeping', async () => {
  const complete = vi.fn(),
    controller = new AbortController();
  controller.abort(Error('PROCESS_RESULT_UNCERTAIN'));
  await expect(
    settleCatalogVariantProcess({
      operationId: operation,
      signal: controller.signal,
      run: async () => {
        throw Error('PROCESS_CANCELED');
      },
      complete
    })
  ).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  await expect(
    settleCatalogVariantProcess({
      operationId: operation,
      signal: new AbortController().signal,
      run: async () => {
        throw Error('https://private-provider/path');
      },
      complete
    })
  ).rejects.toThrow();
  expect(complete).not.toHaveBeenCalled();
});
it('closes a source failure from cancellation before the 30s heartbeat only after drained work and fresh exact cancellation proof', async () => {
  let drained = false;
  const timeline: string[] = [];
  const complete = vi.fn(async () => {
    expect(drained).toBe(true);
    timeline.push('canonical-canceled');
    return { kind: 'terminal', operationId: operation, state: 'canceled' };
  });
  await expect(
    settleCatalogVariantProcess({
      operationId: operation,
      signal: new AbortController().signal,
      run: async () => {
        try {
          throw Error('PROCESS_RESULT_UNCERTAIN');
        } finally {
          drained = true;
          timeline.push('drained');
        }
      },
      cancellationRequested: async () => {
        expect(drained).toBe(true);
        timeline.push('fresh-canceled');
        return true;
      },
      complete
    })
  ).rejects.toThrow('PROCESS_CANCELED');
  expect(complete).toHaveBeenCalledWith('canceled', 'PROCESS_CANCELED');
  expect(timeline).toEqual(['drained', 'fresh-canceled', 'canonical-canceled']);
});
it.each(['unknown', 'network'] as const)(
  'retains uncertain source failure when fresh cancellation is %s',
  async mode => {
    const complete = vi.fn();
    await expect(
      settleCatalogVariantProcess({
        operationId: operation,
        signal: new AbortController().signal,
        run: async () => {
          throw Error('PROCESS_RESULT_UNCERTAIN');
        },
        cancellationRequested: async () => {
          if (mode === 'network') throw Error('NETWORK');
          return false;
        },
        complete
      })
    ).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
    expect(complete).not.toHaveBeenCalled();
  }
);
it('registered output wins late cancellation while started-upload uncertainty stays unknown', async () => {
  const input = {
    operationId: operation,
    signal: new AbortController().signal,
    run: async () => {
      throw Error('PROCESS_RESULT_UNCERTAIN');
    },
    cancellationRequested: async () => true
  };
  await expect(
    settleCatalogVariantProcess({
      ...input,
      complete: async () => ({ kind: 'registered', operationId: operation, outputId: output })
    })
  ).resolves.toMatchObject({ state: 'succeeded', materialId: output });
  await expect(
    settleCatalogVariantProcess({
      ...input,
      complete: async () => ({ kind: 'unknown', operationId: operation })
    })
  ).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
});
