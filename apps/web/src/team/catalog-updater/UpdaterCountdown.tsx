import { useEffect, useState } from 'react';

/**
 * Time left until the updater's next round, ticking in its own leaf (023).
 *
 * Only this span re-renders every quarter second — not the header, not the dialog. It re-reads
 * the clock when the tab comes back, because a throttled background tab would otherwise show a
 * number from minutes ago (the two-factor countdown's lesson).
 */

export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  if (days > 0) return `${days}d ${pad(hours)}:${pad(minutes)}`;
  return `${hours}:${pad(minutes)}:${pad(seconds)}`;
}

export function useRemaining(targetIso: string | null, offsetMs: number): number | null {
  const read = () => (targetIso ? Date.parse(targetIso) - (Date.now() + offsetMs) : null);
  const [remaining, setRemaining] = useState<number | null>(read);

  useEffect(() => {
    const tick = () => setRemaining(read());
    tick();
    if (!targetIso) return;
    const timer = window.setInterval(tick, 250);
    const wake = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
    };
    // `read` closes over these two only.
  }, [targetIso, offsetMs]);

  return remaining;
}

export function UpdaterCountdown({
  targetIso,
  offsetMs,
  dueLabel
}: {
  targetIso: string | null;
  offsetMs: number;
  /** Shown once the time has run out and the round is being worked through. */
  dueLabel: string;
}) {
  const remaining = useRemaining(targetIso, offsetMs);
  if (remaining === null) return null;
  return (
    <span className="team-updater-countdown">
      {remaining > 0 ? formatRemaining(remaining) : dueLabel}
    </span>
  );
}
