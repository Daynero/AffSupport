import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A write that never drops the latest value (tasks' progress and status).
 *
 * The card used to refuse a second change while the first was still saving, and disabled the scale
 * meanwhile — so a quick second drag was ignored while the knob seemed to take it. Now a change made
 * during a save is held, merged with anything else held, and sent the moment the save returns: the
 * last thing a person chose is the thing stored, however fast they move.
 */
export function useCoalescedWrite<T>(input: {
  write: (value: T) => Promise<void>;
  merge?: (held: T, next: T) => T;
  onError: (error: unknown) => void;
}): { send: (value: T) => void; saving: boolean; savingRef: { readonly current: boolean } } {
  const writeRef = useRef(input.write);
  writeRef.current = input.write;
  const mergeRef = useRef(input.merge);
  mergeRef.current = input.merge;
  const errorRef = useRef(input.onError);
  errorRef.current = input.onError;

  const savingRef = useRef(false);
  const held = useRef<{ value: T } | null>(null);
  const mounted = useRef(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const send = useCallback((value: T) => {
    if (savingRef.current) {
      const merge = mergeRef.current;
      held.current = { value: held.current && merge ? merge(held.current.value, value) : value };
      return;
    }
    savingRef.current = true;
    setSaving(true);
    void (async () => {
      let next: { value: T } | null = { value };
      try {
        while (next) {
          await writeRef.current(next.value);
          next = held.current;
          held.current = null;
        }
      } catch (error) {
        held.current = null;
        // A write that fails after the page left still leaves the server as it was; nothing to show.
        if (mounted.current) errorRef.current(error);
      } finally {
        savingRef.current = false;
        if (mounted.current) setSaving(false);
      }
    })();
  }, []);

  return { send, saving, savingRef };
}
