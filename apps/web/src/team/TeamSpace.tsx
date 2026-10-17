import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import { LockKeyhole } from 'lucide-react';
import { useOptionalAuth } from '../auth/AuthContext';
import { Modal } from '../components/Modal';
import { ToastProvider, useToasts } from '../components/toast';
import { Button } from '../components/ui';
import { ICON_STROKE } from '../components/icons';
import { Empty } from '../components/ui/index';
import type { TeamContextSnapshot, TeamInvitationSummary } from '../api/team';
import { spaceTariffApi, teamApi } from '../api/team';
import { useI18n } from '../i18n';
import { navigateTo, useBrowserRoute, usePageEntrance } from '../lib/navigation';
import { configuredTeamDirectAddMode } from '../lib/config';
import { readRememberedSpaceId, useTeam } from './TeamContext';
import { readDriveAuthorization, type DriveAuthorizationTarget } from './drive/authorizationReturn';
import { teamErrorMessageFor } from './errors';
import { SpaceLobby } from './lobby/SpaceLobby';
import {
  buildTeamRoute,
  parseTeamRoute,
  teamResolverRoute,
  type TeamRoute,
  type TeamRouteQuery,
  type TeamSection
} from './routes';
import { spaceReadiness } from './lobby/SpaceCard';
import { CreateSpaceWizard, type CreateSpaceWizardClient } from './create/CreateSpaceWizard';
import type { WorkspaceShellClient } from './workspace/WorkspaceShell';
import {
  SpaceAccessContext,
  fallbackSpaceAccess,
  useSpaceAccess,
  type SpaceAccessClient
} from './tariffs/useSpaceAccess';
import { SpaceShowcase } from './tariffs/SpaceShowcase';
import { SpaceBlocked, type SpaceBlockedClient } from './tariffs/SpaceBlocked';
import { TariffToastNotice } from './tariffs/TariffBanner';
import { formatTariffDay, planName } from './tariffs/format';
import type { TariffContactChannel } from '@video-compressor/shared';

const WorkspaceShell = lazy(() =>
  import('./workspace/WorkspaceShell').then(module => ({ default: module.WorkspaceShell }))
);

export type TeamSpaceClient = {
  listTeams: () => Promise<TeamContextSnapshot[]>;
  /**
   * Only the count is used here — a person holding an unanswered invitation
   * must land in the lobby where they can see it, never be redirected past it.
   */
  listMyInvitations: () => Promise<TeamInvitationSummary[]>;
  acceptInvitation: (invitationId: string, token?: string) => Promise<unknown>;
  declineInvitation: (invitationId: string, token?: string) => Promise<unknown>;
} & CreateSpaceWizardClient &
  WorkspaceShellClient;

