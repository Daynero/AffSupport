import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react';
import type { TeamPermissionFlag, TeamPermissions } from '@video-compressor/shared';
import type { TeamContextSnapshot } from '../api/team';
import { useTeamRealtime, type TeamRealtimeState } from './useTeamRealtime';

const ACTIVE_TEAM_STORAGE_KEY = 'wishly.active-team.v1';

export interface TeamContextValue {
  teams: TeamContextSnapshot[];
  activeTeamId: string | null;
  activeTeam: TeamContextSnapshot | null;
  permissions: TeamPermissions | null;
  loading: boolean;
  error: string | null;
  revision: number;
  realtimeState: TeamRealtimeState;
  /** True once the user has an explicitly entered, still-valid space. */
  hasEnteredSpace: boolean;
  setActiveTeamId: (teamId: string | null) => void;
  /** Enter a space and persist the choice (lobby → workspace). */
  enterSpace: (teamId: string) => void;
  /** Leave the current space back to the lobby ("Change space"). */
  leaveSpace: () => void;
  replaceTeams: (teams: TeamContextSnapshot[]) => void;
  refreshTeams: () => Promise<void>;
  notifyStateChanged: () => void;
  can: (permission: TeamPermissionFlag) => boolean;
}

const TeamContext = createContext<TeamContextValue | null>(null);

function persistedTeamId(): string | null {
  if (typeof window === 'undefined') return null;
  const value = window.localStorage.getItem(ACTIVE_TEAM_STORAGE_KEY);
  return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

export function TeamProvider({
  children,
  initialTeams = [],
  loading = false,
  client,
  realtime = true
}: {
  children: ReactNode;
  initialTeams?: TeamContextSnapshot[];
  loading?: boolean;
  client?: { listTeams: () => Promise<TeamContextSnapshot[]> };
  realtime?: boolean;
}) {
  const [teams, setTeams] = useState<TeamContextSnapshot[]>(initialTeams);
  const [loadingTeams, setLoadingTeams] = useState(Boolean(client));
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [activeTeamId, setActiveTeamIdState] = useState<string | null>(() => persistedTeamId());

  // No implicit `teams[0]` fallback: "no space entered" is a first-class state
  // that renders the lobby. A persisted id that no longer resolves to a team
  // (deleted / membership lost) yields null and is cleared by the sync effect.
  const activeTeam = useMemo(
    () => teams.find(team => team.id === activeTeamId) ?? null,
    [activeTeamId, teams]
  );

  useEffect(() => {
    // Clear a stale persisted selection once teams have loaded; keep an
    // as-yet-unresolved id while the first load is still in flight.
    if (activeTeamId && teams.length > 0 && !activeTeam) setActiveTeamIdState(null);
  }, [activeTeam, activeTeamId, teams.length]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (activeTeamId) window.localStorage.setItem(ACTIVE_TEAM_STORAGE_KEY, activeTeamId);
    else window.localStorage.removeItem(ACTIVE_TEAM_STORAGE_KEY);
  }, [activeTeamId]);

  const setActiveTeamId = useCallback((teamId: string | null) => {
    if (teamId === null || /^[0-9a-f-]{36}$/i.test(teamId)) setActiveTeamIdState(teamId);
  }, []);

  const enterSpace = useCallback((teamId: string) => setActiveTeamId(teamId), [setActiveTeamId]);
  const leaveSpace = useCallback(() => setActiveTeamId(null), [setActiveTeamId]);

  const replaceTeams = useCallback((nextTeams: TeamContextSnapshot[]) => {
    setTeams(nextTeams);
  }, []);

  const refreshTeams = useCallback(async () => {
    if (!client) return;
    setLoadingTeams(true);
    try {
      const nextTeams = await client.listTeams();
      setTeams(nextTeams);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'INVALID_RESPONSE');
    } finally {
      setLoadingTeams(false);
    }
  }, [client]);

  useEffect(() => {
    if (client) void refreshTeams();
  }, [client, refreshTeams]);

  const notifyStateChanged = useCallback(() => {
    setRevision(value => value + 1);
  }, []);

  const handleRealtimeRefetch = useCallback(async () => {
    await refreshTeams();
    setRevision(value => value + 1);
  }, [refreshTeams]);

  const handleMembershipLost = useCallback(() => {
    setTeams(current => current.filter(team => team.id !== activeTeamId));
    setRevision(value => value + 1);
  }, [activeTeamId]);

  const realtimeState = useTeamRealtime({
    teamId: activeTeam?.id ?? null,
    onRefetch: handleRealtimeRefetch,
    onMembershipLost: handleMembershipLost,
    enabled: realtime
  });

  const can = useCallback(
    (permission: TeamPermissionFlag) => activeTeam?.permissions[permission] === true,
    [activeTeam]
  );

  const value = useMemo<TeamContextValue>(
    () => ({
      teams,
      activeTeamId: activeTeam?.id ?? null,
      activeTeam,
      permissions: activeTeam?.permissions ?? null,
      loading: loading || loadingTeams,
      error,
      revision,
      realtimeState,
      hasEnteredSpace: activeTeam !== null,
      setActiveTeamId,
      enterSpace,
      leaveSpace,
      replaceTeams,
      refreshTeams,
      notifyStateChanged,
      can
    }),
    [
      activeTeam,
      can,
      enterSpace,
      error,
      leaveSpace,
      loading,
      loadingTeams,
      notifyStateChanged,
      realtimeState,
      refreshTeams,
      replaceTeams,
      revision,
      setActiveTeamId,
      teams
    ]
  );

  return <TeamContext.Provider value={value}>{children}</TeamContext.Provider>;
}

export function TeamContextOverride({
  value,
  children
}: {
  value: TeamContextValue;
  children: ReactNode;
}) {
  return <TeamContext.Provider value={value}>{children}</TeamContext.Provider>;
}

export function useTeam(): TeamContextValue {
  const value = useContext(TeamContext);
  if (!value) throw new Error('useTeam must be used inside TeamProvider');
  return value;
}

export function useOptionalTeam(): TeamContextValue | null {
  return useContext(TeamContext);
}

export function selectEffectivePermissions(value: TeamContextValue): TeamPermissions | null {
  return value.activeTeam?.permissions ?? null;
}

export function selectCan(value: TeamContextValue, permission: TeamPermissionFlag): boolean {
  return value.activeTeam?.permissions[permission] === true;
}
