/*
 * The account page (024, US29).
 *
 * ## What a person comes here to do
 *
 * Six things, in the order they happen: change the name teammates see, switch
 * the language, answer an invitation, find out whether the app on this computer
 * is current and update it, sign out, and — almost never — leave. The page that
 * was here answered none of them first.
 *
 * It opened with an invitations card that, for nearly everyone nearly always,
 * said only that there were no invitations. Under it a profile form ended in a
 * honey "Save changes" that shouted whether or not anything had changed, and
 * that held a language choice and a newsletter tick hostage until it was
 * pressed. Under that a key/value grid repeated the email for the third time on
 * one screen, and folded the installed version, the result of the update check
 * and the failure of that check into one sentence that wrapped over three
 * lines: "1.1.1 (could not check for updates)". Nothing said what the local app
 * *is*, and nothing on a page called "your account" said which spaces the
 * person belongs to or let them go to one.
 *
 * ## What it is now
 *
 * Benchmarked on Linear's account settings and Notion's "My account": one
 * column of reading width, one card per concern, and a filled button only where
 * pressing it does something. The cards are the space settings' own
 * `SettingsSection` — icon, title, the current state as a word on the title
 * line — so this page and that dialog are visibly one product.
 *
 *   Invitations   only while one is waiting. Otherwise it is one muted line
 *                 inside Spaces, which is where a person looks for it.
 *   Profile       the name saves on blur or Enter; the language and the
 *                 newsletter write the moment they are changed. There is no
 *                 Save: the state word on the title line says "Saving…",
 *                 "Saved" or "Could not save". The email is shown once, here,
 *                 with where it comes from, because it cannot be edited.
 *   Spaces        every space with the person's role and a way in.
 *   Local app     what it is, in a sentence; the version as a value; the update
 *                 check as a chip of its own; the download only when there is
 *                 something to download. The beta environment is a footnote.
 *   Session       sign out, and what signing out does not take away.
 *
 * Account deletion has no UI in this product (the edge function exists; the
 * control was removed on purpose), so there is no danger zone to draw.
 *
 * ## Two things the code decided
 *
 * Writes go through `useCoalescedWrite`: a language flip made while the name is
 * still saving is held, merged into one patch and sent when the first returns,
 * so the last thing chosen is the thing stored.
 *
 * The invitation list is fetched once and shared. `InvitationList` owns accept
 * and decline (one implementation, shared with the lobby); this page needs only
 * the count, to decide whether the card exists. Both read the same promise.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Languages, LogOut, MonitorSmartphone, UserRound, UsersRound } from 'lucide-react';
import { useAuth, type EditableProfilePatch } from '../auth/AuthContext';
import { analytics } from '../analytics/service';
import { useAgent } from '../AgentContext';
import { markAgentInstallStarted } from '../api/client';
import { teamApi, type TeamContextSnapshot } from '../api/team';
import { ICON_STROKE } from '../components/icons';
import { ToastProvider } from '../components/toast';
import {
  Button,
  Card,
  Chip,
  FormField,
  Input,
  Link,
  SegmentedControl,
  Skeleton,
  Switch,
  type UiColor
} from '../components/ui/index';
import { UserAvatar } from '../components/UserAvatar';
import { useI18n, type Language, type TranslationKey } from '../i18n';
import { configuredEnvironment } from '../lib/config';
import type { Profile } from '../lib/database.types';
import { internalLink, usePageEntrance } from '../lib/navigation';
import { installedReleaseStatus, preferredDownload } from '../release-manifest';
import { InvitationList, type InvitationListClient } from '../team/lobby/InvitationList';
import { buildTeamRoute } from '../team/routes';
import { useOptionalTeam } from '../team/TeamContext';
import { useCoalescedWrite } from '../team/tasks/useCoalescedWrite';
import { SettingsSection } from '../team/workspace/SettingsSection';

type Translator = ReturnType<typeof useI18n>['t'];

export default function AccountPage() {
  const { profile, user } = useAuth();
  const { t } = useI18n();
  const entering = usePageEntrance();
  // Remembers that this mount showed the skeleton, so the real content
  // crossfades in (content-appear) instead of popping when the profile lands.
  const sawSkeleton = useRef(false);

  useEffect(() => {
    document.title = `${t('accountTitle')} — Soty`;
  }, [t]);

  if (!profile || !user) {
    sawSkeleton.current = true;
    return (
      <main
        className={`account-page page-container${entering ? ' page-enter' : ''}`}
        aria-busy="true"
      >
        <AccountHeading t={t} />
        {/* One block per card that is always there — profile, spaces, local app,
            session — so the loaded page replaces them without a jump. */}
        <Skeleton className="account-skeleton" shape="block" count={4} label={t('loading')} />
      </main>
    );
  }

  return (
    <main className={`account-page page-container${entering ? ' page-enter' : ''}`}>
      <AccountHeading t={t} />
      <div className={`account-loaded${sawSkeleton.current ? ' content-appear' : ''}`}>
        <AccountSections profile={profile} provider={user.app_metadata?.provider ?? null} />
      </div>
    </main>
  );
}

