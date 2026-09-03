/**
 * Is this computer's clock wrong enough to break every code? (feature 016)
 *
 * A time-based code is a function of the clock, so a device minutes out of step
 * produces codes every service rejects — and the natural conclusion is that the
 * stored keys are wrong, not that the clock is. That is a bad hour to hand
 * someone, and it costs one response header to avoid.
 *
 * One `HEAD` to the page's own origin, and the `Date` header it comes back with.
 * No time server, no third-party origin, so the content-security policy is
 * unchanged and there is nothing new to trust. When the request fails, or the
 * header is missing, the answer is simply "no warning" — a check that cannot
 * run must not invent a problem.
 */

import { TOTP_STEP_SECONDS } from '@video-compressor/shared';

/**
 * A third of a step. Smaller than this and codes still work — services accept a
 * step either side — so warning would be noise; larger and they start failing.
 */
export const CLOCK_SKEW_TOLERANCE_MS = (TOTP_STEP_SECONDS / 3) * 1000;

export interface ClockSkew {
  /** Server time minus local time. Positive means this computer is behind. */
  offsetMs: number;
  warn: boolean;
}

export async function measureClockSkew(signal?: AbortSignal): Promise<ClockSkew | null> {
  try {
    const sentAt = Date.now();
    const response = await fetch(location.origin, {
      method: 'HEAD',
      cache: 'no-store',
      signal
    });
    const header = response.headers.get('date');
    if (!header) return null;
    const serverMs = Date.parse(header);
    if (Number.isNaN(serverMs)) return null;

    // Charge the round trip to the reading rather than to the clock: the
    // response was written somewhere inside it, and the midpoint is the least
    // wrong single guess.
    const receivedAt = Date.now();
    const offsetMs = serverMs - (sentAt + receivedAt) / 2;
    return { offsetMs, warn: Math.abs(offsetMs) > CLOCK_SKEW_TOLERANCE_MS };
  } catch {
    // Offline, blocked, or aborted. Not knowing is not the same as being wrong.
    return null;
  }
}
