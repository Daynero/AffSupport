import { useEffect, useState } from 'react';
import { Link2 } from 'lucide-react';
import { ICON_STROKE } from '../../components/icons';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { useTeam } from '../TeamContext';
import type { MemberManagementClient } from '../members/MemberList';
import type { InvitationPanelClient } from '../members/InvitationPanel';
import type { LeaveSpaceClient } from '../members/LeaveSpacePanel';
import { TeamAuditPanel, type TeamAuditClient } from '../members/TeamAuditPanel';
import { DriveConnectionPanel, type DrivePanelClient } from '../drive/DriveConnectionPanel';
import { RestitchDefaultsSection, type RestitchDefaultsClient } from './RestitchDefaultsSection';
import { TaskLabelsSection, type TaskLabelsSectionClient } from '../labels/TaskLabelsSection';
import { TeamPreferencesSection, type TeamPreferencesClient } from './TeamPreferencesSection';
import {
  ProductCatalogSettingsSection,
  type ProductCatalogSettingsClient
} from '../product-catalog/ProductCatalogSettingsSection';
import { SettingsSection } from './SettingsSection';
import { SpaceNameSection, type SpaceNameClient } from './SpaceNameSection';
import type { TeamSettingsTab } from '../routes';
import { Tabs } from '../../components/ui/index';

export interface SharePreferenceSettingsClient {
  getLibrarySharePreference?: (
    teamId: string
  ) => Promise<{ allowLinkOnCopy: boolean; remembered: boolean }>;
  resetLibrarySharePreference: (teamId: string) => Promise<boolean>;
}

export type SpaceSettingsClient = MemberManagementClient &
  InvitationPanelClient &
  LeaveSpaceClient &
  TeamAuditClient &
  DrivePanelClient & {
    resetLibrarySharePreference: SharePreferenceSettingsClient['resetLibrarySharePreference'];
    getLibrarySharePreference?: SharePreferenceSettingsClient['getLibrarySharePreference'];
  } & RestitchDefaultsClient &
  TaskLabelsSectionClient &
  TeamPreferencesClient &
  ProductCatalogSettingsClient &
  SpaceNameClient;

/**
 * The remembered answer to "open this file to anyone with the link?" (024).
 *
 * It was a whole card with a paragraph and a reset button, shown whether or not anything had
 * been remembered. Now it is one line under the storage card, and only while a choice is kept:
 * what copying a link does today, and "Ask again".
 */
export function SharePreferenceSettings({
  teamId,
  client
}: {
  teamId: string;
  client: SharePreferenceSettingsClient;
}) {
  const { t } = useI18n();
  const [kept, setKept] = useState<{ allowLinkOnCopy: boolean } | null>(null);
  const [resetting, setResetting] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!client.getLibrarySharePreference) return;
    let active = true;
    void client
      .getLibrarySharePreference(teamId)
      .then(value => {
        if (active) setKept(value.remembered ? { allowLinkOnCopy: value.allowLinkOnCopy } : null);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, teamId]);

  if (!kept) return null;

  const reset = async () => {
    setResetting(true);
    setFailed(false);
    try {
      await client.resetLibrarySharePreference(teamId);
      setKept(null);
    } catch {
      setFailed(true);
    } finally {
      setResetting(false);
    }
  };

  return (
    <div
      className="team-share-preference"
      role="group"
      aria-label={t('creativeLibraryShareSettingsTitle')}
    >
      <Link2 size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
      <p>
        {t(kept.allowLinkOnCopy ? 'creativeLibraryShareKeptAllow' : 'creativeLibraryShareKeptDeny')}
      </p>
      <Button type="button" variant="ghost" loading={resetting} onClick={() => void reset()}>
        {t('creativeLibraryShareAskAgain')}
      </Button>
      {failed && (
        <span className="team-inline-error" role="alert">
          {t('creativeLibraryShareResetFailed')}
        </span>
      )}
    </div>
  );
}

/**
 * Secondary management surface. Re-parents the existing 001 panels — the Drive
 * connection (owner) and audit (owner/admin) among them — each shown per its
 * existing permission gate. Kept off the default workspace so the primary view
 * stays content-first.
 *
 * Members are not here (024, FR-047). They were a tab of this dialog *and* a
 * section of the workspace — the same two panels, reached two ways, and free to
 * drift apart. The section survives, because people are something you go to;
 * an old `?settings=1&tab=members` link is turned into that section by the
 * route parser.
 */
