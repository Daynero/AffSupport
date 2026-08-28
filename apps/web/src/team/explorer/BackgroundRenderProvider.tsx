import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import {
  normalizeCatalogSearchRequest,
  teamBackgroundRenderSupported,
  type CatalogSearchRequestInput,
  type CatalogSearchResponse,
  type LandingRenderPointer,
  type TeamLandingAgentRenderResult,
  type TeamLandingRenderJob
} from '@video-compressor/shared';

/**
 * Landing renders prepared in the background (011, FR-014/FR-018).
 *
 * The local app cannot mint its own grants, so the loop lives here: while a
 * paired local app reports the background-render contract and this computer
 * is not paused, the space's landings without a ready render are rendered one
 * at a time through the same route a member's click would use. The renderer
 * runs under the local app's power governor, so the lowest setting still
 * holds. Pausing is per computer and survives a reload.
 */
export interface BackgroundRenderClient {
  searchCatalog: (
    teamId: string,
    request: CatalogSearchRequestInput
  ) => Promise<CatalogSearchResponse>;
  /** Optional on the shell client; without them there is nothing to render with. */
  listLandingRenders?: (
    teamId: string,
    materialIds: string[],
    preset: string
  ) => Promise<LandingRenderPointer[]>;
  startLandingRender?: (
    teamId: string,
    materialId: string,
    preset: string
  ) => Promise<TeamLandingRenderJob>;
}

export interface BackgroundRenderAgent {
  paired: boolean;
  toolContracts: Partial<Record<string, number>>;
  render: (
    job: TeamLandingRenderJob,
    signal?: AbortSignal
  ) => Promise<TeamLandingAgentRenderResult>;
}

export interface BackgroundRenderValue {
  /** Whether this computer can take renders at all right now. */
  available: boolean;
  paused: boolean;
  setPaused: (paused: boolean) => void;
  /** The material being rendered, if any. */
  activeMaterialId: string | null;
  /** How many landings still lack a ready render, as of the last look. */
  pending: number;
  /** Look again now (a realtime revision, a manual refresh). */
  poke: () => void;
}

const BackgroundRenderContext = createContext<BackgroundRenderValue | null>(null);
const PAUSE_KEY = 'soty.team.backgroundRender.paused';
const IDLE_LOOK_MS = 60_000;
const PAGE_SIZE = 50;

function readPaused(): boolean {
  try {
    return localStorage.getItem(PAUSE_KEY) === '1';
  } catch {
    return false;
  }
}

export function BackgroundRenderProvider({
  teamId,
  client,
  agent,
  revision = 0,
  onRendered,
  children
}: {
  teamId: string;
  client: BackgroundRenderClient;
  agent: BackgroundRenderAgent;
  revision?: number;
  /** A render landed; the caller re-reads whatever shows tiles. */
  onRendered?: () => void;
  children: ReactNode;
}) {
  const [paused, setPausedState] = useState<boolean>(() => readPaused());
  const [activeMaterialId, setActive] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [tick, setTick] = useState(0);
  const running = useRef(false);
  const stopped = useRef(false);

  const available =
    agent.paired &&
    teamBackgroundRenderSupported(agent.toolContracts) &&
    typeof client.listLandingRenders === 'function' &&
    typeof client.startLandingRender === 'function';

  const setPaused = useCallback((next: boolean) => {
    setPausedState(next);
    try {
      localStorage.setItem(PAUSE_KEY, next ? '1' : '0');
    } catch {
      // A browser that refuses storage still gets the in-memory switch.
    }
  }, []);

  const poke = useCallback(() => setTick(value => value + 1), []);

  /** One landing without a ready render, oldest first, or null. */
  const findCandidate = useCallback(async (): Promise<{
    materialId: string;
    total: number;
  } | null> => {
    const request = normalizeCatalogSearchRequest({
      query: '',
      filters: { category: ['landing'] },
      page: 1,
      pageSize: PAGE_SIZE
    });
    if (!request) return null;
    const result = await client.searchCatalog(teamId, request);
    const ids = result.items.map(item => item.id);
    if (ids.length === 0) return { materialId: '', total: 0 };
    if (!client.listLandingRenders) return null;
    const renders = await client.listLandingRenders(teamId, ids, 'default');
    const byMaterial = new Map(renders.map(render => [render.materialId, render] as const));
    const waiting = ids.filter(id => {
      const render = byMaterial.get(id);
      return !render || render.state === 'stale';
    });
    return { materialId: waiting[0] ?? '', total: waiting.length };
  }, [client, teamId]);

  useEffect(() => {
    stopped.current = false;
    if (!available || paused) {
      setPending(0);
      return;
    }
    let timer: number | null = null;
    const look = async () => {
      if (running.current || stopped.current) return;
      running.current = true;
      try {
        const candidate = await findCandidate();
        if (stopped.current) return;
        setPending(candidate?.total ?? 0);
        if (!candidate || !candidate.materialId) return;
        setActive(candidate.materialId);
        if (!client.startLandingRender) return;
        const job = await client.startLandingRender(teamId, candidate.materialId, 'default');
        if (stopped.current) return;
        await agent.render(job);
        onRendered?.();
        // Straight on to the next one; the governor paces the renderer itself.
        timer = window.setTimeout(() => void look(), 250);
      } catch {
        // A failed render is recorded server-side and not retried in a loop;
        // the next look skips it because its state is no longer "none".
        timer = window.setTimeout(() => void look(), IDLE_LOOK_MS);
      } finally {
        running.current = false;
        setActive(null);
      }
    };
    void look();
    const idle = window.setInterval(() => void look(), IDLE_LOOK_MS);
    return () => {
      stopped.current = true;
      window.clearInterval(idle);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [agent, available, client, findCandidate, onRendered, paused, revision, teamId, tick]);

  const value = useMemo<BackgroundRenderValue>(
    () => ({ available, paused, setPaused, activeMaterialId, pending, poke }),
    [activeMaterialId, available, paused, pending, poke, setPaused]
  );

  return (
    <BackgroundRenderContext.Provider value={value}>{children}</BackgroundRenderContext.Provider>
  );
}

export function BackgroundRenderContextOverride({
  value,
  children
}: {
  value: BackgroundRenderValue;
  children: ReactNode;
}) {
  return (
    <BackgroundRenderContext.Provider value={value}>{children}</BackgroundRenderContext.Provider>
  );
}

export function useOptionalBackgroundRender(): BackgroundRenderValue | null {
  return useContext(BackgroundRenderContext);
}
