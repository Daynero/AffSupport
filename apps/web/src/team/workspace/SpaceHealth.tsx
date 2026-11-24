import { useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { CircleCheck, CircleDashed, TriangleAlert } from 'lucide-react';
import type { StorageHealth } from '@video-compressor/shared';
import { useOptionalAgent } from '../../AgentContext';
import { agentLocalUrl } from '../../api/client';
import type { CatalogUpdaterState } from '../../api/team';
import { ReconnectAction } from '../../components/ReconnectAction';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { Button, Popover, Spinner, uiClasses } from '../../components/ui/index';
import { useI18n, type TranslationKey } from '../../i18n';
import { CatalogUpdaterChip, useUpdaterSummary } from '../catalog-updater/CatalogUpdaterChip';
import { useOptionalBackgroundRender } from '../explorer/BackgroundRenderProvider';
import { useOptionalLibraryProcessing } from '../library/LibraryProcessingProvider';
import { ago, chipCopy, StorageChip, type StorageChipClient } from '../storage/StorageChip';
import { useTeam } from '../TeamContext';
import { AgentLinkChip } from './AgentLinkChip';
import { BackgroundWorkChip } from './BackgroundWorkChip';
import { RealtimeChip } from './RealtimeChip';
import { storageStale, useSpaceHealth, type HealthSource, type HealthTone } from './useSpaceHealth';
import { WorkspaceChip } from './WorkspaceChip';

/** How many chips the header gives the space's health at most (070, R3). */
const MAX_CHIPS = 2;

const SOURCE_NAME: Record<HealthSource, TranslationKey> = {
  storage: 'spaceHealthStorage',
  agent: 'spaceHealthAgent',
  realtime: 'spaceHealthRealtime',
  updater: 'spaceHealthUpdater',
  work: 'spaceHealthWork'
};

const ROW_ORDER: readonly HealthSource[] = ['storage', 'agent', 'realtime', 'work', 'updater'];

type Shown = { source: HealthSource } | { group: HealthSource[] };

export interface SpaceHealthProps {
  teamId: string;
  client: StorageChipClient;
  storage: StorageHealth | null;
  staleSince: number | null;
  onRefreshStorage: () => Promise<void> | void;
  isOwner: boolean;
  canManage: boolean;
  settingsHref: string;
  /** The storage detail, held in the address (`storage=1`). */
  storageOpen: boolean;
  onStorageOpenChange: (open: boolean) => void;
  updater: CatalogUpdaterState | null;
  updaterOffsetMs: number;
  updaterHref: string;
  onUpdaterNavigate: (event: MouseEvent<HTMLAnchorElement>) => void;
  /** Opens the batch that is running. */
  onOpenProcess: () => void;
}

/**
 * The storage row's status. The row is already named "Storage", so where the
 * chip's sentence starts with that word the row says only the rest of it: the
 * panel read «Сховище — Сховище актуальне · щойно» (070, phase 5). The states
 * whose sentence does not repeat the name are the chip's own words.
 */
function storageRowCopy(
  health: StorageHealth,
  t: ReturnType<typeof useI18n>['t'],
  renderPaused?: boolean
): string {
  if (health.kind === 'connected' && health.syncHealth === 'delayed')
    return t('spaceHealthStorageDelayed');
  if (health.kind === 'connected' && health.coverage === 'partial')
    return t('spaceHealthStoragePartial');
  if (health.kind === 'connected' && health.coverage !== 'permission_limited')
    return t('spaceHealthStorageCurrent', { ago: ago(health.lastReconciledAt, t) });
  if (health.kind === 'disconnected') return t('spaceHealthStorageDisconnected');
  return chipCopy(health, t, renderPaused);
}

/**
 * The header's one word about the space (070, US5, FR-020, FR-021).
 *
 * When everything works it is a single quiet indicator — «Усе працює» — that opens a panel with
 * the five rows. When something needs a person, that source's own chip appears, with its word and
 * its action, at most two of them; the rest are «ще N», which opens the same panel. Work under way
 * is one chip: the job's own when there is one, «Фонова робота · N» when there are several.
 */
export function SpaceHealth(props: SpaceHealthProps) {
  const { t } = useI18n();
  const health = useSpaceHealth({
    storage: props.storage,
    staleSince: props.staleSince,
    updater: props.updater
  });
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);

  const entries: Shown[] = [
    ...health.attention.map(source => ({ source })),
    ...(health.busy.length === 1
      ? [{ source: health.busy[0]! }]
      : health.busy.length > 1
        ? [{ group: health.busy }]
        : [])
  ];
  const shown = entries.slice(0, MAX_CHIPS);
  const hidden = entries
    .slice(MAX_CHIPS)
    .reduce((count, entry) => count + ('group' in entry ? entry.group.length : 1), 0);
  const chipFor = (source: HealthSource) => shown.some(e => 'source' in e && e.source === source);
  const group = shown.find((entry): entry is { group: HealthSource[] } => 'group' in entry);

  const chips: Record<Exclude<HealthSource, 'storage'>, ReactNode> = {
    agent: <AgentLinkChip />,
    realtime: <RealtimeChip graceElapsed={health.realtimeGraceElapsed} />,
    updater: (
      <CatalogUpdaterChip
        state={props.updater}
        offsetMs={props.updaterOffsetMs}
        href={props.updaterHref}
        onNavigate={props.onUpdaterNavigate}
      />
    ),
    work: <BackgroundWorkChip onOpen={props.onOpenProcess} />
  };

  return (
    <div
      className="team-space-health"
      data-state={shown.length > 0 ? 'chips' : 'quiet'}
      role="group"
      aria-label={t('spaceHealthTitle')}
    >
      {/* Always mounted: its detail is an address, and the panel's row opens it too. */}
      <StorageChip
        teamId={props.teamId}
        health={props.storage}
        client={props.client}
        isOwner={props.isOwner}
        canManage={props.canManage}
        settingsHref={props.settingsHref}
        onRefresh={props.onRefreshStorage}
        staleSince={props.staleSince}
        open={props.storageOpen}
        onOpenChange={props.onStorageOpenChange}
        showChip={chipFor('storage')}
      />
      {shown.map(entry =>
        'source' in entry && entry.source !== 'storage' ? (
          <span key={entry.source} className="team-space-health-chip">
            {chips[entry.source]}
          </span>
        ) : null
      )}
      <span ref={anchor} className="team-space-health-anchor">
        {group ? (
          <WorkspaceChip
            tone="busy"
            busy
            opensDialog
            label={t('spaceHealthBusyOpen', { count: group.group.length })}
            onPress={() => setOpen(true)}
          >
            {t('spaceHealthBusy', { count: group.group.length })}
          </WorkspaceChip>
        ) : hidden > 0 ? (
          <WorkspaceChip
            tone="warn"
            opensDialog
            label={t('spaceHealthMoreOpen', { count: hidden })}
            onPress={() => setOpen(true)}
          >
            {t('spaceHealthMore', { count: hidden })}
          </WorkspaceChip>
        ) : shown.length === 0 ? (
          <Button
            size="sm"
            variant="ghost"
            color="neutral"
            className="team-space-health-indicator"
            aria-label={t('spaceHealthOkOpen')}
            aria-haspopup="dialog"
            aria-expanded={open}
            leading={<CircleCheck size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
            onClick={() => setOpen(true)}
          >
            {t('spaceHealthOk')}
          </Button>
        ) : null}
      </span>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        placement="bottom-end"
        label={t('spaceHealthTitle')}
        className="team-space-health-popover"
      >
        <HealthPanel
          tones={health.tones}
          realtimeGraceElapsed={health.realtimeGraceElapsed}
          props={props}
          close={() => setOpen(false)}
        />
      </Popover>
    </div>
  );
}

function ToneIcon({ tone }: { tone: HealthTone }) {
  if (tone === 'busy') return <Spinner size="sm" />;
  const Icon = tone === 'attention' ? TriangleAlert : tone === 'ok' ? CircleCheck : CircleDashed;
  return <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />;
}

/** The five rows: what each source is doing, said in words, with the one action that fits. */
function HealthPanel({
  tones,
  realtimeGraceElapsed,
  props,
  close
}: {
  tones: Record<HealthSource, HealthTone>;
  realtimeGraceElapsed: boolean;
  props: SpaceHealthProps;
  close: () => void;
}) {
  const { t } = useI18n();
  const { realtimeState, retryRealtime } = useTeam();
  const agent = useOptionalAgent();
  const render = useOptionalBackgroundRender();
  const batch = useOptionalLibraryProcessing();
  const updater = useUpdaterSummary(props.updater, props.updaterOffsetMs);
  const smallButton = uiClasses('button', { color: 'neutral', variant: 'outline', size: 'xs' });

  const rows: Record<HealthSource, { status: string; action?: ReactNode }> = {
    storage: {
      status: !props.storage
        ? t('spaceHealthStorageUnknown')
        : storageStale(props.staleSince)
          ? t('spaceHealthStorageStale', {
              count: Math.floor((Date.now() - props.staleSince!) / 60_000)
            })
          : storageRowCopy(props.storage, t, render?.paused),
      action: props.storage ? (
        <Button
          size="xs"
          variant="outline"
          color="neutral"
          onClick={() => {
            close();
            props.onStorageOpenChange(true);
          }}
        >
          {t('spaceHealthDetails')}
        </Button>
      ) : undefined
    },
    agent: {
      status: !agent
        ? t('lookingForAgent')
        : tones.agent === 'idle'
          ? t('lookingForAgent')
          : agent.teamWorkspaceAvailability === 'ready'
            ? // The row is "Soty on this computer"; "Soty connected" said the name twice.
              t('spaceHealthAgentConnected')
            : agent.teamWorkspaceAvailability === 'too_old'
              ? t('localAppUpdateTitle')
              : agent.teamWorkspaceAvailability === 'blocked'
                ? t('linkBrowserBlocked')
                : agent.teamWorkspaceAvailability === 'account'
                  ? t('entitlementBlocked')
                  : t('linkConnectSoty'),
      action:
        agent && tones.agent === 'attention' ? (
          agent.teamWorkspaceAvailability === 'blocked' ? (
            <a className={smallButton} href={agentLocalUrl()}>
              {t('linkOpenInSoty')}
            </a>
          ) : agent.teamWorkspaceAvailability === 'disconnected' ? (
            /* The same surface as the chip it stands in for (070, T031): a reconnect pressed
               here is counted where the header's reconnects always were. */
            <ReconnectAction surface="team_shell" size="xs" />
          ) : undefined
        ) : undefined
    },
    realtime: {
      status:
        realtimeState === 'connected'
          ? t('spaceHealthRealtimeOk')
          : realtimeState === 'disabled'
            ? t('teamRealtimeDisabled')
            : !realtimeGraceElapsed
              ? t('spaceHealthRealtimeWaiting')
              : t(
                  realtimeState === 'connecting'
                    ? 'teamRealtimeConnecting'
                    : 'teamRealtimeReconnecting'
                ),
      action:
        tones.realtime === 'attention' && realtimeState !== 'disabled' ? (
          <Button size="xs" variant="outline" color="neutral" onClick={retryRealtime}>
            {t('spaceHealthRetry')}
          </Button>
        ) : undefined
    },
    work: {
      status:
        batch?.phase === 'running'
          ? t('teamBatchChip', {
              done: batch.done,
              total: Math.max(
                batch.total,
                batch.done + batch.skipped + batch.failed + (batch.activeKind ? 1 : 0),
                1
              )
            })
          : tones.work === 'attention'
            ? t('teamWorkspaceSessionOnly')
            : t('spaceHealthWorkIdle'),
      action:
        batch?.phase === 'running' ? (
          <Button
            size="xs"
            variant="outline"
            color="neutral"
            onClick={() => {
              close();
              props.onOpenProcess();
            }}
          >
            {t('spaceHealthOpen')}
          </Button>
        ) : undefined
    },
    updater: {
      status: updater
        ? [updater.scheduled, updater.status].filter(Boolean).join(' · ')
        : t('spaceHealthUpdaterIdle'),
      action: (
        <a
          className={smallButton}
          href={props.updaterHref}
          onClick={event => {
            close();
            props.onUpdaterNavigate(event);
          }}
        >
          {t('spaceHealthOpen')}
        </a>
      )
    }
  };

  return (
    <div className="team-space-health-panel">
      <p className="team-space-health-heading">{t('spaceHealthTitle')}</p>
      <ul className="team-space-health-rows">
        {ROW_ORDER.map(source => (
          <li key={source} className="team-space-health-row" data-tone={tones[source]}>
            <span className="team-space-health-icon">
              <ToneIcon tone={tones[source]} />
            </span>
            <span className="team-space-health-copy">
              <strong>{t(SOURCE_NAME[source])}</strong>
              <span>{rows[source].status}</span>
            </span>
            {rows[source].action}
          </li>
        ))}
      </ul>
    </div>
  );
}
