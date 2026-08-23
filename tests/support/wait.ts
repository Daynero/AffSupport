/**
 * The one polling helper.
 *
 * Six near-identical `until` / `waitFor` functions were defined across the test tree, plus
 * a seventh inside the end-to-end script. They differed only in their deadline and in how
 * unhelpful their timeout message was.
 *
 * Poll, do not sleep. A fixed `setTimeout` is either slower than it needs to be or flaky
 * under load, and it is the single largest source of both in this suite.
 */

export interface WaitOptions {
  /** Give up after this long. */
  timeoutMs?: number;
  /** How often to re-check. Small, because the point is to finish as soon as it is true. */
  intervalMs?: number;
  /** Named in the failure so a timeout says what never happened. */
  describe?: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_INTERVAL_MS = 10;

/**
 * Resolves once `condition` returns truthy. Rejects with a message naming what was being
 * waited for, which is the difference between a useful CI failure and "waitFor timed out".
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: WaitOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const startedAt = Date.now();
  let lastError: unknown = null;

  for (;;) {
    try {
      if (await condition()) return;
    } catch (error) {
      // A condition that throws while the system is still settling is normal — reading a
      // file that does not exist yet, for example. Keep the error so a timeout can report
      // why the last attempt failed rather than only that it did.
      lastError = error;
    }
    if (Date.now() - startedAt > timeoutMs) {
      const what = options.describe ?? 'condition';
      const because =
        lastError instanceof Error ? ` Last attempt threw: ${lastError.message}` : '';
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}.${because}`);
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

/**
 * Resolves with the first non-null, non-undefined value `produce` returns.
 *
 * The common shape where a test needs the value it was waiting for, not just the fact that
 * it arrived — otherwise every caller re-reads it immediately after `waitFor` and races
 * with whatever changed it.
 */
export async function waitForValue<T>(
  produce: () => T | null | undefined | Promise<T | null | undefined>,
  options: WaitOptions = {}
): Promise<T> {
  let captured: T | null = null;
  await waitFor(
    async () => {
      const value = await produce();
      if (value === null || value === undefined) return false;
      captured = value;
      return true;
    },
    options
  );
  // waitFor either assigned this or threw.
  return captured as T;
}
