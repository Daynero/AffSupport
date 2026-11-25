/**
 * Owner defaults and each member's optional personal re-stitch settings.
 *
 * Since 071 the section is a picture of the result rather than the stitcher's form: a strip of
 * the finished video — the first frame, the video, the final picture drawn to scale — whose
 * clips open their settings underneath, and whose final picture is lengthened by dragging its
 * edge. There is no operation to choose any more: re-stitching cuts old screens where it finds
 * them and adds screens where there are none (`planStitch`), so it is the one answer a space
 * needs; the manual stitcher keeps its three operations.
 *
 * Since 030 the pictures are sources of the connected Drive — files and folders picked from
 * the space — and the server draws one per slot for every job. A slot that is on and has none
 * of its own uses Soty's standard picture (20261224170000), so re-stitching works before anyone
 * has set anything; it is off only when both slots are. Spaces saved the old way still point at
 * ids of a library; they are told so and asked to pick from the space.
 */

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useSyncExternalStore } from 'react';
import { Replace } from 'lucide-react';
import type {
  RestitchSlot,
  RestitchSourceInput,
  RestitchSourcesListing,
  TeamRestitchDefaults,
  ThumbnailSession
} from '@video-compressor/shared';
import { restitchMinutesKey, useI18n } from '../../i18n';
import { useToasts } from '../../components/toast';
import { useTeam } from '../TeamContext';
import { teamErrorMessageFor } from '../errors';
import { useOptionalAgent } from '../../AgentContext';
import { analytics } from '../../analytics/service';
import type { RestitchDefaultsInput } from '../../api/team';
import { useRestitchPreparation } from '../restitch/useRestitchPreparation';
import { CatalogFreshnessContext, useCatalogRead } from '../catalog/CatalogFreshness';
import { SettingsSection } from './SettingsSection';
import {
  Alert,
  Button,
  Checkbox,
  PermissionState,
  RestitchTimeline,
  spanText,
  type FinalDuration,
  type RestitchTimelineEnd
} from '../../components/ui/index';
import { SaveStateWord, useSaveState } from './SaveStateWord';
import type { RestitchSourcePoolClient } from './RestitchSourcePool';
import { fetchCompressorState } from '../../stitcher/api';
import { transferLegacyRestitchImages } from '../restitch/migrate-legacy';
import { useThumbnailSession, type ThumbnailSessionClient } from '../explorer/useThumbnailSession';
import {
  BUILTIN_PICTURES,
  FORM_DEFAULTS,
  builtinSlot,
  durationOf,
  formOf,
  restitchOff,
  withDuration,
  type RestitchForm
} from './restitch/restitch-form';
import { RestitchSlotPanel } from './restitch/RestitchSlotPanel';
import { RestitchFitPicker } from './restitch/RestitchFitPicker';
import { RestitchPrepareCard } from './restitch/RestitchPrepareCard';
import { useRestitchReadiness } from './restitch/useRestitchReadiness';

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
  /** The explorer's thumbnails, for the pictures a slot draws from (071); absent in tests. */
  mintThumbnailSession?: (teamId: string) => Promise<ThumbnailSession>;
  thumbnailUrl?: (session: ThumbnailSession, materialId: string) => string;
}

const noop = () => () => {};
const zero = () => 0;
const NO_THUMBNAILS: ThumbnailSessionClient = {
  mintThumbnailSession: () => Promise.reject(new Error('NO_THUMBNAILS')),
  thumbnailUrl: () => ''
};

