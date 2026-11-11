import { useEffect, useState } from 'react';

/** True once `flag` has stayed true for `ms` without interruption. */
export function useSustained(flag: boolean, ms: number): boolean {
  const [sustained, setSustained] = useState(false);
  useEffect(() => {
    if (!flag) {
      setSustained(false);
      return;
    }
    const timer = setTimeout(() => setSustained(true), ms);
    return () => clearTimeout(timer);
  }, [flag, ms]);
  return flag && sustained;
}
