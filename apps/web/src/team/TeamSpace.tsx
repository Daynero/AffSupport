import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useOptionalAuth } from '../auth/AuthContext';
import { Modal, ModalBackdrop } from '../components/Modal';
import { SupportDialog } from '../components/SupportDialog';
import { ToastProvider } from '../components/toast';
import { Button } from '../components/ui';
import { requireSupabaseClient } from '../lib/supabase';
import type { TeamContextSnapshot } from '../api/team';
import { teamApi } from '../api/team';
import { useI18n } from '../i18n';
import { navigateTo, useBrowserRoute, usePageEntrance } from '../lib/navigation';
import { configuredTeamDirectAddMode } from '../lib/config';
import { readRememberedSpaceId, useTeam } from './TeamContext';
import {
  buildTeamRoute,
  parseTeamRoute,
  teamResolverRoute,
  type TeamRoute,
  type TeamRouteQuery,
  type TeamSection
} from './routes';
import { SpaceLobby } from './lobby/SpaceLobby';
import { spaceReadiness } from './lobby/SpaceCard';
import { CreateSpaceWizard, type CreateSpaceWizardClient } from './create/CreateSpaceWizard';
import { WorkspaceShell, type WorkspaceShellClient } from './workspace/WorkspaceShell';

export type TeamSpaceClient = {
  listTeams: () => Promise<TeamContextSnapshot[]>;
  /**
   * Only the count is used here — a person holding an unanswered invitation
   * must land in the lobby where they can see it, never be redirected past it.
   */
  listMyInvitations: () => Promise<{ state: string }[]>;
} & CreateSpaceWizardClient &
  WorkspaceShellClient;

/** What the address, the loaded spaces, and the local cache add up to. */
export type TeamEntry =
  | { kind: 'checking' }
  | { kind: 'space'; teamId: string; section: TeamSection; query: TeamRouteQuery }
  | { kind: 'no-access' }
  | { kind: 'lobby' }
  | { kind: 'redirect'; to: string };

/**
 * The one place that decides which surface a `/team*` address opens (D14).
 *
 * Order, and why it is this order:
 *   1. an explicit space in the URL always wins — a shared link, a refresh, and
 *      the Back button all have to mean what they say, ahead of any local cache;
 *   2. a pending invitation holds the lobby, because being redirected past an
 *      unanswered invitation is how people never see it;
 *   3. one ready space is not a choice, so it is entered rather than presented;
 *   4. the remembered space is a convenience and comes last.
 *
 * A pure function, so the order is testable without mounting the app.
 */
export function resolveTeamEntry(input: {
  route: TeamRoute;
  teams: TeamContextSnapshot[];
  /** False while the first `listTeams` is still in flight. */
  teamsLoaded: boolean;
  /** Null while the invitation probe is unresolved or failed. */
  pendingInvitations: number | null;
  rememberedTeamId: string | null;
}): TeamEntry {
  const { route, teams, teamsLoaded, pendingInvitations, rememberedTeamId } = input;

  if (route.kind === 'space') {
    const known = teams.some(team => team.id === route.spaceId);
    if (known) {
      return {
        kind: 'space',
        teamId: route.spaceId,
        section: route.section,
        query: route.query
      };
    }
    if (!teamsLoaded) return { kind: 'checking' };
    // Absent and denied are the same answer on purpose (001 FR-016): the
    // membership list is all this client can see, so it cannot leak the
    // difference even by accident.
    return { kind: 'no-access' };
  }

  if (!teamsLoaded) return { kind: 'checking' };
  if (pendingInvitations !== null && pendingInvitations > 0) return { kind: 'lobby' };

  /**
   * A redirect must not lose the Drive OAuth return. The parameter is what
   * tells the Drive panel to reopen folder selection, so a space entered on the
   * way back from Google opens at Settings — where that panel lives — with the
   * parameter still attached.
   */
  const spaceRoute = (spaceId: string) =>
    route.driveReturn
      ? `${buildTeamRoute({ spaceId, section: 'settings' })}?drive=${encodeURIComponent(route.driveReturn)}`
      : buildTeamRoute({ spaceId });

  const ready = teams.filter(team => spaceReadiness(team) === 'ready');
  if (ready.length === 1 && ready[0]) {
    return { kind: 'redirect', to: spaceRoute(ready[0].id) };
  }

  // No readiness test here, unlike the rule above: "remembered" means the space
  // this person was last in, and a mid-setup space they were working on is
  // exactly the one they want reopened.
  const remembered = rememberedTeamId
    ? (teams.find(team => team.id === rememberedTeamId) ?? null)
    : null;
  if (remembered) {
    return { kind: 'redirect', to: spaceRoute(remembered.id) };
  }

  return { kind: 'lobby' };
}

