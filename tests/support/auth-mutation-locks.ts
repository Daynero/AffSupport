/** Deterministic cooperative Web Locks model; real SDK/storage still run in tests. */
export function createTestAuthLocks(): Pick<LockManager, 'request'> {
  const tails = new Map<string, Promise<void>>();
  return {
    request: async (
      name: string,
      options: { signal?: AbortSignal },
      run: () => Promise<unknown>
    ) => {
      const previous = tails.get(name) ?? Promise.resolve();
      let release!: () => void;
      const tail = new Promise<void>(resolve => {
        release = resolve;
      });
      tails.set(name, tail);
      await previous;
      try {
        if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return await run();
      } finally {
        release();
        if (tails.get(name) === tail) tails.delete(name);
      }
    }
  } as unknown as Pick<LockManager, 'request'>;
}

export function createTestAuthMutationStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    }
  };
}
