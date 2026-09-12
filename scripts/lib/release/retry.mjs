export function retryDelay(attempt, { baseMs = 1_000, maxMs = 60_000, random = Math.random } = {}) {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 5) throw new Error('Retry attempts must be between 1 and 5');
  const capped = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(capped * (0.5 + random()));
}

/**
 * @param {{
 *   attempt: number,
 *   startedAt: string,
 *   now: string,
 *   deadlineAt?: string | null,
 *   deterministic?: boolean
 * }} timing
 */
export function retryAllowed({ attempt, startedAt, now, deadlineAt = null, deterministic = false }) {
  if (deterministic || attempt >= 5) return false;
  if (new Date(now).getTime() - new Date(startedAt).getTime() >= 15 * 60_000) return false;
  return !deadlineAt || new Date(now).getTime() < new Date(deadlineAt).getTime();
}
