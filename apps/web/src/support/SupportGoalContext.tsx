import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react';
import type { SupportGoalRow } from '../lib/database.types';
import { getSupabaseClient } from '../lib/supabase';
import { parseSupportGoal, SUPPORT_GOAL_SELECT } from './goals';

type SupportGoalContextValue = {
  goal: SupportGoalRow | null;
  loading: boolean;
  refresh: () => Promise<void>;
};

const fallback: SupportGoalContextValue = {
  goal: null,
  loading: false,
  refresh: async () => {}
};

const SupportGoalContext = createContext<SupportGoalContextValue>(fallback);
const LOCAL_DEV_AUTH = import.meta.env.VITE_LOCAL_DEV_AUTH === 'true';
const SHOW_LOCAL_GOAL_PREVIEW = LOCAL_DEV_AUTH && import.meta.env.DEV;
const localGoalPreview: SupportGoalRow = {
  id: '00000000-0000-4000-8000-000000000099',
  slug: 'mac-updates-apple-developer',
  currency: 'USD',
  target_cents: 9900,
  raised_cents: 3700,
  title_en: 'Get rid of reinstalls',
  title_uk: 'Позбутися перевстановлень',
  description_en:
    'Right now, every update means downloading the DMG again and going through the same manual ritual. The $99 goal covers the first year of the Apple Developer Program. That will let me sign and notarize Wishly, then add safe updates directly inside the app — without repeated downloads, manual replacement, or Terminal commands.',
  description_uk:
    'Зараз кожне оновлення означає знову завантажити DMG, і інші танці з бубном. Щоб це прибрати, потрібні $99 на перший рік Apple Developer Program. Це дозволить підписувати й нотаризувати Wishly, а далі — зробити безпечне оновлення прямо із застосунку: без повторних завантажень, ручної заміни та команд у Terminal.',
  status: 'active',
  created_at: '2026-07-31T00:00:00.000Z',
  updated_at: '2026-07-31T00:00:00.000Z'
};

/**
 * Loads the one published goal once for the persistent application shell and
 * keeps every open Wishly tab in sync with admin/database changes.
 */
export function SupportGoalProvider({ children }: { children: ReactNode }) {
  const [goal, setGoal] = useState<SupportGoalRow | null>(
    SHOW_LOCAL_GOAL_PREVIEW ? localGoalPreview : null
  );
  const [loading, setLoading] = useState(true);
  // Installable Wishly Dev builds use a synthetic profile and must stay
  // completely isolated from production Supabase, even for public goal reads.
  const supabase = LOCAL_DEV_AUTH ? null : getSupabaseClient();

  const refresh = useCallback(async () => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from('support_goals')
      .select(SUPPORT_GOAL_SELECT)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle();
    if (!error) setGoal(parseSupportGoal(data));
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    let active = true;
    const guardedRefresh = async () => {
      if (!active) return;
      await refresh();
    };
    void guardedRefresh();

    const channel = supabase
      .channel('wishly-support-goal')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'support_goals' }, payload => {
        if (!active) return;
        const next = parseSupportGoal(payload.new);
        if (next?.status === 'active') {
          setGoal(next);
          setLoading(false);
        } else {
          void guardedRefresh();
        }
      })
      .subscribe(status => {
        if (status === 'SUBSCRIBED') void guardedRefresh();
      });

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void guardedRefresh();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onVisibility);
      void supabase.removeChannel(channel);
    };
  }, [refresh, supabase]);

  const value = useMemo(() => ({ goal, loading, refresh }), [goal, loading, refresh]);
  return <SupportGoalContext.Provider value={value}>{children}</SupportGoalContext.Provider>;
}

export function useSupportGoal(): SupportGoalContextValue {
  return useContext(SupportGoalContext);
}