export function RestitchDefaultsSection({
  teamId,
  client,
  readRow
}: {
  teamId: string;
  client: RestitchDefaultsClient;
  /**
   * The space's own row, as saved (071, `restitch/restitch-row.ts`). The space settings pass it;
   * without it the screen reads the effective settings and rebuilds the switches from their
   * `builtin` marker, which is all a member's personal settings have anyway.
   */
  readRow?: (teamId: string) => Promise<TeamRestitchDefaults | null>;
}) {
  const { t, language } = useI18n();
  const { push } = useToasts();
  const { activeTeam, can } = useTeam();
  const agent = useOptionalAgent();
  const connected = agent?.connection === 'connected';
  const isOwner = activeTeam?.role === 'owner';
  const editable = isOwner ? can('manage_metadata') : can('view');

  const [defaults, setDefaults] = useState<TeamRestitchDefaults | null>(null);
  const [listing, setListing] = useState<RestitchSourcesListing | null>(null);
  const [form, setForm] = useState<RestitchForm>(FORM_DEFAULTS);
  const [saving, setSaving] = useState(false);
  const saveState = useSaveState();
  const [loaded, setLoaded] = useState(false);
  const [useOwner, setUseOwner] = useState(true);
  const [switching, setSwitching] = useState(false);
  const preparation = useRestitchPreparation(teamId);
  // Preparation touches the space's drive; without one there is nothing to prepare, and the
  // way forward is the connection panel one section down rather than a button that would fail.
  const driveConnected = activeTeam?.connectionState === 'connected';
  // How much of the space is ready now; read again whenever a run settles (071).
  const readiness = useRestitchReadiness(
    teamId,
    driveConnected && editable && can('process'),
    preparation.state.phase === 'running'
      ? 'running'
      : `${preparation.state.phase}:${preparation.state.done}`
  );
  const scope: 'owner' | 'self' = isOwner || useOwner ? 'owner' : 'self';
  const poolsEditable = editable && (isOwner || !useOwner) && !saving;

  /** What this person edits: the space's row when the space's answer is theirs, else their own. */
  const settingsFor = useCallback(
    (spaceAnswer: boolean) =>
      spaceAnswer && readRow ? readRow(teamId) : client.getRestitchDefaults(teamId),
    [client, readRow, teamId]
  );

  const load = useCallback(async () => {
    const preference =
      !isOwner && client.getMemberRestitchPreference
        ? await client.getMemberRestitchPreference(teamId)
        : null;
    const inherits = preference?.useOwner ?? true;
    const found = await settingsFor(isOwner || inherits);
    const pools = client.listRestitchSources
      ? await client.listRestitchSources(teamId, isOwner || inherits ? 'owner' : 'self')
      : null;
    return { found, inherits, pools };
  }, [client, teamId, isOwner, settingsFor]);

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
        if (found) setForm(formOf(found));
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

  const changePool = async (slot: RestitchSlot, items: RestitchSourceInput[]) => {
    const write = isOwner ? client.setRestitchSources : client.setMemberRestitchSources;
    if (!write) return;
    setSaving(true);
    saveState.setState('saving');
    try {
      setListing(await write(teamId, slot, items));
      // The first pool a space gets also makes its settings row; the panel learns that here.
      if (!defaults) setDefaults(await client.getRestitchDefaults(teamId));
      analytics.track('setting_changed', {
        setting_name: 'team_restitch_sources',
        setting_value: slot,
        file_count: items.length
      });
      saveState.setState('saved');
    } catch (error) {
      saveState.setState('failed');
      push({ tone: 'error', text: teamErrorMessageFor(error, t) });
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    setSaving(true);
    saveState.setState('saving');
    try {
      const chosen: RestitchDefaultsInput = {
        // Always: it cuts old screens where there are some and adds screens where there are
        // none (071, R1). A row saved with another operation is rewritten here, not behind
        // anybody's back.
        operation: 'restitch',
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
      // Said on the panel's title line, as every settings panel says it (070, T052): a
      // toast for a kept value was the one panel that announced success out of place.
      saveState.setState('saved');
    } catch (error) {
      saveState.setState('failed');
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
      const effective = await settingsFor(checked);
      setDefaults(effective);
      setForm(formOf(effective));
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

  /*
   * Thumbnails come from the explorer's one session per space, so the pictures a slot draws
   * from are seen, not only counted. Without a session the tiles keep their glyphs.
   */
  const thumbnails = useMemo<ThumbnailSessionClient | null>(
    () =>
      client.mintThumbnailSession && client.thumbnailUrl
        ? { mintThumbnailSession: client.mintThumbnailSession, thumbnailUrl: client.thumbnailUrl }
        : null,
    [client.mintThumbnailSession, client.thumbnailUrl]
  );
  const session = useThumbnailSession({
    teamId,
    client: thumbnails ?? NO_THUMBNAILS,
    enabled: Boolean(thumbnails && listing)
  });
  const thumbnailFor = useCallback(
    (materialId: string) =>
      session && thumbnails ? thumbnails.thumbnailUrl(session, materialId) : null,
    [session, thumbnails]
  );

  /** What a clip shows: the first of its own pictures that has a face, or Soty's. */
  const clipOf = (slot: RestitchSlot) => {
    const enabled = slot === 'start' ? form.startEnabled : form.endEnabled;
    const pool = listing?.pools[slot] ?? null;
    const builtin = builtinSlot(enabled, pool);
    const file = pool?.sources.find(
      source => source.kind === 'file' && source.materialId && source.availability === 'available'
    );
    const image = builtin
      ? BUILTIN_PICTURES[slot]
      : file?.materialId
        ? thumbnailFor(file.materialId)
        : null;
    return { enabled, image, count: pool?.eligibleCount ?? 0, builtin };
  };
  const startClip = clipOf('start');
  const endClip = clipOf('end');
  const duration = durationOf(form);

  const lengthOf = (value: FinalDuration) => t('teamRestitchMinutes', { span: spanText(value) });
  const startLength =
    form.startDurationMode === 'one-frame'
      ? t('teamRestitchOneFrame')
      : t('teamRestitchMs', { ms: form.customStartDurationMs });
  const summary = [
    form.startEnabled ? t('teamRestitchSumPicture', { length: startLength }) : null,
    t('teamRestitchSumVideo'),
    form.endEnabled ? t('teamRestitchSumPicture', { length: lengthOf(duration) }) : null
  ]
    .filter(Boolean)
    .join(' + ');

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

  // A member who inherits reads the owner's answer; nobody else can change it from here.
  const inherits = !isOwner && useOwner;
  const formEditable = editable && !inherits && !saving;
  const off = restitchOff(form);
  // A row saved with "stitch" or "remove the stitching" before 071; saving rewrites it.
  const oldOperation =
    defaults && defaults.operation !== 'restitch' && !inherits && editable
      ? defaults.operation
      : null;
  const changeDuration = (next: FinalDuration) => setForm(current => withDuration(current, next));
  const fitPicture =
    startClip.image ?? endClip.image ?? BUILTIN_PICTURES[startClip.enabled ? 'start' : 'end'];

  return (
    <SettingsSection
      icon={Replace}
      titleId="team-restitch-settings-title"
      title={t('teamRestitchSection')}
      description={t('teamRestitchLead')}
      className="team-restitch-defaults"
      aside={inherits ? undefined : <SaveStateWord state={saveState.state} />}
    >
      {!isOwner && (
        <Checkbox
          checked={useOwner}
          disabled={switching || !loaded}
          onChange={checked => void toggleOwner(checked)}
          label={t('teamRestitchUseOwner')}
        />
      )}
      {inherits && listing && <p className="team-inline-note">{t('teamRestitchOwnerPoolsNote')}</p>}

      {/* Read rather than hidden: a member who cannot change this can still see what the
          space does, which is what they need in order to ask for it to change. */}
      {!editable && (
        <PermissionState className="team-inline-note" message={t('teamRestitchReadOnly')} />
      )}

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

      {oldOperation && (
        <Alert className="team-inline-note" color="info" variant="soft" role="status">
          {t('teamRestitchOldOperation', {
            mode: t(oldOperation === 'stitch' ? 'stitcherOpStitch' : 'stitcherOpUnstitch')
          })}
        </Alert>
      )}

      {/* The one state in which nothing happens, said as a state with its consequence. */}
      {loaded && off && (
        <Alert className="team-inline-note" color="warning" variant="soft" role="status">
          {t('teamRestitchOffAlert')}
        </Alert>
      )}

      <div className="team-restitch-stage" ref={poolsRef}>
        <RestitchTimeline
          start={startClip}
          end={endClip}
          duration={duration}
          onDurationChange={changeDuration}
          onToggle={(end: RestitchTimelineEnd, enabled: boolean) =>
            setForm(current =>
              end === 'start'
                ? { ...current, startEnabled: enabled }
                : { ...current, endEnabled: enabled }
            )
          }
          disabled={!formEditable}
          labels={{
            start: t('teamRestitchPartStart'),
            startLength,
            video: t('teamRestitchPartVideo'),
            videoLength: t('teamRestitchVideoAsIs'),
            end: t('teamRestitchPartEnd'),
            endLength:
              duration.low === duration.high
                ? lengthOf(duration)
                : t('teamRestitchMinutesRandom', { span: spanText(duration) }),
            off: t('teamRestitchOff'),
            builtin: t('teamRestitchBuiltinShort'),
            random: count => t('teamRestitchRandomPick', { count }),
            axisBreak: t('teamRestitchAxisBreak'),
            videoNote: t('teamRestitchVideoExplain'),
            toggle: (end, enabled) =>
              t(
                end === 'start'
                  ? enabled
                    ? 'teamRestitchStartTurnOff'
                    : 'teamRestitchStartTurnOn'
                  : enabled
                    ? 'teamRestitchEndTurnOff'
                    : 'teamRestitchEndTurnOn'
              ),
            sliderLow: t('teamRestitchSliderLow'),
            sliderHigh: t('teamRestitchSliderHigh'),
            valueText: value =>
              value.low === value.high
                ? t(restitchMinutesKey(language, value.high), { span: value.high })
                : t('teamRestitchValueRandom', { span: spanText(value) }),
            unit: t('minutesUnit')
          }}
        />
        <p className="team-restitch-summary" aria-live="polite">
          {t('teamRestitchSummary', { parts: summary })}
        </p>
        {form.endEnabled && formEditable && (
          <p className="team-restitch-hint">{t('teamRestitchSliderHint')}</p>
        )}
      </div>

      {/* Both ends side by side, each under its own name and the same switch as on the strip:
          nothing to open, nothing to remember about which one is being edited. */}
      <div className="team-restitch-slots">
        {(['start', 'end'] as const).map(slot => (
          <RestitchSlotPanel
            key={slot}
            teamId={teamId}
            slot={slot}
            form={form}
            onForm={setForm}
            formEditable={formEditable}
            pool={listing?.pools[slot] ?? null}
            poolsEditable={poolsEditable}
            poolClient={poolClient}
            onPoolChange={(changed, items) => void changePool(changed, items)}
            thumbnailFor={thumbnails ? thumbnailFor : undefined}
          />
        ))}
      </div>

      <RestitchFitPicker
        value={form.fitMode}
        picture={fitPicture}
        disabled={!formEditable}
        onChange={fitMode => setForm(current => ({ ...current, fitMode }))}
      />

      {editable && !inherits && (
        <div className="settings-section-actions">
          <Button
            type="button"
            color="success"
            loading={saving}
            disabled={!loaded}
            onClick={() => void save()}
          >
            {t('teamRestitchSave')}
          </Button>
        </div>
      )}

      {editable && can('process') && (
        <RestitchPrepareCard
          state={preparation.state}
          readiness={readiness}
          connected={connected}
          driveConnected={driveConnected}
          off={off}
          onStart={() => void preparation.prepare()}
          onPause={() => void preparation.cancel()}
        />
      )}
    </SettingsSection>
  );
}