export function SpaceSettings({
  teamId,
  client,
  initialTab,
  onBack
}: {
  teamId: string;
  client: SpaceSettingsClient;
  /** Which room to open in, when something sent the reader to a particular one. */
  initialTab?: TeamSettingsTab | null;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const { activeTeam, notifyStateChanged, refreshTeams, replaceTeams, teams } = useTeam();
  const [revision, setRevision] = useState(0);
  const canSeeHistory = activeTeam?.role === 'owner' || activeTeam?.role === 'admin';
  const tabs = [
    { id: 'general' as const, label: t('teamSettingsTabGeneral') },
    { id: 'tags' as const, label: t('teamSettingsTabTags') },
    { id: 'restitch' as const, label: t('teamSettingsTabRestitch') },
    { id: 'product-catalog' as const, label: t('teamSettingsTabProductCatalog') },
    ...(canSeeHistory ? [{ id: 'history' as const, label: t('teamSettingsTabHistory') }] : [])
  ];
  const [tab, setTab] = useState<(typeof tabs)[number]['id']>(() =>
    initialTab && tabs.some(item => item.id === initialTab) ? initialTab : 'general'
  );
  const changed = () => {
    setRevision(value => value + 1);
    notifyStateChanged();
  };

  return (
    <section className="team-space-settings" aria-labelledby="team-space-settings-title">
      {/* Title and tab strip travel together: the strip used to scroll away on
          the first turn of the wheel, leaving a long panel with nothing saying
          which of the five rooms it belonged to. */}
      <div className="team-space-settings-bar">
        <header className="team-space-settings-header">
          <h2 id="team-space-settings-title">{t('teamSpaceSettings')}</h2>
          <Button type="button" variant="secondary" onClick={onBack}>
            {t('teamSpaceSettingsBack')}
          </Button>
        </header>

        {/*
         * Four rooms rather than one wall.
         *
         * Every panel used to sit in a single two-column grid: link sharing
         * beside the whole re-stitch editor, members under it, the space's
         * history at the bottom of a page nobody scrolled to. The dialog was
         * taller than any screen and the re-stitch controls — the densest thing
         * in the product — were squeezed into half its width, where their labels
         * broke mid-word. Each subject gets the dialog's full width now.
         */}
        <Tabs
          className="team-space-tabs team-settings-tabs"
          label={t('teamSettingsTabsLabel')}
          value={tab}
          onChange={setTab}
          panelId={id => `team-settings-panel-${id}`}
          items={tabs.map(item => ({ id: item.id, label: item.label }))}
        />
      </div>

      <div
        /* Two columns only where two panels genuinely balance. General is three
           short cards and history and re-stitch are one panel each; side by side
           they left half the dialog's width empty. */
        className="team-space-settings-grid is-single"
        role="tabpanel"
        id={`team-settings-panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
      >
        {tab === 'general' && (
          <>
            {activeTeam?.role === 'owner' && <SpaceNameSection teamId={teamId} client={client} />}
            {/* How team mode behaves, first: it is what a person opens these
                settings to change. */}
            <TeamPreferencesSection teamId={teamId} client={client} />
            {activeTeam?.role === 'owner' && (
              <DriveConnectionPanel
                key={`drive:${teamId}`}
                teamId={teamId}
                client={client}
                revision={revision}
                onConnected={() => {
                  changed();
                  replaceTeams(
                    teams.map(team =>
                      team.id === teamId ? { ...team, connectionState: 'connected' as const } : team
                    )
                  );
                  void refreshTeams();
                }}
              />
            )}
            <SharePreferenceSettings teamId={teamId} client={client} />
          </>
        )}

        {/* Two sets, one room: the tags a task carries and the tags an agent
            carries are made the same way and read in different places. */}
        {tab === 'tags' && (
          <>
            <TaskLabelsSection teamId={teamId} client={client} revision={revision} />
            <TaskLabelsSection teamId={teamId} client={client} revision={revision} scope="agent" />
          </>
        )}

        {tab === 'restitch' && <RestitchDefaultsSection teamId={teamId} client={client} />}

        {tab === 'product-catalog' && (
          <ProductCatalogSettingsSection teamId={teamId} client={client} />
        )}

        {tab === 'history' && (
          <TeamAuditPanel teamId={teamId} client={client} revision={revision} />
        )}
      </div>
    </section>
  );
}
