import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgent } from '../AgentContext';
import type { AnalyticsTool } from '../analytics/events';
import { safeErrorCode } from '../analytics/errors';
import { trackToolReady } from '../analytics/readiness';

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

export interface ToolStateReadOptions {
  /**
   * 031 FR-051 — the tool whose `tool_ready` this read decides: emitted once per transition
   * into `connected`, `success` on the first read that lands, `failure` once the retries are
   * spent. Absent, nothing is tracked.
   */
  tool?: AnalyticsTool;
}

export function useToolStateRead<T>(
  read: () => Promise<T>,
  apply: (value: T) => void,
  options: ToolStateReadOptions = {}
): { stateError: boolean; retry: () => void } {
  const { connection, attempt } = useAgent();
  const [stateError, setStateError] = useState(false);
  const [revision, setRevision] = useState(0);
  const latest = useRef({ read, apply, tool: options.tool });
  latest.current = { read, apply, tool: options.tool };

  // One readiness verdict per connected period: when it began, and whether it was given.
  const readiness = useRef<{ since: number; reported: boolean } | null>(null);
  if (connection !== 'connected') readiness.current = null;
  else if (readiness.current === null) readiness.current = { since: Date.now(), reported: false };
  const reportReady = (outcome: 'success' | 'failure', error?: unknown) => {
    const current = readiness.current;
    const tool = latest.current.tool;
    if (!tool || !current || current.reported) return;
    current.reported = true;
    trackToolReady({
      tool,
      outcome,
      durationMs: Date.now() - current.since,
      ...(outcome === 'failure'
        ? { stage: 'initial_read' as const, errorCode: safeErrorCode(error) }
        : {})
    });
  };
  const reportReadyRef = useRef(reportReady);
  reportReadyRef.current = reportReady;

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
          reportReadyRef.current('success');
        })
        .catch((error: unknown) => {
          if (!active) return;
          tries += 1;
          if (tries <= STATE_READ_RETRIES) timer = setTimeout(run, STATE_READ_RETRY_MS);
          else {
            setStateError(true);
            reportReadyRef.current('failure', error);
          }
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
