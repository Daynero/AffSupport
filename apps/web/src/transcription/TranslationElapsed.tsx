import { useEffect, useState } from 'react';
import { formatMediaTime } from './TranscriptPlayer';

/**
 * "elapsed · ~remaining", ticking on its own.
 *
 * Anchored to the agent's `startedAt`, so the reading is continuous across the list, a
 * reopened viewer and a preemption — never a stopwatch that restarts when a component
 * mounts. The half-second tick lives here so it re-renders one span, not the viewer.
 */
export function TranslationElapsed({
  startedAt,
  percent
}: {
  startedAt: number | null;
  /** 0–100, or null while nothing determinate is known. */
  percent: number | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [startedAt]);
  const elapsedMs = startedAt ? Math.max(0, now - startedAt) : 0;
  const etaMs =
    percent !== null && percent > 0 && percent < 100 && elapsedMs > 0
      ? (elapsedMs * (100 - percent)) / percent
      : null;
  return (
    <span className="transcript-translation-elapsed">
      {percent !== null && `${percent}% · `}
      {startedAt !== null && formatMediaTime(elapsedMs / 1000)}
      {etaMs !== null && ` · ~${formatMediaTime(etaMs / 1000)}`}
    </span>
  );
}