type Flow = { mode: 'browse' } | { mode: 'create' } | { mode: 'resume'; teamId: string };
type WorkspaceAccess = 'checking' | 'allowed' | 'denied';

/**
 * Single `/team` resolver. Renders exactly one surface — the space lobby, the
 * create wizard, or the workspace shell — based on the entered-space state in
 * TeamContext plus a local create/resume flow. A cached selection skips the
 * lobby; "Change space" returns to it.
 */
export function TeamSpace({
  client = teamApi as TeamSpaceClient,
  directAddMode = configuredTeamDirectAddMode(),
  route: routeProp
}: {
  client?: TeamSpaceClient;
  directAddMode?: 'disabled' | 'testing';
  /**
   * Parsed address for this render. The application shell supplies it; when it
   * is absent (component previews, tests mounting this surface directly) the
   * address is read — and subscribed to — here instead, so navigating inside
   * team mode still re-renders.
   */
  route?: TeamRoute;
}) {
  const { t } = useI18n();
  const auth = useOptionalAuth();
  const entering = usePageEntrance();
  const browserRoute = useBrowserRoute();
  const route: TeamRoute = routeProp ??
    parseTeamRoute(browserRoute) ?? { kind: 'resolver', driveReturn: null };
  const { teams, activeTeam, loading, replaceTeams, setActiveTeamId } = useTeam();
  const [flow, setFlow] = useState<Flow>({ mode: 'browse' });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [teamsLoaded, setTeamsLoaded] = useState(false);
  const [pendingInvitations, setPendingInvitations] = useState<number | null>(null);
  // Captured once: the resolver needs the value from before this session began
  // writing to it (see readRememberedSpaceId).
  const [rememberedTeamId] = useState(readRememberedSpaceId);
  const [waitlistState, setWaitlistState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [gateOpen, setGateOpen] = useState(true);
  const [supportOpen, setSupportOpen] = useState(false);
  const [workspaceAccess, setWorkspaceAccess] = useState<WorkspaceAccess>(() => {
    // Component-only previews do not mount AuthProvider. Keep their existing
    // supplied-team behavior while the real application always asks the DB.
    if (!auth) return teams.length ? 'allowed' : 'denied';
    return auth.isAdmin ? 'allowed' : 'checking';
  });
  const gateTitleId = useId();
  const resumedFromDrive = useRef(false);

  const driveReturn = route.kind === 'resolver' ? route.driveReturn : null;

  // A Drive OAuth redirect returns to `/team?drive=...` and resets local flow.
  // Resume the mid-setup owned space back into the wizard's folder step so the
  // user does not have to re-find it in the lobby. The parameter comes from the
  // parsed route rather than a second read of `location.search`, so there is one
  // answer to "what does this URL mean" (routes.ts) rather than two.
  useEffect(() => {
    if (resumedFromDrive.current) return;
    if (!driveReturn) return;
    const resumable = teams.find(team => team.role === 'owner' && spaceReadiness(team) !== 'ready');
    if (resumable) {
      resumedFromDrive.current = true;
      setFlow({ mode: 'resume', teamId: resumable.id });
    }
  }, [driveReturn, teams]);

  useEffect(() => {
    let active = true;
    void client
      .listTeams()
      .then(value => {
        if (!active) return;
        replaceTeams(value);
        setLoadError(null);
      })
      .catch(() => {
        if (active) setLoadError(t('teamSpaceLoadFailed'));
      })
      .finally(() => {
        // "Loaded" means the question was answered, not that it succeeded — a
        // failed load must still stop the resolver from waiting forever.
        if (active) setTeamsLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [client, replaceTeams, t]);

  // Non-blocking: an invitation the user has not answered holds them in the
  // lobby where they can see it. If the probe fails there is no count, and the
  // resolver simply carries on without the rule.
  useEffect(() => {
    let active = true;
    void client
      .listMyInvitations()
      .then(value => {
        if (active) {
          setPendingInvitations(value.filter(invitation => invitation.state === 'pending').length);
        }
      })
      .catch(() => {
        if (active) setPendingInvitations(null);
      });
    return () => {
      active = false;
    };
  }, [client]);

  useEffect(() => {
    let active = true;
    if (!auth) {
      setWorkspaceAccess(teams.length ? 'allowed' : 'denied');
      return () => {
        active = false;
      };
    }
    if (auth.isAdmin) {
      setWorkspaceAccess('allowed');
      return () => {
        active = false;
      };
    }

    setWorkspaceAccess('checking');
    try {
      void requireSupabaseClient()
        .rpc('can_access_team_workspace')
        .then(
          ({ data, error }) => {
            if (active) setWorkspaceAccess(!error && data === true ? 'allowed' : 'denied');
          },
          () => {
            if (active) setWorkspaceAccess('denied');
          }
        );
    } catch {
      setWorkspaceAccess('denied');
    }
    return () => {
      active = false;
    };
  }, [auth, auth?.isAdmin, auth?.user?.id, teams.length]);

  // Every team surface renders through `wrap`, so mounting the toast provider
  // here — rather than per surface — is what lets an outcome outlive the thing
  // that started it: a dialog closes, a row unmounts, the toast stays readable.
  const entry = useMemo(
    () => resolveTeamEntry({ route, teams, teamsLoaded, pendingInvitations, rememberedTeamId }),
    [pendingInvitations, rememberedTeamId, route, teams, teamsLoaded]
  );

  // A redirect is a correction to the address, not a step in the user's
  // history: `replace` keeps Back from bouncing off it.
  const redirectTo = entry.kind === 'redirect' ? entry.to : null;
  useEffect(() => {
    if (redirectTo) navigateTo(redirectTo, true);
  }, [redirectTo]);

  // TeamContext still owns "which space is active" for realtime and permission
  // reads; the URL is what sets it.
  const routedTeamId = entry.kind === 'space' ? entry.teamId : null;
  useEffect(() => {
    if (routedTeamId) setActiveTeamId(routedTeamId);
  }, [routedTeamId, setActiveTeamId]);

  const wrap = (node: React.ReactNode) => (
    <main className={`page-container team-space-page ${entering ? 'page-enter' : ''}`.trim()}>
      <ToastProvider>{node}</ToastProvider>
    </main>
  );

  const joinWaitlist = async () => {
    if (waitlistState === 'saving' || waitlistState === 'saved') return;
    setWaitlistState('saving');
    const { error } = await requireSupabaseClient().rpc('join_team_workspace_waitlist');
    setWaitlistState(error ? 'error' : 'saved');
  };

  const closeWorkspaceGate = () => {
    setGateOpen(false);
    navigateTo('/', true);
  };

  const openSupport = () => {
    setGateOpen(false);
    setSupportOpen(true);
  };

  const closeSupport = () => {
    setSupportOpen(false);
    navigateTo('/', true);
  };

  if (workspaceAccess === 'checking') {
    return wrap(
      <>
        <div className="team-workspace-gate-background" aria-busy="true" />
        <ModalBackdrop className="team-workspace-gate-backdrop" />
      </>
    );
  }

  if (workspaceAccess === 'denied') {
    return wrap(
      <>
        <div className="team-workspace-gate-background" aria-hidden="true" />
        {gateOpen && (
          <Modal
            labelledBy={gateTitleId}
            className="team-workspace-gate"
            backdropClassName="team-workspace-gate-backdrop"
            initialFocus="[data-team-waitlist]"
            onClose={closeWorkspaceGate}
          >
            <p className="team-workspace-eyebrow">{t('teamWorkspace')}</p>
            <h2 id={gateTitleId}>{t('teamWorkspaceGateTitle')}</h2>
            <p>{t('teamWorkspaceGateBody')}</p>
            <div className="team-workspace-gate-actions">
              <Button
                variant="primary"
                data-team-waitlist="true"
                loading={waitlistState === 'saving'}
                disabled={waitlistState === 'saved'}
                onClick={() => void joinWaitlist()}
              >
                {t(
                  waitlistState === 'saved' ? 'teamWorkspaceWaitlistSaved' : 'teamWorkspaceWaitlist'
                )}
              </Button>
              <Button onClick={openSupport}>{t('teamWorkspaceAccelerate')}</Button>
            </div>
            {waitlistState === 'error' && (
              <p className="support-error" role="alert">
                {t('teamWorkspaceWaitlistError')}
              </p>
            )}
          </Modal>
        )}
        {supportOpen && <SupportDialog onClose={closeSupport} />}
      </>
    );
  }

  if (flow.mode !== 'browse') {
    return wrap(
      <CreateSpaceWizard
        client={client}
        resumeTeamId={flow.mode === 'resume' ? flow.teamId : null}
        onCancel={() => setFlow({ mode: 'browse' })}
        onCreated={teamId => {
          setFlow({ mode: 'browse' });
          navigateTo(buildTeamRoute({ spaceId: teamId }));
        }}
      />
    );
  }

  if (entry.kind === 'checking' || entry.kind === 'redirect') {
    // Labeled, not a bare ellipsis: the reader is told what is being waited on.
    return wrap(
      <section className="team-space-lobby" aria-busy="true">
        <p aria-live="polite">{t('teamSpaceResolving')}</p>
      </section>
    );
  }

  if (entry.kind === 'no-access') {
    // One screen for "does not exist" and "you are not a member". It names no
    // space and shows no counts, so the address cannot be used to probe.
    return wrap(
      <section className="team-space-lobby team-space-no-access" aria-labelledby="team-no-access">
        <div className="team-space-lobby-empty-copy">
          <h1 id="team-no-access">{t('teamSpaceNoAccessTitle')}</h1>
          <p>{t('teamSpaceNoAccessBody')}</p>
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              // `replace`: a dead address should not sit in history waiting for
              // Back to walk into it again.
              setActiveTeamId(null);
              navigateTo(teamResolverRoute(), true);
            }}
          >
            {t('teamSpaceNoAccessAction')}
          </Button>
        </div>
      </section>
    );
  }

  if (entry.kind === 'space' && activeTeam?.id === entry.teamId) {
    return wrap(
      <WorkspaceShell
        key={`shell:${entry.teamId}`}
        teamId={entry.teamId}
        client={client}
        directAddMode={directAddMode}
        section={entry.section}
        query={entry.query}
      />
    );
  }

  if (entry.kind === 'space') {
    // The address resolved but TeamContext has not caught up for one render.
    return wrap(
      <section className="team-space-lobby" aria-busy="true">
        <p aria-live="polite">{t('teamSpaceResolving')}</p>
      </section>
    );
  }

  return wrap(
    <SpaceLobby
      teams={teams}
      loading={loading}
      error={loadError}
      onEnter={teamId => navigateTo(buildTeamRoute({ spaceId: teamId }))}
      onResume={teamId => setFlow({ mode: 'resume', teamId })}
      onCreate={() => setFlow({ mode: 'create' })}
    />
  );
}

export default TeamSpace;