function AccountHeading({ t }: { t: Translator }) {
  return (
    <header className="page-heading">
      <div>
        <h2>{t('accountTitle')}</h2>
        <p>{t('accountSubtitle')}</p>
      </div>
    </header>
  );
}

function AccountSections({ profile, provider }: { profile: Profile; provider: string | null }) {
  // `null` until the list answers: "no invitations" is a claim, and it is not
  // made before anyone has looked.
  const [pending, setPending] = useState<number | null>(null);

  // One request, two readers: the list draws the rows, the page counts them.
  const invitationClient = useMemo<InvitationListClient>(() => {
    let listing: ReturnType<typeof teamApi.listMyInvitations> | null = null;
    return {
      listMyInvitations: () => (listing ??= teamApi.listMyInvitations()),
      acceptInvitation: (id, token) => teamApi.acceptInvitation(id, token),
      declineInvitation: (id, token) => teamApi.declineInvitation(id, token)
    };
  }, []);

  useEffect(() => {
    let active = true;
    void invitationClient
      .listMyInvitations()
      .then(list => {
        if (active) setPending(list.filter(item => item.state === 'pending').length);
      })
      .catch(() => {
        // An unavailable team RPC must not take the page with it; the line in
        // Spaces simply stays unsaid.
      });
    return () => {
      active = false;
    };
  }, [invitationClient]);

  const linked = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search);
  const linkedInvitationId = linked?.get('invitation') ?? null;
  // An invitation link lands on this page, so the card is drawn for it even
  // before the list has answered.
  const showInvitations = (pending ?? 0) > 0 || Boolean(linkedInvitationId);

  return (
    <>
      {showInvitations && (
        <Card
          as="section"
          role="section"
          className="team-panel settings-section account-invitations"
          aria-labelledby="invitation-inbox-heading"
        >
          <ToastProvider>
            <InvitationList
              client={invitationClient}
              headingId="invitation-inbox-heading"
              linkedInvitationId={linkedInvitationId}
              linkedToken={linked?.get('invite') ?? undefined}
              onAnswered={() => setPending(count => (count === null ? count : count - 1))}
            />
          </ToastProvider>
        </Card>
      )}
      <ProfileSection profile={profile} provider={provider} />
      <SpacesSection invitationsEmpty={pending === 0 && !linkedInvitationId} />
      <LocalAppSection />
      <SessionSection />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------------------------

type SaveState = 'idle' | 'saved' | 'failed';

function normalizedName(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

function ProfileSection({ profile, provider }: { profile: Profile; provider: string | null }) {
  const { updateProfile } = useAuth();
  const { language: shownLanguage, setLanguage, t } = useI18n();
  const nameId = useId();
  const storedName = profile.display_name ?? '';
  const [name, setName] = useState(storedName);
  const [language, setFormLanguage] = useState<Language>(profile.language ?? shownLanguage);
  const [marketing, setMarketing] = useState(profile.marketing_consent ?? false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const profileRef = useRef(profile);
  profileRef.current = profile;
  // The name last handed to a write. The profile in context catches up a moment
  // after the write returns; comparing against it alone sent the same name a
  // second time if the field was left again inside that moment.
  const committedName = useRef(normalizedName(storedName));
  useEffect(() => {
    committedName.current = normalizedName(storedName);
  }, [storedName]);

  const { send, saving } = useCoalescedWrite<EditableProfilePatch>({
    write: async patch => {
      await updateProfile(patch);
      // Counted once it is stored, not when the switch moved: a failed write
      // puts the switch back, and the event would have described nothing.
      if (typeof patch.marketing_consent === 'boolean')
        analytics.track('marketing_consent_changed', {
          marketing_consent: patch.marketing_consent
        });
      setSaveState('saved');
    },
    merge: (held, next) => ({ ...held, ...next }),
    onError: () => {
      // The controls go back to what is stored: a switch left on after a failed
      // write would be the page lying about the account.
      const stored = profileRef.current;
      committedName.current = normalizedName(stored.display_name ?? '');
      setName(stored.display_name ?? '');
      setMarketing(stored.marketing_consent ?? false);
      if (stored.language) {
        setFormLanguage(stored.language);
        setLanguage(stored.language);
      }
      setSaveState('failed');
    }
  });

  const commitName = () => {
    const next = normalizedName(name);
    // An emptied field is not a request to have no name; it goes back.
    if (!next) {
      setName(committedName.current);
      return;
    }
    if (next !== name) setName(next);
    if (next === committedName.current) return;
    committedName.current = next;
    send({ display_name: next });
  };

  const stateWord = saving
    ? t('saving')
    : saveState === 'saved'
      ? t('accountSaved')
      : saveState === 'failed'
        ? t('accountSaveFailed')
        : undefined;

  return (
    <SettingsSection
      icon={UserRound}
      titleId="account-profile-title"
      title={t('accountProfileTitle')}
      className="account-profile"
      aside={
        stateWord && (
          <span
            className={`account-save-state${saveState === 'failed' && !saving ? ' is-failed' : ''}`}
            role={saveState === 'failed' && !saving ? 'alert' : 'status'}
          >
            {stateWord}
          </span>
        )
      }
    >
      <div className="account-identity">
        <UserAvatar
          url={profile.avatar_url}
          name={profile.display_name}
          email={profile.email}
          alt={t('avatarAlt')}
          size="large"
        />
        <div className="account-identity-fields">
          <FormField label={t('displayName')} htmlFor={nameId}>
            <Input
              id={nameId}
              value={name}
              maxLength={120}
              autoComplete="name"
              onChange={event => setName(event.target.value)}
              onBlur={commitName}
              onKeyDown={event => {
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') setName(committedName.current);
              }}
            />
          </FormField>
          <FormField
            label={t('email')}
            help={t(provider === 'google' ? 'accountEmailFromGoogle' : 'accountEmailFromSignIn')}
          >
            <span className="account-static-value">{profile.email ?? t('notAvailable')}</span>
          </FormField>
        </div>
      </div>

      <div className="account-preference">
        <span className="account-preference-label">
          <Languages size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
          {t('language')}
        </span>
        {/* The same two letters, in the same order, as the switch in the header:
            one choice shown in two places must not read as two choices. */}
        <SegmentedControl<Language>
          label={t('language')}
          size="sm"
          value={language}
          onChange={next => {
            setFormLanguage(next);
            setLanguage(next);
            send({ language: next });
          }}
          options={[
            { value: 'en', label: 'EN', title: 'English' },
            { value: 'uk', label: 'UA', title: 'Українська' }
          ]}
        />
      </div>

      <Switch
        className="account-newsletter"
        size="sm"
        checked={marketing}
        label={t('marketingConsent')}
        onChange={next => {
          setMarketing(next);
          send({ marketing_consent: next });
        }}
      />
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------------------------

const ROLE_KEYS: Record<TeamContextSnapshot['role'], TranslationKey> = {
  owner: 'teamRoleOwner',
  admin: 'teamRoleAdmin',
  editor: 'teamRoleEditor',
  viewer: 'teamRoleViewer'
};

/**
 * The spaces a person belongs to, read from the context the shell already
 * loaded — this costs no request. Outside that context (a test, a future
 * embedding) the list is simply not drawn and the invitations line stands alone.
 */
function SpacesSection({ invitationsEmpty }: { invitationsEmpty: boolean }) {
  const { t } = useI18n();
  const team = useOptionalTeam();
  const teams = team?.teams ?? [];
  const loading = team?.loading ?? false;

  return (
    <SettingsSection
      icon={UsersRound}
      titleId="account-spaces-title"
      title={t('accountSpacesTitle')}
      className="account-spaces"
      aside={teams.length > 0 ? String(teams.length) : undefined}
    >
      {team && !loading && teams.length === 0 && (
        <div className="account-row">
          <p className="account-muted">{t('accountSpacesEmpty')}</p>
          <Link variant="standalone" href="/team" onClick={event => internalLink(event, '/team')}>
            {t('accountSpacesOpenLobby')}
          </Link>
        </div>
      )}
      {teams.length > 0 && (
        <ul className="account-space-list">
          {teams.map(space => {
            const route = buildTeamRoute({ spaceId: space.id });
            return (
              <li key={space.id}>
                <span className="account-space-name" title={space.name}>
                  {space.name}
                </span>
                <Chip size="xs" color={space.role === 'owner' ? 'secondary' : 'neutral'}>
                  {t(ROLE_KEYS[space.role])}
                </Chip>
                <Link
                  className="account-space-open"
                  href={route}
                  aria-label={`${t('accountSpaceOpen')}: ${space.name}`}
                  onClick={event => internalLink(event, route)}
                >
                  {t('accountSpaceOpen')}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {invitationsEmpty && <p className="account-muted">{t('accountNoInvitations')}</p>}
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------------------------
// The local app
// ---------------------------------------------------------------------------------------------

type LocalAppState =
  | 'offline'
  | 'checking'
  | 'latest'
  | 'update_available'
  | 'update_required'
  | 'development'
  | 'newer'
  | 'unknown';

const LOCAL_APP_CHIP: Record<LocalAppState, { color: UiColor; key: TranslationKey }> = {
  offline: { color: 'neutral', key: 'accountLocalAppStateOffline' },
  checking: { color: 'neutral', key: 'accountLocalAppStateChecking' },
  latest: { color: 'success', key: 'accountLocalAppStateLatest' },
  update_available: { color: 'warning', key: 'accountLocalAppStateUpdate' },
  update_required: { color: 'error', key: 'accountLocalAppStateRequired' },
  development: { color: 'info', key: 'accountLocalAppStateDevelopment' },
  newer: { color: 'info', key: 'accountLocalAppStateNewer' },
  unknown: { color: 'neutral', key: 'accountLocalAppStateUnknown' }
};

function LocalAppSection() {
  const {
    agentVersion,
    agentChannel,
    capabilities,
    connection,
    reconnect,
    releaseManifest,
    toolAvailable
  } = useAgent();
  const { t } = useI18n();
  const beta = configuredEnvironment() === 'beta';
  const manifest = releaseManifest.status === 'ready' ? releaseManifest.manifest : null;

  // The version and the check are two facts. They used to be one sentence —
  // "1.1.1 (could not check for updates)" — in which a failure of the second
  // read as a property of the first.
  const state: LocalAppState = !agentVersion
    ? connection === 'checking' || connection === 'connecting'
      ? 'checking'
      : 'offline'
    : releaseManifest.status === 'checking'
      ? 'checking'
      : installedReleaseStatus({
          manifest,
          installedVersion: agentVersion,
          installedChannel: agentChannel,
          compatible: toolAvailable('compressor')
        });
  const chip = LOCAL_APP_CHIP[state];
  const download = preferredDownload(manifest, capabilities).url;
  const updating = state === 'update_available' || state === 'update_required';
  const revision = String(import.meta.env.VITE_WEB_REVISION ?? 'unknown');

  return (
    <SettingsSection
      icon={MonitorSmartphone}
      titleId="account-local-app-title"
      title={t('accountLocalAppTitle')}
      description={t('accountLocalAppDescription')}
      className="account-local-app"
    >
      <div className="account-row">
        <dl className="account-version">
          <dt>{t('accountLocalAppVersion')}</dt>
          <dd>{agentVersion ?? t('accountLocalAppNotConnected')}</dd>
        </dl>
        <Chip size="sm" color={chip.color} className="account-version-state">
          {t(chip.key, { version: manifest?.version ?? '' })}
        </Chip>
        <span className="account-row-actions">
          {updating && (
            // An anchor wearing the button's classes, as the update notice does:
            // a download is a navigation, and the inventory's Button is not one.
            <a
              className="ui-button ui-button--solid ui-button--md ui-color-primary"
              href={download}
              onClick={() => {
                markAgentInstallStarted();
                analytics.track('update_started', {});
              }}
            >
              {t('accountLocalAppDownloadUpdate')}
            </a>
          )}
          {state === 'offline' && (
            <>
              <Button type="button" variant="secondary" onClick={reconnect}>
                {t('accountLocalAppConnect')}
              </Button>
              <Link href={download} onClick={markAgentInstallStarted}>
                {t('accountLocalAppDownload')}
              </Link>
            </>
          )}
        </span>
      </div>
      {state === 'unknown' && (
        <p className="account-muted">
          {t(beta ? 'accountLocalAppBetaHint' : 'accountLocalAppUnknownHint')}
        </p>
      )}
      {beta && (
        <p className="account-footnote" title={revision}>
          {t('accountEnvironmentBeta')} · {revision}
        </p>
      )}
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

function SessionSection() {
  const { signOut } = useAuth();
  const { t } = useI18n();
  const [leaving, setLeaving] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    // Set on mount as well as cleared on unmount: strict mode runs the pair
    // twice, and a ref cleared by the rehearsal would never come back.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  return (
    <SettingsSection
      icon={LogOut}
      titleId="account-session-title"
      title={t('accountSessionTitle')}
      description={t('accountSessionDescription')}
      className="account-session"
    >
      <div className="settings-section-actions">
        <Button
          type="button"
          variant="secondary"
          loading={leaving}
          onClick={() => {
            setLeaving(true);
            void signOut().finally(() => {
              // A sign-out that fails leaves the person here; the button must
              // come back, or the only way out of the page is a reload.
              if (mounted.current) setLeaving(false);
            });
          }}
        >
          {t('signOut')}
        </Button>
      </div>
    </SettingsSection>
  );
}
