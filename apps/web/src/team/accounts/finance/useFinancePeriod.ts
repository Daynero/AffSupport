import { useCallback, useEffect, useRef, useState } from 'react';
import { financeToday } from '@video-compressor/shared';

function dayAt(milliseconds: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(milliseconds));
  const p = (name: string) => parts.find(p => p.type === name)!.value;
  return `${p('year')}-${p('month')}-${p('day')}`;
}
/** A single local midnight alarm, including DST; no network polling. */
export function useFinancePeriod(blocked: boolean, fixedTimezone?: string) {
  const [timezone, setTimezone] = useState(
    fixedTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  );
  const [today, setToday] = useState(() => financeToday(timezone));
  const [selected, setSelected] = useState(today);
  const following = useRef(true);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const setDate = useCallback(
    (date: string) => {
      following.current = date === financeToday(timezone);
      setSelected(date);
    },
    [timezone]
  );
  useEffect(() => {
    if (!blocked && following.current) setSelected(today);
  }, [blocked, today]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      const zone = fixedTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      setTimezone(zone);
      const current = financeToday(zone);
      setToday(current);
      if (!blockedRef.current && following.current) setSelected(current);
      clearTimeout(timer);
      let low = Date.now();
      let high = low + 36 * 60 * 60 * 1000;
      while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        if (dayAt(mid, zone) === current) low = mid;
        else high = mid;
      }
      timer = setTimeout(refresh, Math.max(1, high - Date.now() + 1));
    };
    const foreground = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    refresh();
    window.addEventListener('focus', foreground);
    document.addEventListener('visibilitychange', foreground);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', foreground);
      document.removeEventListener('visibilitychange', foreground);
    };
  }, [fixedTimezone]);
  return { date: selected, today, timezone, setDate };
}
