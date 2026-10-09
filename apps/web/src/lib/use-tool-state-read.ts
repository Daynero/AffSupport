import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgent } from '../AgentContext';

/**
 * A tool page's first read of its state, done again after every recovery (032, FR-005).
 *
 * The three tool pages each read their snapshot once "when connected" and swallowed the
 * failure. After a loss and a recovery the page was back to `connected` with no snapshot,
 * every input disabled, and nothing on screen to say why (research W12). This runs the read
 * on every transition into `connected` and after every attempt that ends connected (a
 * re-check that never left `connected` still re-reads: the agent may have restarted), keeps
 * a failed read as `stateError` after a few quick retries, and lets the page say so.
 */

/** Quick retries before a read is called failed: 2 s apart, three times. */
export const STATE_READ_RETRY_MS = 2_000;
export const STATE_READ_RETRIES = 3;

export function useToolStateRead<T>(
  read: () => Promise<T>,
  apply: (value: T) => void
): { stateError: boolean; retry: () => void } {
  const { connection, attempt } = useAgent();
  const [stateError, setStateError] = useState(false);
  const [revision, setRevision] = useState(0);
  const latest = useRef({ read, apply });
  latest.current = { read, apply };

  // Each attempt that ends while connected is a recovery to re-read after.
  const lastAttempt = useRef<string | null>(null);
  useEffect(() => {
    if (attempt) {
      lastAttempt.current = attempt.id;
      return;
    }
    if (lastAttempt.current === null) return;
    lastAttempt.current = null;
    if (connection === 'connected') setRevision(value => value + 1);
  }, [attempt, connection]);

  useEffect(() => {
    if (connection !== 'connected') return;
    let active = true;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      latest.current
        .read()
        .then(value => {
          if (!active) return;
          setStateError(false);
          latest.current.apply(value);
        })
        .catch(() => {
          if (!active) return;
          tries += 1;
          if (tries <= STATE_READ_RETRIES) timer = setTimeout(run, STATE_READ_RETRY_MS);
          else setStateError(true);
        });
    };
    run();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [connection, revision]);

  const retry = useCallback(() => setRevision(value => value + 1), []);
  return { stateError, retry };
}