/** What the address, the loaded spaces, and the local cache add up to. */
export type TeamEntry =
  | { kind: 'checking' }
  | { kind: 'space'; teamId: string; section: TeamSection; query: TeamRouteQuery }
  | { kind: 'no-access'; taskLink: boolean }
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
  /**
   * The space a Drive authorization was started for, written down by the press
   * that left for Google (see authorizationReturn). Null when there is no note
   * to read, which is the only case left for the older guessing rules.
   */
  driveTarget: DriveAuthorizationTarget | null;
}): TeamEntry {
  const { route, teams, teamsLoaded, pendingInvitations, rememberedTeamId, driveTarget } = input;

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
    /* A link to one task says so (024): "this space is not available" is true but leaves the
       reader wondering what they were sent. Naming the task leaks nothing the address did not
       already carry. */
    return { kind: 'no-access', taskLink: Boolean(route.query.taskId) };
  }

  if (!teamsLoaded) return { kind: 'checking' };
  if (pendingInvitations !== null && pendingInvitations > 0) return { kind: 'lobby' };

  // Asked for by name, so it is not a question to answer by entering somewhere.
  // Both rules below exist to spare someone the lobby when they merely arrived
  // at `/team`; applying them to an explicit "All spaces" made the link bounce
  // straight back — and entering re-armed the remembered id that leaving had
  // just cleared, so the lobby, and with it the create wizard, could not be
  // reached at all.
  if (route.showAll) return { kind: 'lobby' };
  // The same for "make a new space": the wizard is drawn over the lobby's
  // answer, and entering a space underneath it would navigate away from it.
  if (route.create) return { kind: 'lobby' };

  /**
   * A redirect must not lose the Drive OAuth return. The parameter is what
   * tells the Drive panel to reopen folder selection, so a space entered on the
   * way back from Google opens at Settings — where that panel lives — with the
   * parameter still attached.
   */
  const spaceRoute = (spaceId: string) => {
    if (!route.driveReturn) return buildTeamRoute({ spaceId });
    // The built route already carries `?settings=1`, so the return code needs
    // `&`. Joined with a second `?` it became part of the settings value, the
    // panel never saw `drive=connected`, and coming back from Google landed on
    // the create-space wizard instead of the folder it had just authorised.
    const base = buildTeamRoute({ spaceId, section: 'explorer', query: { settings: true } });
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}drive=${encodeURIComponent(route.driveReturn)}`;
  };

  /*
   * A return from Google goes back where it came from. The note the press left
   * names the space, so there is nothing to infer: an existing space's own
   * settings reopen at the Drive panel, and a space still being created is left
   * to the wizard (which the resume effect puts back on screen) rather than
   * redirected into a settings dialog it has no business in yet.
   */
  if (route.driveReturn && driveTarget) {
    const target = teams.find(team => team.id === driveTarget.teamId);
    if (target) {
      return driveTarget.intent === 'wizard'
        ? { kind: 'lobby' }
        : { kind: 'redirect', to: spaceRoute(target.id) };
    }
  }

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
type WorkspaceAccess = 'checking' | 'allowed' | 'blocked' | 'denied';

/** 034 — the tariff calls the team surface makes besides reading access. */
export type SpaceTariffSurfaceClient = SpaceBlockedClient & {
  joinWaitlist: (plan: string | null, channel: TariffContactChannel | null) => Promise<boolean>;
};

const defaultAccessClient: SpaceAccessClient = {
  getMySpaceAccess: () => spaceTariffApi.getMySpaceAccess(),
  canAccessTeamWorkspace: () => teamApi.canAccessTeamWorkspace()
};

/**
 * Single `/team` resolver. Renders exactly one surface — the space lobby, the
 * create wizard, or the workspace shell — based on the entered-space state in
 * TeamContext plus a local create/resume flow. A cached selection skips the
 * lobby; "Change space" returns to it.
 */
export function TeamSpace({
  client = teamApi as TeamSpaceClient,
  accessClient = defaultAccessClient,
  tariffClient = spaceTariffApi,
  directAddMode = configuredTeamDirectAddMode(),
  route: routeProp
}: {
  client?: TeamSpaceClient;
  /** 034 — where `get_my_space_access` is asked; replaced in tests. */
  accessClient?: SpaceAccessClient;
  tariffClient?: SpaceTariffSurfaceClient;
  directAddMode?: 'disabled' | 'testing';
  /**
   * Parsed address for this render. The application shell supplies it; when it
   * is absent (component previews, tests mounting this surface directly) the
   * address is read — and subscribed to — here instead, so navigating inside
   * team mode still re-renders.
   */
  route?: TeamRoute;
}) {
  const { t, language } = useI18n();
  const auth = useOptionalAuth();
  // Supabase replaces the session object when a backgrounded browser returns
  // and refreshes its token. Access depends on the person and admin flag, not
  // on that short-lived token object; keeping only those primitives prevents
  // a routine token refresh from dropping the mounted workspace and every
  // dialog inside it.
  const authPresent = auth !== null;
  const authIsAdmin = auth?.isAdmin ?? false;
  const authEmail = auth?.user?.email ?? null;
  const entering = usePageEntrance();
  const browserRoute = useBrowserRoute();
  const route: TeamRoute = routeProp ??
    parseTeamRoute(browserRoute) ?? { kind: 'resolver', driveReturn: null, showAll: false };
  const { teams, activeTeam, loading, error: teamError, replaceTeams, setActiveTeamId } = useTeam();
  const [flow, setFlow] = useState<Flow>({ mode: 'browse' });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [teamsLoaded, setTeamsLoaded] = useState(false);
  const [pendingInvitations, setPendingInvitations] = useState<number | null>(null);
  const [discarding, setDiscarding] = useState<TeamContextSnapshot | null>(null);
  // Captured once: the resolver needs the value from before this session began
  // writing to it (see readRememberedSpaceId).
  const [rememberedTeamId] = useState(readRememberedSpaceId);
  // Also captured once, and for the same reason: the note a Drive press left
  // behind describes the trip that is arriving now, not a later one.
  const [driveTarget] = useState(readDriveAuthorization);
  const resumedFromDrive = useRef(false);

  /*
   * 034 — who may be here is the server's answer (R10), asked of everyone but
   * an administrator, whose spaces are internal and always open. Asked again
   * every few seconds while this person is looking at the showcase or a paused
   * space, so a grant or a renewal replaces the screen without a reload.
   */
  const [pollAccess, setPollAccess] = useState(false);
  const spaceAccess = useSpaceAccess({
    client: accessClient,
    enabled: authPresent && !authIsAdmin,
    poll: pollAccess
  });
  const access = spaceAccess.access;
  const workspaceAccess: WorkspaceAccess = !authPresent
    ? // Component-only previews do not mount AuthProvider. Keep their existing
      // supplied-team behaviour while the real application always asks the DB.
      teams.length
      ? 'allowed'
      : 'denied'
    : authIsAdmin
      ? 'allowed'
      : !access
        ? 'checking'
        : access.mode === 'workspace'
          ? 'allowed'
          : access.mode === 'blocked'
            ? 'blocked'
            : 'denied';

  const driveReturn = route.kind === 'resolver' ? route.driveReturn : null;

  /*
   * A Drive OAuth redirect returns to `/team?drive=...` and resets local flow.
   * A space still being created is put back into the wizard's folder step, so
   * the person who just authorized can pick the folder instead of hunting for
   * their half-made space in the lobby. The parameter comes from the parsed
   * route rather than a second read of `location.search`, so there is one
   * answer to "what does this URL mean" (routes.ts) rather than two.
   *
   * Which space that is, is read and never guessed. This used to resume the
   * first owned space that was not ready — so returning from an existing
   * space's settings opened the create wizard, for some other space, and the
   * wizard's own state then outlived the redirect that was meant to take the
   * person back. Granting access in Google led straight back to "connect with
   * Google", forever. With no note to read, nothing is resumed: the return
   * enters a space instead, which is somewhere rather than a circle.
   */
  useEffect(() => {
    if (resumedFromDrive.current) return;
    if (!driveReturn || !driveTarget || driveTarget.intent !== 'wizard') return;
    const resumable = teams.find(team => team.id === driveTarget.teamId && team.role === 'owner');
    if (resumable) {
      resumedFromDrive.current = true;
      setFlow({ mode: 'resume', teamId: resumable.id });
    }
  }, [driveReturn, driveTarget, teams]);

  useEffect(() => {
    // The production TeamProvider already owns this read. Waiting for its
    // result avoids simultaneous duplicate list_my_teams RPCs while a fresh
    // browser tab is establishing its Supabase session.
    if (client === teamApi) {
      if (!loading) {
        setLoadError(teamError ? t('teamSpaceLoadFailed') : null);
        setTeamsLoaded(true);
      }
      return;
    }
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
  }, [client, loading, replaceTeams, t, teamError]);

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

  /*
   * A space the server now says is open, that this tab does not list yet — a
   * grant, a renewal, an accepted invitation. The list is read again once per
   * change, so the address that showed the showcase or the paused screen opens
   * the space itself.
   */
  const allowedKey = (access?.teams ?? [])
    .map(team => `${team.teamId}:${team.accessState}`)
    .sort()
    .join(',');
  // Either way round: a space opened that this tab does not list, or a space
  // paused that it still lists (the list drops paused spaces, R10).
  const listIsStale = (access?.teams ?? []).some(team =>
    team.accessState === 'allowed'
      ? !teams.some(known => known.id === team.teamId)
      : teams.some(known => known.id === team.teamId)
  );
  const refreshedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!listIsStale || refreshedFor.current === allowedKey) return;
    refreshedFor.current = allowedKey;
    void client
      .listTeams()
      .then(replaceTeams)
      .catch(() => undefined);
  }, [allowedKey, client, listIsStale, replaceTeams]);

  // Every team surface renders through `wrap`, so mounting the toast provider
  // here — rather than per surface — is what lets an outcome outlive the thing
  // that started it: a dialog closes, a row unmounts, the toast stays readable.
  const entry = useMemo(
    () =>
      resolveTeamEntry({
        route,
        teams,
        teamsLoaded,
        pendingInvitations,
        rememberedTeamId,
        driveTarget
      }),
    [driveTarget, pendingInvitations, rememberedTeamId, route, teams, teamsLoaded]
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
      <SpaceAccessContext.Provider value={authPresent && !authIsAdmin ? spaceAccess : null}>
        <ToastProvider>
          <MembershipLostNotice />
          <TariffToastNotice />
          <Suspense fallback={<section className="team-space-lobby" aria-busy="true" />}>
            {node}
          </Suspense>
        </ToastProvider>
      </SpaceAccessContext.Provider>
    </main>
  );

  /*
   * A space this person belongs to that is paused (034, US6.2): the address is
   * kept, the paused screen is drawn at it, and the space comes back at the
   * same address when the plan is renewed.
   */
  const routedSpaceId = route.kind === 'space' ? route.spaceId : null;
  const blockedTeams = (access?.teams ?? []).filter(team => team.accessState === 'blocked');
  const blockedRouteTeam = routedSpaceId
    ? (blockedTeams.find(team => team.teamId === routedSpaceId) ?? null)
    : null;
  const showsBlocked =
    workspaceAccess === 'blocked' ||
    (workspaceAccess === 'allowed' &&
      blockedRouteTeam !== null &&
      !teams.some(team => team.id === blockedRouteTeam.teamId));
  const showsShowcase = workspaceAccess === 'denied';
  const shouldPoll = authPresent && !authIsAdmin && (showsBlocked || showsShowcase);
  useEffect(() => {
    setPollAccess(shouldPoll);
  }, [shouldPoll]);

  const contactEmail = access?.showcase?.email || authEmail || '';

  if (workspaceAccess === 'checking') {
    // Labeled: an unexplained dimmed screen is indistinguishable from a hang.
    return wrap(
      <section className="team-space-lobby" aria-busy="true">
        <p className="team-workspace-gate-checking" aria-live="polite">
          {t('teamAccessChecking')}
        </p>
      </section>
    );
  }

  if (showsShowcase) {
    return wrap(
      <SpaceShowcase
        access={access ?? fallbackSpaceAccess(false)}
        email={authEmail}
        client={{
          joinWaitlist: (plan, channel) => tariffClient.joinWaitlist(plan, channel),
          acceptInvitation: invitationId => client.acceptInvitation(invitationId)
        }}
        onAccepted={teamId => {
          spaceAccess.recheck();
          void client
            .listTeams()
            .then(replaceTeams)
            .catch(() => undefined)
            .finally(() =>
              navigateTo(teamId ? buildTeamRoute({ spaceId: teamId }) : teamResolverRoute(), true)
            );
        }}
      />
    );
  }

  if (showsBlocked) {
    const shown = blockedRouteTeam ? [blockedRouteTeam] : blockedTeams;
    return wrap(
      <div className="flex flex-col gap-4">
        {shown.map(team => (
          <SpaceBlocked
            key={team.teamId}
            team={team}
            contact={access?.showcase?.contact}
            email={contactEmail}
            client={tariffClient}
          />
        ))}
      </div>
    );
  }

  /* 034, US1.3 — a tariff waiting for its space names itself on the wizard. */
  const pendingTariff = access?.canCreate ? access.pendingTariff : null;
  const wizardHeading = pendingTariff
    ? t('tariffCreateHeading', {
        plan: planName(pendingTariff, language),
        date: formatTariffDay(pendingTariff.endsOn, language)
      })
    : undefined;
  const createForTariff =
    pendingTariff !== null &&
    teamsLoaded &&
    teams.length === 0 &&
    route.kind === 'resolver' &&
    !route.showAll;

  // Asked for by address — from the space switcher — as well as by the lobby's
  // own button (024, FR-048).
  const createAsked = (route.kind === 'resolver' && route.create === true) || createForTariff;
  if (flow.mode !== 'browse' || createAsked) {
    return wrap(
      <CreateSpaceWizard
        client={client}
        heading={wizardHeading}
        resumeTeamId={flow.mode === 'resume' ? flow.teamId : null}
        onCancel={() => {
          setFlow({ mode: 'browse' });
          // Cancelling goes back to wherever the wizard was opened from — a
          // space, usually — rather than to a lobby nobody asked for. Reached
          // with no history behind it (a pasted link), there is nowhere to go
          // back to, and the lobby is the honest answer.
          if (!createAsked) return;
          // A tariff with no space yet has nothing behind the wizard but home.
          if (createForTariff) navigateTo('/', true);
          else if (window.history.length > 1) window.history.back();
          else navigateTo(teamResolverRoute({ showAll: true }), true);
        }}
        onCreated={teamId => {
          setFlow({ mode: 'browse' });
          // `replace` when the wizard had its own address, so Back from the new
          // space does not walk into a wizard for a space that now exists.
          navigateTo(buildTeamRoute({ spaceId: teamId }), createAsked);
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
      <section
        /* Centred and in a panel, like every other whole-screen state: this one
           was a bare heading pinned to the top-left corner of the hexagons, and
           it is a screen a stranger can reach from a shared link. */
        className="team-space-lobby team-space-lobby-empty team-space-no-access"
        aria-labelledby="team-no-access"
      >
        {/* 020 dressed this by hand; it is the shared pattern now, so the next
            whole-screen state inherits the treatment rather than copying it. */}
        <Empty
          className="team-space-no-access-card"
          size="lg"
          icon={<LockKeyhole size={26} strokeWidth={ICON_STROKE} />}
          /* This state is the screen, so its title is the screen's heading. */
          titleAs="h2"
          title={<span id="team-no-access">{t('teamSpaceNoAccessTitle')}</span>}
          description={t(entry.taskLink ? 'teamSpaceNoAccessTask' : 'teamSpaceNoAccessBody')}
          action={
            <Button
              type="button"
              color="primary"
              onClick={() => {
                // `replace`: a dead address should not sit in history waiting
                // for Back to walk into it again.
                setActiveTeamId(null);
                navigateTo(teamResolverRoute(), true);
              }}
            >
              {t('teamSpaceNoAccessAction')}
            </Button>
          }
        />
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
    <>
      <SpaceLobby
        teams={teams}
        loading={loading}
        error={loadError}
        onEnter={teamId => navigateTo(buildTeamRoute({ spaceId: teamId }))}
        onResume={teamId => setFlow({ mode: 'resume', teamId })}
        onCreate={() => setFlow({ mode: 'create' })}
        onDeleteDraft={setDiscarding}
        invitationClient={client}
      />
      {discarding && (
        <DiscardDraftDialog
          space={discarding}
          client={client}
          onClose={() => setDiscarding(null)}
          onDiscarded={() => {
            setDiscarding(null);
            replaceTeams(teams.filter(team => team.id !== discarding.id));
          }}
        />
      )}
    </>
  );
}

/**
 * Explains a membership that ended mid-session, then returns to the lobby.
 *
 * Lives inside the toast provider because that is where the explanation goes;
 * the signal itself is raised by the realtime channel in TeamContext, one level
 * above. Sticky, because a message that dismisses itself while the screen is
 * also changing underneath is a message nobody reads (FR-019).
 */
/**
 * Confirms discarding a space that never finished setup.
 *
 * The confirmation names what is lost rather than asking "are you sure?", and
 * the server still decides whether the space really is a draft — a space that
 * has ever had a drive connection is refused with `TEAM_NOT_DRAFT`, which is
 * the case where discarding would actually destroy something.
 */
function DiscardDraftDialog({
  space,
  client,
  onClose,
  onDiscarded
}: {
  space: TeamContextSnapshot;
  client: Pick<TeamSpaceClient, 'deleteDraftTeam'>;
  onClose: () => void;
  onDiscarded: () => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const [busy, setBusy] = useState(false);
  const titleId = useId();

  const discard = async () => {
    setBusy(true);
    try {
      await client.deleteDraftTeam(space.id);
      push({ tone: 'success', text: t('teamDraftDeleteDone') });
      onDiscarded();
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal labelledBy={titleId} size="sm" onClose={onClose}>
      <h3 id={titleId}>{t('teamDraftDeleteConfirmTitle', { name: space.name })}</h3>
      <p>{t('teamDraftDeleteConfirmBody')}</p>
      <div className="team-dialog-actions">
        <Button type="button" variant="danger" loading={busy} onClick={() => void discard()}>
          {t('teamDraftDeleteAction')}
        </Button>
        <Button type="button" variant="secondary" onClick={onClose}>
          {t('teamCancel')}
        </Button>
      </div>
    </Modal>
  );
}

export function MembershipLostNotice() {
  const { t } = useI18n();
  const { push } = useToasts();
  const { membershipLostTeamId, acknowledgeMembershipLoss } = useTeam();

  useEffect(() => {
    if (!membershipLostTeamId) return;
    push({ tone: 'error', text: t('teamMembershipLost'), sticky: true });
    acknowledgeMembershipLoss();
    navigateTo(teamResolverRoute(), true);
  }, [acknowledgeMembershipLoss, membershipLostTeamId, push, t]);

  return null;
}

export default TeamSpace;
