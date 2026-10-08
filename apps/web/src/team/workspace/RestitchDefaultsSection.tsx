/**
 * Owner defaults and each member's optional personal re-stitch settings.
 *
 * Deliberately not a new screen full of new controls: it mounts the tool's own — the operation
 * row, the two slots with their switches, the fit mode and the hold ranges — so a member who
 * has used the stitcher already knows this. What is added here is the three things that only
 * make sense for a space: whether it is set up at all, where its pictures come from, and the
 * button that prepares its material.
 *
 * Since 030 the pictures are sources of the connected Drive — files and folders picked from
 * the space — and the server draws one per slot for every job. The panel therefore has its own
 * form state, read from the saved settings and not from any computer's library, and saving
 * needs no running app: nothing is published anywhere. Spaces saved the old way still point at
 * ids of a library; they are told so and asked to pick from the space.
 */

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useSyncExternalStore } from 'react';
import { Eraser, Plus, Replace } from 'lucide-react';
import type {
  ImageEmbeddingSettings,
  ImageEmbeddingSettingsPatch,
  RestitchSlot,
  RestitchSourceInput,
  RestitchSourcesListing,
  StitchOperation,
  TeamRestitchDefaults
} from '@video-compressor/shared';
import { ImageEmbeddingSection } from '../../components/ImageEmbeddingSection';
import { Button } from '../../components/ui';
import { ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { useToasts } from '../../components/toast';
import { useTeam } from '../TeamContext';
import { teamErrorMessageFor } from '../errors';
import { useOptionalAgent } from '../../AgentContext';
import { analytics } from '../../analytics/service';
import type { RestitchDefaultsInput } from '../../api/team';
import {
  useRestitchPreparation,
  type RestitchPreparationState
} from '../restitch/useRestitchPreparation';
import { CatalogFreshnessContext, useCatalogRead } from '../catalog/CatalogFreshness';
import { SettingsSection } from './SettingsSection';
import { Alert, PermissionState, SegmentedControl } from '../../components/ui/index';
import { Checkbox } from '../../components/ui';
import { RestitchSourcePool, type RestitchSourcePoolClient } from './RestitchSourcePool';
import { fetchCompressorState } from '../../stitcher/api';
import { transferLegacyRestitchImages } from '../restitch/migrate-legacy';

export interface RestitchDefaultsClient {
  getRestitchDefaults: (teamId: string) => Promise<TeamRestitchDefaults | null>;
  setRestitchDefaults: (
    teamId: string,
    defaults: RestitchDefaultsInput
  ) => Promise<TeamRestitchDefaults>;
  getMemberRestitchPreference?: (teamId: string) => Promise<{
    ownerId: string;
    sourceUserId: string;
    useOwner: boolean;
    personalConfigured: boolean;
  }>;
  setMemberRestitchUseOwner?: (teamId: string, useOwner: boolean) => Promise<void>;
  setMemberRestitchDefaults?: RestitchDefaultsClient['setRestitchDefaults'];
  /** The pools (030). Absent only in tests of the older surface; the panel then shows no pools. */
  listRestitchSources?: (
    teamId: string,
    scope: 'owner' | 'self'
  ) => Promise<RestitchSourcesListing>;
  setRestitchSources?: (
    teamId: string,
    slot: RestitchSlot,
    items: readonly RestitchSourceInput[]
  ) => Promise<RestitchSourcesListing>;
  setMemberRestitchSources?: RestitchDefaultsClient['setRestitchSources'];
  /** Browsing the catalog for the pickers; without it sources can be seen but not added. */
  listMaterials?: RestitchSourcePoolClient['listMaterials'];
  searchCatalog?: RestitchSourcePoolClient['searchCatalog'];
  /** Moving a legacy space's bucket pictures into the space (030, US5); injected by tests. */
  transferLegacyImages?: typeof transferLegacyRestitchImages;
  /** The connected app's library, for naming a legacy space's old pictures; injected by tests. */
  localLibrary?: typeof fetchCompressorState;
}

const OPERATION_KEYS = {
  restitch: 'stitcherOpRestitch',
  stitch: 'stitcherOpStitch',
  unstitch: 'stitcherOpUnstitch'
} as const;

/** The stitcher's own controls, with the space's answer filled in. */
interface RestitchForm {
  fitMode: ImageEmbeddingSettings['fitMode'];
  finalDurationMode: ImageEmbeddingSettings['finalDurationMode'];
  customFinalDurationSeconds: number;
  startEnabled: boolean;
  endEnabled: boolean;
  startDurationMode: ImageEmbeddingSettings['startDurationMode'];
  customStartDurationMs: number;
}

const FORM_DEFAULTS: RestitchForm = {
  fitMode: 'cover',
  finalDurationMode: 'random-40-50',
  customFinalDurationSeconds: 2700,
  startEnabled: true,
  endEnabled: true,
  startDurationMode: 'one-frame',
  customStartDurationMs: 100
};

function formOf(defaults: TeamRestitchDefaults | null): RestitchForm {
  if (!defaults) return FORM_DEFAULTS;
  return {
    fitMode: defaults.fitMode,
    finalDurationMode: defaults.finalDurationMode,
    customFinalDurationSeconds: defaults.customFinalDurationSeconds,
    startEnabled: defaults.startEnabled !== false,
    endEnabled: defaults.endEnabled !== false,
    startDurationMode: defaults.startDurationMode ?? 'one-frame',
    customStartDurationMs: defaults.customStartDurationMs ?? 100
  };
}

/**
 * The stitcher's settings object for the shared section, with no pictures in it: the slots
 * draw from the pools rendered in their place, so the galleries are never shown.
 */
function embeddingOf(form: RestitchForm): ImageEmbeddingSettings {
  return {
    enabled: true,
    replaceExisting: true,
    startImages: [],
    endImages: [],
    disabledImageIds: [],
    ...form
  };
}

const noop = () => () => {};
const zero = () => 0;
const noFiles = async () => {};

export function RestitchDefaultsSection({
  teamId,
  client
}: {
  teamId: string;
  client: RestitchDefaultsClient;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const { activeTeam, can } = useTeam();
  const agent = useOptionalAgent();
  const connected = agent?.connection === 'connected';
  const isOwner = activeTeam?.role === 'owner';
  const editable = isOwner ? can('manage_metadata') : can('view');

  const [defaults, setDefaults] = useState<TeamRestitchDefaults | null>(null);
  const [listing, setListing] = useState<RestitchSourcesListing | null>(null);
  const [operation, setOperation] = useState<StitchOperation>('restitch');
  const [form, setForm] = useState<RestitchForm>(FORM_DEFAULTS);
  const [formValid, setFormValid] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [useOwner, setUseOwner] = useState(true);
  const [switching, setSwitching] = useState(false);
  const preparation = useRestitchPreparation(teamId);
  // Preparation touches the space's drive; without one there is nothing to prepare, and the
  // way forward is the connection panel one section down rather than a button that would fail.
  const driveConnected = activeTeam?.connectionState === 'connected';
  const scope: 'owner' | 'self' = isOwner || useOwner ? 'owner' : 'self';
  const poolsEditable = editable && (isOwner || !useOwner) && !saving;

  const load = useCallback(async () => {
    const [found, preference] = await Promise.all([
      client.getRestitchDefaults(teamId),
      !isOwner && client.getMemberRestitchPreference
        ? client.getMemberRestitchPreference(teamId)
        : Promise.resolve(null)
    ]);
    const inherits = preference?.useOwner ?? true;
    const pools = client.listRestitchSources
      ? await client.listRestitchSources(teamId, isOwner || inherits ? 'owner' : 'self')
      : null;
    return { found, inherits, pools };
  }, [client, teamId, isOwner]);

  /*
   * The pools change under the panel whenever the catalog does — a folder renamed, a picture
   * binned — and the explorer already learns that through the one realtime seam. This panel
   * registers as one more reader of it and re-reads the pools when the catalog says it moved;
   * no timer, no second channel.
   */
  const freshness = useContext(CatalogFreshnessContext);
  const read = useCatalogRead(teamId, Boolean(client.listRestitchSources));
  const revision = useSyncExternalStore(freshness?.subscribe ?? noop, freshness?.snapshot ?? zero);
  useEffect(() => {
    let active = true;
    const reading = read();
    void load()
      .then(({ found, inherits, pools }) => {
        if (!active) return;
        setDefaults(found);
        setUseOwner(inherits);
        setListing(pools);
        if (found) {
          setOperation(found.operation);
          setForm(formOf(found));
        }
        reading.succeed();
      })
      .catch(() => reading.fail())
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [load, read]);

  const refreshing = useRef(false);
  useEffect(() => {
    if (!freshness || !loaded || !client.listRestitchSources || freshness.isFresh(teamId)) return;
    if (refreshing.current) return;
    refreshing.current = true;
    const reading = read();
    client
      .listRestitchSources(teamId, scope)
      .then(pools => {
        setListing(pools);
        reading.succeed();
      })
      .catch(() => reading.fail())
      .finally(() => {
        refreshing.current = false;
      });
  }, [revision, freshness, loaded, client, teamId, scope, read]);

  const updateForm = useCallback((patch: ImageEmbeddingSettingsPatch) => {
    setForm(current => {
      const next = { ...current };
      if (patch.fitMode) next.fitMode = patch.fitMode;
      if (patch.finalDurationMode) next.finalDurationMode = patch.finalDurationMode;
      if (patch.customFinalDurationSeconds !== undefined)
        next.customFinalDurationSeconds = patch.customFinalDurationSeconds;
      if (patch.startEnabled !== undefined) next.startEnabled = patch.startEnabled;
      if (patch.endEnabled !== undefined) next.endEnabled = patch.endEnabled;
      if (patch.startDurationMode) next.startDurationMode = patch.startDurationMode;
      if (patch.customStartDurationMs !== undefined)
        next.customStartDurationMs = patch.customStartDurationMs;
      return next;
    });
  }, []);

  const changePool = async (slot: RestitchSlot, items: RestitchSourceInput[]) => {
    const write = isOwner ? client.setRestitchSources : client.setMemberRestitchSources;
    if (!write) return;
    setSaving(true);
    try {
      setListing(await write(teamId, slot, items));
      // The first pool a space gets also makes its settings row; the panel learns that here.
      if (!defaults) setDefaults(await client.getRestitchDefaults(teamId));
      analytics.track('setting_changed', {
        setting_name: 'team_restitch_sources',
        setting_value: slot,
        file_count: items.length
      });
    } catch (error) {
      push({ tone: 'error', text: teamErrorMessageFor(error, t) });
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const chosen: RestitchDefaultsInput = {
        operation,
        ...form,
        // Where the pictures come from is the pools, never a list of ids (030).
        startImageIds: [],
        endImageIds: [],
        sourceMode: 'drive'
      };
      const stored = await (isOwner
        ? client.setRestitchDefaults(teamId, chosen)
        : client.setMemberRestitchDefaults!(teamId, chosen));
      setDefaults(stored);
      if (client.listRestitchSources) setListing(await client.listRestitchSources(teamId, scope));
      // Which operation a space settles on, and how many pictures it draws from — no ids, no
      // names, nothing about the space itself.
      analytics.track('setting_changed', {
        setting_name: 'team_restitch_defaults',
        setting_value: stored.operation,
        file_count: listing
          ? listing.pools.start.eligibleCount + listing.pools.end.eligibleCount
          : 0
      });
      push({ tone: 'success', text: t('teamRestitchSaved') });
    } catch (error) {
      push({ tone: 'error', text: teamErrorMessageFor(error, t) });
    } finally {
      setSaving(false);
    }
  };

  const toggleOwner = async (checked: boolean) => {
    if (!client.setMemberRestitchUseOwner) return;
    setSwitching(true);
    try {
      await client.setMemberRestitchUseOwner(teamId, checked);
      setUseOwner(checked);
      const effective = await client.getRestitchDefaults(teamId);
      setDefaults(effective);
      if (effective) {
        setOperation(effective.operation);
        setForm(formOf(effective));
      }
      if (client.listRestitchSources) {
        setListing(await client.listRestitchSources(teamId, checked ? 'owner' : 'self'));
      }
    } catch (error) {
      push({ tone: 'error', text: teamErrorMessageFor(error, t) });
    } finally {
      setSwitching(false);
    }
  };

  const poolClient = useMemo<RestitchSourcePoolClient | undefined>(
    () =>
      client.listMaterials
        ? { listMaterials: client.listMaterials, searchCatalog: client.searchCatalog }
        : undefined,
    [client.listMaterials, client.searchCatalog]
  );

  const slotContent = listing
    ? {
        start: (
          <RestitchSourcePool
            teamId={teamId}
            slot="start"
            pool={listing.pools.start}
            editable={poolsEditable}
            client={poolClient}
            onChange={(slot, items) => void changePool(slot, items)}
          />
        ),
        end: (
          <RestitchSourcePool
            teamId={teamId}
            slot="end"
            pool={listing.pools.end}
            editable={poolsEditable}
            client={poolClient}
            onChange={(slot, items) => void changePool(slot, items)}
          />
        )
      }
    : undefined;

  const legacy = listing?.sourceMode === 'legacy' && listing.legacyImageCount > 0;
  const poolsRef = useRef<HTMLDivElement>(null);

  /*
   * A legacy space names ids of one computer's library. When that computer is this one, the
   * names are worth more than the count; when it is not, the count is all there is to say.
   */
  const [legacyNames, setLegacyNames] = useState<string[]>([]);
  useEffect(() => {
    if (!legacy || !connected || !defaults) {
      setLegacyNames([]);
      return;
    }
    let active = true;
    void (client.localLibrary ?? fetchCompressorState)()
      .then(state => {
        if (!active) return;
        const ids = new Set([...defaults.startImageIds, ...defaults.endImageIds]);
        const library = state.settings.imageEmbedding;
        setLegacyNames(
          [...library.startImages, ...library.endImages]
            .filter(asset => ids.has(asset.id))
            .map(asset => asset.fileName)
        );
      })
      .catch(() => {
        if (active) setLegacyNames([]);
      });
    return () => {
      active = false;
    };
  }, [legacy, connected, defaults, client.localLibrary]);

  const [transferring, setTransferring] = useState<{ done: number; total: number } | null>(null);
  const transferLegacy = async () => {
    if (!defaults || !isOwner) return;
    setTransferring({
      done: 0,
      total: defaults.startImageIds.length + defaults.endImageIds.length
    });
    try {
      const report = await (client.transferLegacyImages ?? transferLegacyRestitchImages)(
        teamId,
        defaults,
        (done, total) => setTransferring({ done, total })
      );
      setDefaults(await client.getRestitchDefaults(teamId));
      if (client.listRestitchSources) setListing(await client.listRestitchSources(teamId, scope));
      push({
        tone: report.missing > 0 ? 'error' : 'success',
        text: t('teamRestitchLegacyTransferred', { moved: report.moved, missing: report.missing })
      });
    } catch (error) {
      push({ tone: 'error', text: teamErrorMessageFor(error, t) });
    } finally {
      setTransferring(null);
    }
  };

  if (!isOwner && useOwner) {
    return (
      <SettingsSection
        icon={Replace}
        titleId="team-restitch-settings-title"
        title={t('teamRestitchSection')}
        className="team-restitch-defaults"
      >
        <Checkbox
          checked
          disabled={switching || !loaded}
          onChange={event => void toggleOwner(event.target.checked)}
          label={t('teamRestitchUseOwner')}
        />
        {/* Read, not hidden: what the owner chose is what this member's downloads will carry,
            and seeing it is how they decide whether to choose their own. */}
        {listing && defaults && (
          <>
            <p className="team-inline-note">{t('teamRestitchOwnerPoolsNote')}</p>
            <ImageEmbeddingSection
              settings={embeddingOf(formOf(defaults))}
              disabled
              update={() => {}}
              uploadImages={noFiles}
              removeImage={noFiles}
              onValidityChange={() => {}}
              optional={false}
              slotContent={slotContent}
              t={t}
            />
          </>
        )}
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      icon={Replace}
      titleId="team-restitch-settings-title"
      title={t('teamRestitchSection')}
      description={client.listRestitchSources ? t('teamRestitchSourcesExplain') : undefined}
      className="team-restitch-defaults"
    >
      {!isOwner && (
        <Checkbox
          checked={false}
          disabled={switching}
          onChange={event => void toggleOwner(event.target.checked)}
          label={t('teamRestitchUseOwner')}
        />
      )}
      {/* The controls below say what the space does; what is left for a sentence is the one
          thing the controls cannot say: that nothing has been set yet. */}
      <p className="settings-section-note" role="status">
        {loaded && !defaults ? t('teamRestitchNotConfigured') : ''}
      </p>

      {/* Read rather than hidden: a member who cannot change this can still see what the
          space does, which is what they need in order to ask for it to change. */}
      {!editable && (
        <PermissionState className="team-inline-note" message={t('teamRestitchReadOnly')} />
      )}

      {/* A space saved before 030 points at pictures of one computer's library. It keeps
          working where those pictures are, and is told here what to do about it. */}
      {legacy && (
        <Alert className="team-inline-note" color="warning" variant="soft" role="status">
          {t('teamRestitchLegacyBanner', { count: listing.legacyImageCount })}
          {legacyNames.length > 0 &&
            ` ${t('teamRestitchLegacyNames', { names: legacyNames.join(', ') })}`}
          {editable && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => poolsRef.current?.scrollIntoView({ block: 'start' })}
            >
              {t('teamRestitchLegacyRepick')}
            </Button>
          )}
          {/* The owner alone may move them: the bucket is read as the member who published
              them, and the pool the folder joins is the space's. */}
          {isOwner && editable && (
            <Button
              type="button"
              variant="secondary"
              loading={transferring !== null}
              disabled={saving}
              onClick={() => void transferLegacy()}
            >
              {transferring
                ? t('teamRestitchLegacyTransferring', transferring)
                : t('teamRestitchLegacyTransfer')}
            </Button>
          )}
        </Alert>
      )}

      <div className="field-group">
        <div className="field-label">
          <span>{t('teamRestitchOperation')}</span>
        </div>
        {/* Words, each with its picture (024). Three bare pictograms needed a hint under them
            to name the chosen one, and that hint ("Stitch") read as the caption of the image
            fold below it. A settings page has the width for the names. */}
        <SegmentedControl
          className="team-restitch-operation"
          label={t('teamRestitchOperation')}
          value={operation}
          disabled={!editable}
          onChange={setOperation}
          options={(['restitch', 'stitch', 'unstitch'] as const).map(value => {
            const Icon = value === 'restitch' ? Replace : value === 'stitch' ? Plus : Eraser;
            return {
              value,
              label: (
                <>
                  <Icon size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  {t(OPERATION_KEYS[value])}
                </>
              )
            };
          })}
        />
      </div>

      {/* The stitcher's own controls — slot switches, fit, hold lengths — with the space's
          pools where the galleries would be. The form is the panel's; no library is read. */}
      <div ref={poolsRef}>
        <ImageEmbeddingSection
          settings={embeddingOf(form)}
          disabled={!editable || saving}
          update={updateForm}
          uploadImages={noFiles}
          removeImage={noFiles}
          onValidityChange={setFormValid}
          optional={false}
          slotContent={slotContent}
          t={t}
        />
      </div>

      {editable && (
        <div className="settings-section-actions">
          <Button
            type="button"
            variant="primary"
            loading={saving}
            disabled={!loaded || !formValid}
            onClick={() => void save()}
          >
            {t('teamRestitchSave')}
          </Button>
        </div>
      )}

      {editable && can('process') && (
        <div className="team-restitch-prepare">
          <p className="team-inline-note prose">{t('teamRestitchPrepareExplain')}</p>
          {/* A condition that stops preparation working, not a note about it: it is
              announced, and it carries the role's colour and its icon. */}
          {!connected && (
            <Alert className="team-inline-note" color="warning" variant="soft">
              {t('teamRestitchAgentMissing')}
            </Alert>
          )}
          {/* One reason at a time. Two "first do this" lines side by side make neither of them
              the next step. */}
          {!driveConnected ? (
            <p className="team-inline-note">{t('teamRestitchPrepareNoDrive')}</p>
          ) : (
            <>
              <div className="team-restitch-prepare-actions">
                <Button
                  type="button"
                  variant="secondary"
                  loading={busy(preparation.state.phase)}
                  disabled={!connected || !defaults?.configured}
                  onClick={() => void preparation.prepare()}
                >
                  {t('teamRestitchPrepare')}
                </Button>
                {busy(preparation.state.phase) && (
                  <Button type="button" variant="ghost" onClick={() => void preparation.cancel()}>
                    {t('teamRestitchPrepareStop')}
                  </Button>
                )}
              </div>
              {/* One line that says the same thing throughout: what is happening now, and
                  afterwards how many are ready and how many could not be (SC-006). */}
              <p role="status">{progressLine(preparation.state, t)}</p>
            </>
          )}
          {driveConnected && !defaults?.configured && (
            <p className="team-inline-note">{t('teamRestitchPrepareNeedsDefaults')}</p>
          )}
        </div>
      )}
    </SettingsSection>
  );
}

function busy(phase: RestitchPreparationState['phase']): boolean {
  return phase === 'folder' || phase === 'listing' || phase === 'running';
}

/** The run in one sentence, in whichever state it is. */
function progressLine(state: RestitchPreparationState, t: ReturnType<typeof useI18n>['t']): string {
  if (state.phase === 'idle') return '';
  if (state.phase === 'folder') return t('teamRestitchPrepareFolder');
  if (state.phase === 'listing') return t('teamRestitchPrepareListing');
  if (state.phase === 'failed') {
    return t('teamRestitchPrepareFailed', { reason: state.errorCode ?? '' });
  }
  if (state.phase === 'running') {
    return t('teamRestitchPreparing', { done: state.done, total: state.total });
  }
  /*
   * Finished or stopped: the tally is the same sentence either way, because a
   * stopped run keeps everything it had already found.
   *
   * "Could not" and "does not apply" are two different answers, and they were
   * added together: a single video the tool cannot read reported "0 готово, 1
   * не вдалося підготувати" — a failure with no reason, for something that was
   * never going to work and needs nothing from the person. They are counted
   * apart now, and a real failure always carries the reason the agent gave
   * rather than only when nothing at all came through.
   */
  const parts = [
    t(state.phase === 'canceled' ? 'teamRestitchPrepareStopped' : 'teamRestitchPrepared', {
      ready: state.ready,
      failed: state.failed
    })
  ];
  if (state.failed > 0 && state.errorCode) {
    parts.push(teamErrorMessageFor(new Error(state.errorCode), t));
  }
  if (state.unsupported > 0) {
    parts.push(t('teamRestitchPrepareUnsupported', { count: state.unsupported }));
  }
  return parts.join(' — ');
}
