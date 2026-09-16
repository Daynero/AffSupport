import { useState } from 'react';
import { Link2 } from 'lucide-react';
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
import type { TeamSettingsTab } from '../routes';
import { Tabs } from '../../components/ui/index';

export interface SharePreferenceSettingsClient {
  resetLibrarySharePreference: (teamId: string) => Promise<boolean>;
}

export type SpaceSettingsClient = MemberManagementClient &
  InvitationPanelClient &
  LeaveSpaceClient &
  TeamAuditClient &
  DrivePanelClient & {
    resetLibrarySharePreference: SharePreferenceSettingsClient['resetLibrarySharePreference'];
  } & RestitchDefaultsClient &
  TaskLabelsSectionClient &
  TeamPreferencesClient &
  ProductCatalogSettingsClient;

export function SharePreferenceSettings({
  teamId,
  client
}: {
  teamId: string;
  client: SharePreferenceSettingsClient;
}) {
  const { t } = useI18n();
  const [resetting, setResetting] = useState(false);
  const [state, setState] = useState<'done' | 'empty' | 'failed' | null>(null);

  const reset = async () => {
    setResetting(true);
    setState(null);
    try {
      setState((await client.resetLibrarySharePreference(teamId)) ? 'done' : 'empty');
    } catch {
      setState('failed');
    } finally {
      setResetting(false);
    }
  };

  return (
    <SettingsSection
      icon={Link2}
      titleId="creative-library-share-settings-title"
      title={t('creativeLibraryShareSettingsTitle')}
      description={t('creativeLibraryShareSettingsDescription')}
    >
      <div className="settings-section-actions">
        <Button type="button" variant="secondary" loading={resetting} onClick={() => void reset()}>
          {t('creativeLibraryShareReset')}
        </Button>
      </div>
      {state && (
        <p
          className={state === 'failed' ? 'team-inline-error' : 'settings-section-note'}
          role="status"
        >
          {t(
            state === 'done'
              ? 'creativeLibraryShareResetDone'
              : state === 'empty'
                ? 'creativeLibraryShareResetEmpty'
                : 'creativeLibraryShareResetFailed'
          )}
        </p>
      )}
    </SettingsSection>
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
            {/* How team mode behaves, first: it is what a person opens these
                settings to change. */}
            <TeamPreferencesSection teamId={teamId} client={client} />
            <SharePreferenceSettings teamId={teamId} client={client} />
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
