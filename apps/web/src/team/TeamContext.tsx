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
import type { TeamPermissionFlag, TeamPermissions } from '@video-compressor/shared';
import type { TeamContextSnapshot } from '../api/team';
import { navigateTo, useBrowserRoute } from '../lib/navigation';
import { buildTeamRoute, teamResolverRoute } from './routes';
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
  /**
   * Set when a realtime event says this membership ended mid-session. The
   * surface reacts by explaining and returning to the lobby; a silent bounce is
   * what this replaces (FR-019).
   */
  membershipLostTeamId: string | null;
  acknowledgeMembershipLoss: () => void;
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
  retryRealtime: () => void;
  can: (permission: TeamPermissionFlag) => boolean;
}

const TeamContext = createContext<TeamContextValue | null>(null);

function persistedTeamId(): string | null {
  if (typeof window === 'undefined') return null;
  const value = window.localStorage.getItem(ACTIVE_TEAM_STORAGE_KEY);
  return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

/**
 * The device-local "space you were last in", read as it stood before this
 * session started changing it. The entry resolver needs the *remembered* value,
 * not the live one, or entering a space by URL would immediately look like a
 * remembered preference and the two rules would be indistinguishable.
 */
export function readRememberedSpaceId(): string | null {
  return persistedTeamId();
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
  const teamsRef = useRef(teams);
  teamsRef.current = teams;
  const [loadingTeams, setLoadingTeams] = useState(Boolean(client));
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [realtimeRetryNonce, setRealtimeRetryNonce] = useState(0);
  const [activeTeamId, setActiveTeamIdState] = useState<string | null>(() => persistedTeamId());
  const activeTeamIdRef = useRef(activeTeamId);
  activeTeamIdRef.current = activeTeamId;

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
    if (activeTeamId && !loadingTeams && !activeTeam) setActiveTeamIdState(null);
  }, [activeTeam, activeTeamId, loadingTeams]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (activeTeamId) window.localStorage.setItem(ACTIVE_TEAM_STORAGE_KEY, activeTeamId);
    else window.localStorage.removeItem(ACTIVE_TEAM_STORAGE_KEY);
  }, [activeTeamId]);

  const setActiveTeamId = useCallback((teamId: string | null) => {
    if (teamId === null || /^[0-9a-f-]{36}$/i.test(teamId)) setActiveTeamIdState(teamId);
  }, []);

  // Entering and leaving are address changes, not state changes: the URL is the
  // truth about which space is open, and `setActiveTeamId` exists so the
  // resolver can reflect that address back into context — not as a second way in.
  const enterSpace = useCallback((teamId: string) => {
    navigateTo(buildTeamRoute({ spaceId: teamId }));
  }, []);
  // Leaving is a destination, not just an exit: `/team` on its own is the
  // address the resolver answers by entering somewhere, so leaving to it walked
  // straight back in and re-armed the remembered space it had just cleared.
  const leaveSpace = useCallback(() => {
    setActiveTeamId(null);
    navigateTo(teamResolverRoute({ showAll: true }));
  }, [setActiveTeamId]);

  const replaceTeams = useCallback((nextTeams: TeamContextSnapshot[]) => {
    setTeams(nextTeams);
  }, []);

  const [membershipLostTeamId, setMembershipLostTeamId] = useState<string | null>(null);
  const refreshTeams = useCallback(
    async (strict = false) => {
      if (!client) return;
      setLoadingTeams(true);
      try {
        const nextTeams = await client.listTeams();
        const selected = activeTeamIdRef.current;
        if (
          selected &&
          teamsRef.current.some(team => team.id === selected) &&
          !nextTeams.some(team => team.id === selected)
        ) {
          setMembershipLostTeamId(selected);
        }
        setTeams(nextTeams);
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'INVALID_RESPONSE');
        if (strict) throw cause;
      } finally {
        setLoadingTeams(false);
      }
    },
    [client]
  );

  useEffect(() => {
    if (client) void refreshTeams();
  }, [client, refreshTeams]);

  const notifyStateChanged = useCallback(() => {
    setRevision(value => value + 1);
  }, []);
  const retryRealtime = useCallback(() => {
    setRealtimeRetryNonce(value => value + 1);
  }, []);

  const handleRealtimeRefetch = useCallback(async () => {
    await refreshTeams(true);
    setRevision(value => value + 1);
  }, [refreshTeams]);
  const acknowledgeMembershipLoss = useCallback(() => setMembershipLostTeamId(null), []);

  /*
   * A space is open only while it is on the screen (024).
   *
   * Pressing the logo shows the tools again, but the space went on living behind them: its
   * realtime channel stayed subscribed and every change in it woke this tab. The space closes
   * when the address leaves it; which space to reopen is remembered, and `/team` walks back in.
   */
  const insideSpace = useBrowserRoute().startsWith('/team');
  const realtimeState = useTeamRealtime({
    teamId: insideSpace ? (activeTeam?.id ?? null) : null,
    onRefetch: handleRealtimeRefetch,
    retryNonce: realtimeRetryNonce,
    enabled: realtime && insideSpace
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
      membershipLostTeamId,
      acknowledgeMembershipLoss,
      hasEnteredSpace: activeTeam !== null,
      setActiveTeamId,
      enterSpace,
      leaveSpace,
      replaceTeams,
      refreshTeams,
      notifyStateChanged,
      retryRealtime,
      can
    }),
    [
      acknowledgeMembershipLoss,
      activeTeam,
      can,
      enterSpace,
      error,
      leaveSpace,
      loading,
      loadingTeams,
      membershipLostTeamId,
      notifyStateChanged,
      retryRealtime,
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
