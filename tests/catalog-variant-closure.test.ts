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
// 072: a full disk or a Drive refusal closes the variant with its own code, even once its upload
// began (the server answers 'unknown' where an output may exist), instead of PROCESS_FAILED or
// silence while the round waited.
it.each(['DISK_FULL', 'NEEDS_REAUTH', 'DRIVE_STORAGE_FULL'])(
  'reports %s with its own code',
  async code => {
    const complete = vi.fn(async () => ({
      kind: 'terminal',
      operationId: operation,
      state: 'failed'
    }));
    await expect(
      settleCatalogVariantProcess({
        operationId: operation,
        signal: new AbortController().signal,
        run: async () => {
          throw Object.assign(new Error(code), { uploadStarted: true });
        },
        complete
      })
    ).rejects.toThrow(code);
    expect(complete.mock.calls).toEqual([['failed', code]]);
  }
);
it('falls back to PROCESS_FAILED where an older server does not know the code yet', async () => {
  const complete = vi
    .fn<(outcome: 'canceled' | 'failed', code: string) => Promise<Record<string, unknown>>>()
    .mockRejectedValueOnce(new Error('INVALID_INPUT'))
    .mockResolvedValue({ kind: 'terminal', operationId: operation, state: 'failed' });
  await expect(
    settleCatalogVariantProcess({
      operationId: operation,
      signal: new AbortController().signal,
      run: async () => {
        throw Error('DRIVE_STORAGE_FULL');
      },
      complete,
      reportDelaysMs: []
    })
  ).rejects.toThrow('DRIVE_STORAGE_FULL');
  expect(complete.mock.calls).toEqual([
    ['failed', 'DRIVE_STORAGE_FULL'],
    ['failed', 'PROCESS_FAILED']
  ]);
});
it('never repeats a code the server refused as input when it is not one of the new ones', async () => {
  const complete = vi.fn(async () => {
    throw new Error('INVALID_INPUT');
  });
  await expect(
    settleCatalogVariantProcess({
      operationId: operation,
      signal: new AbortController().signal,
      run: async () => {
        throw Error('STITCH_TOOL_FAILED');
      },
      complete,
      reportDelaysMs: []
    })
  ).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  expect(complete).toHaveBeenCalledOnce();
});
