import {
  isCatalogForegroundAdmissionRefused,
  isCatalogForegroundPreparationFailure
} from '../../api/catalog-video-foreground';
import { CatalogCreatedPublicationStatus } from './CatalogCreatedPublicationStatus';
import { useOptionalAgent } from '../../AgentContext';
import { useAgentEventStream } from '../../api/useAgentEventStream';
import { toolEventUrl } from '../../api/client';
import { isSoftReadFailure, withReadDeadline } from '../readCoordinator';
import { withCatalogCommandDeadline } from '../catalog-updater/catalogCommandCoordinator';
import { beginCatalogUiFlow } from '../catalog-updater/analytics';
import { recoveryInstallation } from '../../api/recovery-installation';
import {
  CatalogCreationVideoFields,
  type CatalogCreationVideoDraft
} from './CatalogCreationVideoFields';
import { resolveCatalogPublicationDraft } from './catalogPublicationDraft';
import { privateCacheActor, privateCacheEpoch } from '../private-cache-scope';
import type {
  CatalogCreatedVideoProgress,
  CatalogVideoPreparingResult
} from '../../api/catalog-video-creation';
import { prepareCatalogRestitch } from './catalog-orchestration';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Copy } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import {
  CatalogPublicationValidationError,
  restitchDefaultsSaveable,
  type TeamRestitchDefaults
} from '@video-compressor/shared';
import type {
  ProductCatalogCreateResult,
  ProductCatalogSettings,
  ProductCatalogSummary
} from '../../api/team';
import { Modal } from '../../components/Modal';
import { Button, Checkbox } from '../../components/ui';
import {
  Button as InventoryButton,
  IconButton,
  Skeleton,
  RestitchDurationControl,
  type RestitchDurationValue
} from '../../components/ui/index';
import { useToasts } from '../../components/toast';
import { useI18n, type TranslationKey } from '../../i18n';
import { useBrowserRoute } from '../../lib/navigation';
import { useSustained } from '../../lib/useSustained';
import { startTeamAgentProcess, agentCanRestitch } from '../../api/client';
import { teamApi } from '../../api/team';
import { teamErrorCodeOf, teamErrorMessageFor } from '../errors';
import { SpaceSettingsLink } from '../SpaceSettingsLink';
import { useTeam } from '../TeamContext';
import { CatalogVideoR2Toggle } from './CatalogVideoR2Toggle';
import { parseTeamRoute } from '../routes';
import { productCatalogNameFor } from '../materials/tail';
import {
  PRODUCT_COUNT_DEFAULT,
  SOURCE_LINK_MAX,
  validateProductCount,
  validateWebLink
} from './limits';
import { useOptionalAuth } from '../../auth/AuthContext';
import {
  catalogDurationPreferenceKey,
  readCatalogDurationPreference,
  saveCatalogDurationPreference
} from './duration-preference';
import { ProductCatalogProgress } from './ProductCatalogProgress';
import { CatalogRestitchProgress } from './CatalogRestitchProgress';
import { PRICE_RANGE_DEFAULT } from './ProductCatalogSettingsSection';
import { ensureRestitchImages } from '../restitch/images';
import { prepareRestitchScreens } from '../restitch/screens';

export interface CreateProductCatalogClient {
  readCatalogPublication?: typeof teamApi.readCatalogPublication;
  createProductCatalogVideo?: typeof teamApi.createProductCatalogVideo;
  readProductCatalogVideo?: typeof teamApi.readProductCatalogVideo;
  cancelProductCatalogVideo?: typeof teamApi.cancelProductCatalogVideo;
  resumeProductCatalogVideo?: typeof teamApi.resumeProductCatalogVideo;
  getProductCatalogSettings: (teamId: string) => Promise<ProductCatalogSettings | null>;
  setProductCatalogSettings?: typeof teamApi.setProductCatalogSettings;
  getRestitchDefaults?: (teamId: string) => Promise<TeamRestitchDefaults | null>;
  startProcess?: typeof teamApi.startProcess;
  runAgentProcess?: typeof startTeamAgentProcess;
  canRestitch?: typeof agentCanRestitch;
  ensureRestitchImages?: typeof ensureRestitchImages;
  /** 030: the pictures drawn from the space, in place of the published library. */
  prepareRestitchScreens?: typeof prepareRestitchScreens;
  ensureRestitchedFolder?: typeof teamApi.ensureRestitchedFolder;
  cancelOperation?: typeof teamApi.cancelOperation;
  getOperation?: typeof teamApi.getOperation;
  createProductCatalog: (input: {
    catalogImageContractVersion?: 2 | 3;
    teamId: string;
    videoMaterialId: string;
    sourceLink: string;
    productCount: number;
    randomLinkVariation?: boolean;
    replacesMaterialId: string | null;
    restitchOperationId?: string | null;
    idempotencyKey: string;
    copyVideoToR2?: boolean;
  }) => Promise<ProductCatalogCreateResult>;
  /** The number the next variation will take, so its name shows before it is made (024). */
  nextProductCatalogVariant?: (teamId: string, videoMaterialId: string) => Promise<number>;
}

interface ShownCatalog {
  name: string;
  sheetUrl: string;
  productCount: number;
}

type Phase =
  | { kind: 'form' }
  | { kind: 'busy'; step: 'restitch' | 'catalog' }
  | { kind: 'result'; heading: TranslationKey; catalog: ShownCatalog };

const VIDEO_READBACK_INITIAL_MS = 3_000;
const VIDEO_READBACK_MAX_MS = 30_000;
/** While videos are still being made the count is what the person watches: never
 * let the readback drift past this (1.4.3 next showed «1 з 2» for ~20 s). */
const VIDEO_READBACK_ACTIVE_MAX_MS = 4_000;
/** All videos ready: the server registers the catalog by itself within seconds.
 * Offer the manual nudge only once it has visibly not happened. */
export const CATALOG_VIDEO_RESUME_GRACE_MS = 40_000;
const CATALOG_VIDEO_READ_DEADLINE_MS = 10_000;
/** How long an unconfirmed creation is read calmly before it is called unconfirmed. */
export const CREATION_UNCERTAIN_PATIENCE_MS = 20_000;

const TRANSIENT_CATALOG_CODES = new Set([
  'TEAM_TRANSPORT_UNAVAILABLE',
  'PROCESS_RESULT_UNCERTAIN',
  'RATE_LIMITED',
  'DRIVE_UNAVAILABLE',
  'WORKSPACE_READ_TIMEOUT'
]);
/** After a create the server answered with "someone else holds it", read every few
 * seconds for this long instead of on the widening timer. */
const CREATION_FAST_READ_WINDOW_MS = 60_000;
/** Codes that leave an accepted creation in progress under its key: another executor
 * holds the lease, or the answer was lost on the way. */
const CREATION_IN_PROGRESS_CODES = new Set([
  'GROUP_RECONCILING',
  'LEASE_MISMATCH',
  'PROCESS_RESULT_UNCERTAIN'
]);
function isCreationStillOurs(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && CREATION_IN_PROGRESS_CODES.has(code);
}
/** A failure that says the server was slow or unreachable, not that the action is wrong. */
function isTransientCatalogFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return TRANSIENT_CATALOG_CODES.has(code);
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  return error instanceof TypeError;
}

/** Where this browser remembers an unfinished catalog creation for one video. */
export function pendingCatalogCreationStorageKey(
  actor: string,
  teamId: string,
  videoId: string
): string {
  return `soty:catalog-video-create:v1:${actor}:${teamId}:${videoId}`;
}

/**
 * What the person submitted for a pending creation. The server's read returns
 * only progress, so "Показати прогрес" reopened an empty form under the
 * video's name, as if the choice had been lost (1.4.3).
 */
interface PendingCreationForm {
  key: string;
  link: string;
  count: string;
  restitch: boolean;
  copyVideoToR2: boolean;
  videoDraft: CatalogCreationVideoDraft;
  duration?: RestitchDurationValue;
  name: string | null;
}
const pendingFormStorageKey = (storageKey: string) => `${storageKey}:form`;

function readPendingCreationForm(storageKey: string, key: string): PendingCreationForm | null {
  try {
    const value = JSON.parse(
      localStorage.getItem(pendingFormStorageKey(storageKey)) ?? 'null'
    ) as Partial<PendingCreationForm> | null;
    if (
      !value ||
      value.key !== key ||
      typeof value.link !== 'string' ||
      typeof value.count !== 'string' ||
      typeof value.restitch !== 'boolean' ||
      typeof value.videoDraft?.variationCount !== 'string' ||
      typeof value.videoDraft.delayed !== 'boolean'
    )
      return null;
    return {
      key,
      link: value.link,
      count: value.count,
      restitch: value.restitch,
      copyVideoToR2: value.copyVideoToR2 === true,
      videoDraft: value.videoDraft,
      ...(typeof value.duration?.finalDurationMode === 'string'
        ? { duration: value.duration }
        : {}),
      name: typeof value.name === 'string' ? value.name : null
    };
  } catch {
    return null;
  }
}

/**
 * Make a creation the server listed the one this dialog reopens (1.4.3). The video's catalogs
 * show the person's unfinished creations from any browser; «Показати прогрес» opens this dialog
 * on one through the same restore path a creation started here takes. A form this browser
 * already remembers for the same key is richer (the delayed time) and stays. Throws when
 * storage is unavailable; the caller reports it.
 */
export function rememberPendingCatalogCreation(
  storageKey: string,
  creation: Omit<PendingCreationForm, 'videoDraft'> & { variationCount: string }
): void {
  const known =
    localStorage.getItem(storageKey) === creation.key &&
    readPendingCreationForm(storageKey, creation.key) !== null;
  localStorage.setItem(storageKey, creation.key);
  if (known) return;
  const { variationCount, ...form } = creation;
  const stored: PendingCreationForm = {
    ...form,
    videoDraft: {
      variationCount,
      delayed: false,
      date: '',
      time: '12:00',
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Kyiv'
    }
  };
  localStorage.setItem(pendingFormStorageKey(storageKey), JSON.stringify(stored));
}

/** The pending key and the form remembered with it leave together. */
function forgetPendingCreation(storageKey: string) {
  localStorage.removeItem(storageKey);
  localStorage.removeItem(pendingFormStorageKey(storageKey));
}

function errorKey(error: unknown): TranslationKey | null {
  // A delayed publication checked on submit: a passed time is the person's to fix,
  // never the generic "some data is invalid" that names no field.
  if (error instanceof CatalogPublicationValidationError)
    return error.reason === 'time_in_past'
      ? 'catalogPublicationTimePassed'
      : 'catalogPublicationInvalid';
  const details = (error as { details?: Record<string, unknown> } | null)?.details;
  const code = (error as { code?: unknown } | null)?.code;
  if (details?.reason === 'settings_missing') return 'productCatalogErrorSettingsMissing';
  if (details?.reason === 'not_a_video') return 'productCatalogErrorNotVideo';
  if (details?.field === 'link') return 'productCatalogLinkInvalid';
  if (details?.field === 'count') return 'productCatalogCountInvalid';
  if (code === 'SHARE_NOT_ALLOWED') return 'productCatalogErrorShare';
  return null;
}

/**
 * "Create catalog" (022, US1 and US5): a link and a product count, then the sheet.
 *
 * Re-creating is the same form prefilled with what that variation was made from, saying once
 * that it will be replaced. The result leads with the sheet's name and a button that copies it:
 * the owner names the catalog on Meta the same way (024, US15), and retyping `IN 40_v2_catalog`
 * is where the two start to disagree. There is no warning about the links being viewable: the
 * pasted link and the sheet belong to the person making them.
 */
export function CreateProductCatalogDialog({
  teamId,
  video,
  replaces,
  variation = false,
  initialCount,
  client,
  onClose,
  onCreated
}: {
  teamId: string;
  video: { id: string; name: string; parentFolderId?: string | null };
  /** The variation being replaced; absent to create one. */
  replaces?: ProductCatalogSummary | null;
  /** The video already has catalogs, so this one is a new variation beside them. */
  variation?: boolean;
  /** The count to start from — the last variation's, so a second one is one link away. */
  initialCount?: number;
  client: CreateProductCatalogClient;
  onClose: () => void;
  onCreated?: (result: ProductCatalogCreateResult) => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const { can, revision: workspaceRevision, updaterRevision } = useTeam();
  const agent = useOptionalAgent();
  const nativeTerminals = useRef('');
  const preferenceKey = catalogDurationPreferenceKey(useOptionalAuth()?.user?.id ?? null, teamId);
  const durationPreference = useRef<{
    key: string | null;
    value: RestitchDurationValue | null;
  } | null>(null);
  const route = parseTeamRoute(useBrowserRoute());
  const settingsOpen = route?.kind === 'space' && route.query.settings;
  const titleId = useId();
  const linkId = useId();
  const countId = useId();

  const [link, setLink] = useState(replaces?.sourceLink ?? '');
  const [count, setCount] = useState(
    String(replaces?.productCount ?? initialCount ?? PRODUCT_COUNT_DEFAULT)
  );
  const [touched, setTouched] = useState({ link: false, count: false });
  const [settings, setSettings] = useState<ProductCatalogSettings | null | undefined>(undefined);
  const [restitch, setRestitch] = useState(false);
  // 050: copy the catalog video to R2; off unless ticked, applied from the next update on.
  const [copyVideoToR2, setCopyVideoToR2] = useState(false);
  const videoProtocol = Boolean(client.createProductCatalogVideo);
  const [videoDraft, setVideoDraft] = useState<CatalogCreationVideoDraft>({
    variationCount: '1',
    delayed: false,
    date: '',
    time: '12:00',
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Kyiv'
  });
  const [videoPending, setVideoPending] = useState<CatalogVideoPreparingResult | null>(null);
  const videoPendingRef = useRef<CatalogVideoPreparingResult | null>(null);
  videoPendingRef.current = videoPending;
  const [videoUnknown, setVideoUnknown] = useState(false);
  // The last progress read failed on the line, not on the work; the shown state stands.
  const [readInterrupted, setReadInterrupted] = useState(false);
  const [createdVideo, setCreatedVideo] = useState<CatalogCreatedVideoProgress | null>(null);
  const createdCatalog = useRef<ProductCatalogCreateResult | null>(null);
  const deliveredCatalog = useRef<string | null>(null);
  const videoCommandBusy = useRef(false);
  const videoReadDirty = useRef(false);
  /** Until this time, re-read every few seconds instead of on the widening timer. */
  const readSoon = useRef(0);
  const videoFlow = useRef<ReturnType<typeof beginCatalogUiFlow> | null>(null);
  const videoKey = useRef<string | null>(null);
  const videoOwner = useRef<{ actor: string | null; epoch: number } | null>(null);
  const videoStorageKey = privateCacheActor()
    ? pendingCatalogCreationStorageKey(privateCacheActor()!, teamId, video.id)
    : null;
  const videoCancelId = useRef<string | null>(null);

  // Once requested, a read belongs to this dialog, not to the checkbox's visibility.
  const [restitchRequested, setRestitchRequested] = useState(false);
  const [restitchLoadError, setRestitchLoadError] = useState(false);
  const [restitchReadRevision, setRestitchReadRevision] = useState(0);
  const getRestitchDefaults = client.getRestitchDefaults ?? teamApi.getRestitchDefaults;
  const [restitchDefaults, setRestitchDefaults] = useState<TeamRestitchDefaults | null | undefined>(
    undefined
  );
  const [duration, setDuration] = useState<RestitchDurationValue>({
    finalDurationMode: 'random-40-50',
    customFinalDurationSeconds: 45 * 60
  });
  const [processed, setProcessed] = useState<{
    operationId: string;
    choice: string;
    catalogKey: string;
  } | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [restitchOperationId, setRestitchOperationId] = useState<string | null>(null);
  const observationRun = useRef(0);
  useEffect(
    () => () => {
      observationRun.current += 1;
    },
    [teamId, video.id]
  );
  const [failure, setFailure] = useState<string | null>(null);
  /** The refusal was "no catalog settings yet": the way to fix it goes right under it. */
  const [failureNeedsSettings, setFailureNeedsSettings] = useState(false);
  /*
   * The name the sheet will have, up front (024): it is what the owner types on Meta, and the
   * form used to show it only after the catalog existed. Re-creating keeps its number.
   */
  const [plannedVariant, setPlannedVariant] = useState<number | null>(replaces?.variant ?? null);
  useEffect(() => {
    if (replaces || !client.nextProductCatalogVariant) return;
    let active = true;
    void client
      .nextProductCatalogVariant(teamId, video.id)
      .then(value => {
        if (active) setPlannedVariant(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, replaces, teamId, video.id]);
  const plannedName = plannedVariant ? productCatalogNameFor(video.name, plannedVariant) : null;

  useEffect(() => {
    let active = true;
    void client
      .getProductCatalogSettings(teamId)
      .then(found => {
        if (active) setSettings(found);
      })
      .catch(() => {
        // Unknown is not "missing": the server still refuses a space without settings.
        if (active) setSettings(undefined);
      });
    return () => {
      active = false;
    };
  }, [client, teamId, settingsOpen]);

  useEffect(() => {
    if (!durationPreference.current || durationPreference.current.key !== preferenceKey) {
      durationPreference.current = {
        key: preferenceKey,
        value: readCatalogDurationPreference(preferenceKey)
      };
    }
    if (!restitchRequested || settingsOpen) return;
    let active = true;
    setRestitchLoadError(false);
    setRestitchDefaults(undefined);
    void getRestitchDefaults(teamId)
      .then(found => {
        if (!active) return;
        setRestitchDefaults(found);
        if (found) {
          setDuration(
            durationPreference.current?.value ?? {
              finalDurationMode: found.finalDurationMode,
              customFinalDurationSeconds:
                Math.max(1, Math.round(found.customFinalDurationSeconds / 60)) * 60
            }
          );
        }
      })
      .catch(() => {
        if (active) setRestitchLoadError(true);
      });
    return () => {
      active = false;
    };
  }, [
    getRestitchDefaults,
    restitchRequested,
    teamId,
    preferenceKey,
    settingsOpen,
    restitchReadRevision
  ]);

  const linkCheck = validateWebLink(link, SOURCE_LINK_MAX);
  const countCheck = validateProductCount(count);
  const durationMode = duration.finalDurationMode;
  const customSeconds = duration.customFinalDurationSeconds ?? null;
  const durationValid =
    (durationMode !== 'custom' && durationMode !== 'random-centered') ||
    (customSeconds !== null &&
      Number.isInteger(customSeconds) &&
      customSeconds >= 60 &&
      customSeconds <= 3600);
  const canConfirm =
    linkCheck.ok &&
    countCheck.ok &&
    settings !== undefined &&
    (settings !== null || can('manage_metadata')) &&
    (!restitch ||
      (restitchDefaults !== undefined &&
        restitchDefaults !== null &&
        restitchDefaultsSaveable({ ...restitchDefaults, operation: 'restitch' }) &&
        durationValid)) &&
    phase.kind === 'form' &&
    !videoPending &&
    !videoUnknown &&
    (!videoProtocol ||
      !restitch ||
      (/^\d+$/u.test(videoDraft.variationCount) &&
        Number(videoDraft.variationCount) >= 1 &&
        Number(videoDraft.variationCount) <= (countCheck.ok ? countCheck.value : 0)));

  const productTotal = countCheck.ok ? countCheck.value : 0;
  const showCreated = (result: ProductCatalogCreateResult) => {
    createdCatalog.current = result;
    setCreatedVideo(result.videoGenerationObservation ?? result.videoGeneration ?? null);
    setVideoPending(null);
    setPhase({
      kind: 'result',
      heading:
        result.outcome === 'existing' ? 'productCatalogAlreadyExists' : 'productCatalogReady',
      catalog: result.catalog
    });
    const progress = result.videoGenerationObservation ?? result.videoGeneration;
    if (!progress || progress.state === 'ready' || progress.state === 'canceled') {
      if (videoStorageKey) forgetPendingCreation(videoStorageKey);
      videoKey.current = null;
    }
    if (deliveredCatalog.current !== result.catalog.materialId) {
      deliveredCatalog.current = result.catalog.materialId;
      onCreated?.(result);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched({ link: true, count: true });
    if (!linkCheck.ok || !countCheck.ok || !canConfirm || phase.kind !== 'form') return;
    const run = ++observationRun.current;
    const submitOwner = { actor: privateCacheActor(), epoch: privateCacheEpoch() };
    const submitOwns = () =>
      submitOwner.actor === privateCacheActor() &&
      submitOwner.epoch === privateCacheEpoch() &&
      observationRun.current === run;
    setRestitchOperationId(null);
    setPhase({ kind: 'busy', step: restitch ? 'restitch' : 'catalog' });
    setFailure(null);
    setFailureNeedsSettings(false);
    let submittedVideoKey: string | null = null;
    try {
      // The displayed price range is a usable default even before anyone has saved settings.
      if (settings === null) {
        const saved = await (client.setProductCatalogSettings ?? teamApi.setProductCatalogSettings)(
          teamId,
          {
            title: null,
            description: null,
            imageLink: null,
            priceMin: PRICE_RANGE_DEFAULT.min,
            priceMax: PRICE_RANGE_DEFAULT.max
          }
        );
        if (!submitOwns()) return;
        setSettings(saved);
      }
      if (!submitOwns()) return;
      if (videoProtocol && client.createProductCatalogVideo) {
        const owner = submitOwner;
        const owns = () =>
          owner.actor === privateCacheActor() &&
          owner.epoch === privateCacheEpoch() &&
          observationRun.current === run;
        let publication: Parameters<
          typeof teamApi.createProductCatalogVideo
        >[0]['videoPublication'] = { mode: 'immediate' };
        if (videoDraft.delayed) {
          const resolved = resolveCatalogPublicationDraft(
            {
              localDateTime: `${videoDraft.date}T${videoDraft.time}`,
              timeZone: videoDraft.zone,
              choice: videoDraft.occurrence
            },
            Date.now()
          );
          if (resolved.kind !== 'resolved') throw new Error('INVALID_INPUT');
          publication = resolved.publication;
        }
        const input: Parameters<typeof teamApi.createProductCatalogVideo>[0] = {
          teamId,
          videoMaterialId: video.id,
          sourceLink: linkCheck.value,
          productCount: countCheck.value,
          randomLinkVariation: true,
          replacesMaterialId: replaces?.id ?? null,
          idempotencyKey: `product-catalog:${crypto.randomUUID()}`,
          catalogVideoProtocolVersion: 1,
          restitchEnabled: restitch,
          ...(copyVideoToR2 ? { copyVideoToR2: true } : {}),
          ...(restitch ? { expectedExecutorId: recoveryInstallation() ?? undefined } : {}),
          videoVariationCount: restitch ? Number(videoDraft.variationCount) : 1,
          videoPublication: publication,
          ...(restitch
            ? {
                restitchDuration: {
                  finalDurationMode: durationMode,
                  customFinalDurationSeconds: customSeconds ?? 2700,
                  ...(duration.finalDurationRangeSeconds
                    ? { finalDurationRangeSeconds: duration.finalDurationRangeSeconds }
                    : {})
                }
              }
            : {})
        };
        if (!videoStorageKey) throw new Error('AUTH_REQUIRED');
        localStorage.setItem(videoStorageKey, input.idempotencyKey);
        try {
          const form: PendingCreationForm = {
            key: input.idempotencyKey,
            link,
            count,
            restitch,
            copyVideoToR2,
            videoDraft,
            ...(restitch ? { duration } : {}),
            name: plannedName
          };
          localStorage.setItem(pendingFormStorageKey(videoStorageKey), JSON.stringify(form));
        } catch {
          /* Only the reopened form's details are lost; the creation itself is tracked. */
        }
        videoKey.current = input.idempotencyKey;
        submittedVideoKey = input.idempotencyKey;
        videoOwner.current = owner;
        setVideoUnknown(true);
        videoFlow.current = beginCatalogUiFlow('video_create', {
          parentFlowId: input.idempotencyKey.split(':')[1],
          count: input.videoVariationCount
        });
        videoFlow.current.stage('command_requested');
        let result: Awaited<ReturnType<NonNullable<typeof client.createProductCatalogVideo>>>;
        try {
          result = await withCatalogCommandDeadline(
            signal => client.createProductCatalogVideo!(input, { signal }),
            new AbortController().signal
          );
        } catch (cause) {
          // The creation was accepted under this key and is being carried on
          // elsewhere (the background pass holds it) or its answer was lost: it is
          // a state to read, not an error. Seen as a 409 and a minute of a red
          // form before «Каталог готовий» (1.4.3 QA, S2).
          if (!owns() || !isCreationStillOurs(cause)) throw cause;
          setFailure(null);
          setPhase({ kind: 'form' });
          readSoon.current = Date.now() + CREATION_FAST_READ_WINDOW_MS;
          void checkVideoRef.current();
          return;
        }
        if (!owns()) return;
        setVideoUnknown(false);
        if (result.outcome === 'preparing_video') {
          videoFlow.current?.stage('command_accepted');
          setVideoPending(result);
          setPhase({ kind: 'form' });
        } else {
          showCreated(result);
        }
        return;
      }
      let restitchOperationId: string | null = null;
      let catalogKey = `product-catalog:${crypto.randomUUID()}`;
      if (restitch) {
        const defaults = restitchDefaults;
        if (!defaults) throw new Error('RESTITCH_DEFAULTS_INVALID');
        const receipt = await prepareCatalogRestitch({
          teamId,
          video,
          defaults,
          durationMode,
          customSeconds,
          durationRangeSeconds: duration.finalDurationRangeSeconds,
          catalogKey,
          previous: processed,
          onOperationStarted: id => {
            if (submitOwns()) setRestitchOperationId(id);
          },
          client
        });
        if (!submitOwns()) return;
        restitchOperationId = receipt.operationId;
        catalogKey = receipt.catalogKey;
        setProcessed(receipt);
        setPhase({ kind: 'busy', step: 'catalog' });
      }
      const result = await client.createProductCatalog({
        catalogImageContractVersion: 3,
        teamId,
        videoMaterialId: video.id,
        sourceLink: linkCheck.value,
        productCount: countCheck.value,
        randomLinkVariation: true,
        replacesMaterialId: replaces?.id ?? null,
        ...(restitchOperationId ? { restitchOperationId } : {}),
        ...(copyVideoToR2 ? { copyVideoToR2: true } : {}),
        // A retry after the video finished must reuse the same catalog operation.
        idempotencyKey: catalogKey
      });
      if (!submitOwns()) return;
      setPhase({
        kind: 'result',
        heading:
          result.outcome === 'existing' ? 'productCatalogAlreadyExists' : 'productCatalogReady',
        catalog: result.catalog
      });
      onCreated?.(result);
    } catch (error) {
      if (!submitOwns()) return;
      const localPreparationFailure = isCatalogForegroundPreparationFailure(error);
      const refused =
        (isCatalogForegroundAdmissionRefused(error) || localPreparationFailure) &&
        submittedVideoKey !== null &&
        videoKey.current === submittedVideoKey;
      if (refused) {
        if (videoStorageKey && localStorage.getItem(videoStorageKey) === submittedVideoKey)
          forgetPendingCreation(videoStorageKey);
        videoKey.current = null;
        videoOwner.current = null;
        videoCancelId.current = null;
        setVideoUnknown(false);
        setVideoPending(null);
        videoFlow.current?.fail(teamErrorCodeOf(error) ?? 'PROCESS_RESULT_UNCERTAIN');
      }
      const key = errorKey(error);
      setFailure(
        refused && !localPreparationFailure
          ? t('launchesCatalogExecutorRequired')
          : key
            ? t(key)
            : teamErrorMessageFor(error, t)
      );
      setFailureNeedsSettings(key === 'productCatalogErrorSettingsMissing');
      setPhase({ kind: 'form' });
    }
  };

  /** Forget a pending creation this browser remembered. A canceled operation is
   * final for this dialog: keeping its key made every reopen show the old
   * operation and blocked a new catalog for the video (production, 1.4.2). */
  const forgetVideo = (key: string | null) => {
    try {
      if (videoStorageKey && (!key || localStorage.getItem(videoStorageKey) === key))
        forgetPendingCreation(videoStorageKey);
    } catch {
      /* Storage may be unavailable; the in-memory state below still resets. */
    }
    if (!key || videoKey.current === key) {
      videoKey.current = null;
      videoOwner.current = null;
      videoCancelId.current = null;
    }
  };
  const dismissVideo = () => {
    forgetVideo(videoKey.current);
    setVideoPending(null);
    setVideoUnknown(false);
    setReadInterrupted(false);
    setFailure(null);
    setPhase({ kind: 'form' });
  };
  const checkVideo = async (cancel = false, resume = false) => {
    const key = videoKey.current;
    const originalOwner = videoOwner.current;
    if (
      !key ||
      !originalOwner ||
      originalOwner.actor !== privateCacheActor() ||
      originalOwner.epoch !== privateCacheEpoch()
    )
      return;
    if (videoCommandBusy.current) {
      videoReadDirty.current = true;
      return;
    }
    videoCommandBusy.current = true;
    const run = observationRun.current,
      actor = privateCacheActor(),
      epoch = privateCacheEpoch();
    const owns = () =>
      run === observationRun.current &&
      actor === privateCacheActor() &&
      epoch === privateCacheEpoch();
    try {
      videoFlow.current ??= beginCatalogUiFlow('video_create', { parentFlowId: key.split(':')[1] });
      videoFlow.current.stage(cancel ? 'command_cancel_requested' : 'readback_requested');
      let result = cancel
        ? await withCatalogCommandDeadline(
            signal =>
              (client.cancelProductCatalogVideo ?? teamApi.cancelProductCatalogVideo)(
                teamId,
                key,
                videoCancelId.current ?? (videoCancelId.current = crypto.randomUUID()),
                { signal }
              ),
            new AbortController().signal
          )
        : await withReadDeadline(
            signal =>
              (client.readProductCatalogVideo ?? teamApi.readProductCatalogVideo)(teamId, key, {
                signal
              }),
            new AbortController().signal,
            // A hung read becomes the calm «зв'язок перервався» note after 10 s, not 15.
            CATALOG_VIDEO_READ_DEADLINE_MS
          );
      if (!owns()) return;
      if (!result) {
        setVideoUnknown(true);
        return;
      }
      // Every video is ready: assemble the catalog now instead of waiting for
      // the next background pass (it took 2-2.5 minutes). A read does this on
      // its own; when another executor is already assembling, keep reading.
      if (
        !cancel &&
        result.outcome === 'preparing_video' &&
        result.state === 'preparing' &&
        result.registeredCount === result.requestedCount
      ) {
        try {
          result = await withCatalogCommandDeadline(
            signal =>
              (client.resumeProductCatalogVideo ?? teamApi.resumeProductCatalogVideo)(teamId, key, {
                signal
              }),
            new AbortController().signal
          );
        } catch (cause) {
          const code = teamErrorCodeOf(cause);
          if (resume || (code !== 'GROUP_RECONCILING' && code !== 'LEASE_MISMATCH')) throw cause;
        }
        if (!owns()) return;
      }
      setVideoUnknown(false);
      // A read that answered supersedes the failure of the one before it.
      setFailure(null);
      setReadInterrupted(false);
      if (
        result.outcome === 'preparing_video' &&
        (createdCatalog.current?.videoGenerationObservation ??
          createdCatalog.current?.videoGeneration)
      ) {
        const progress: CatalogCreatedVideoProgress = {
          ...(createdCatalog.current!.videoGenerationObservation ??
            createdCatalog.current!.videoGeneration!),
          videoSetId: result.videoSetId,
          requestedCount: result.requestedCount,
          registeredCount: result.registeredCount,
          state: result.state
        };
        showCreated({ ...createdCatalog.current!, videoGenerationObservation: progress });
      } else if (result.outcome === 'preparing_video') {
        videoFlow.current?.stage(
          result.state === 'canceled' ? 'command_cancelled' : 'command_accepted'
        );
        if (result.state === 'canceled') forgetVideo(key);
        setVideoPending(result);
      } else {
        showCreated(result);
      }
    } catch (cause) {
      if (owns()) {
        // 1.4.2 prod (Windows, 3 variations): a loaded server failed one poll
        // and the window put a red "something went wrong" beside "1 of 3" while
        // the agent kept stitching. A read lost on the line says nothing about
        // a run already known to be progressing: keep its state, keep polling.
        const progress =
          createdCatalog.current?.videoGenerationObservation ??
          createdCatalog.current?.videoGeneration;
        const progressing =
          (videoPending !== null &&
            ['preparing', 'cancel_requested'].includes(videoPending.state)) ||
          (progress !== undefined && ['preparing', 'cancel_requested'].includes(progress.state));
        if (!cancel && progressing && isSoftReadFailure(cause)) {
          setReadInterrupted(true);
          return;
        }
        setReadInterrupted(false);
        setVideoUnknown(true);
        // A timeout or lost connection says nothing about the operation; the
        // person only needs to know it is temporary and the action is still there.
        setFailure(
          isTransientCatalogFailure(cause) ? t('catalogServerSlow') : teamErrorMessageFor(cause, t)
        );
      }
    } finally {
      videoCommandBusy.current = false;
      if (videoReadDirty.current) {
        videoReadDirty.current = false;
        queueMicrotask(() => void checkVideoRef.current());
      }
    }
  };
  // Reopened on a creation this browser started earlier: the next free number is not its name.
  const [resumedCreation, setResumedCreation] = useState(false);
  // The name the creation was submitted under; the next free number has moved on.
  const [resumedName, setResumedName] = useState<string | null>(null);
  useEffect(() => {
    setResumedCreation(false);
    setResumedName(null);
    videoKey.current = null;
    videoOwner.current = null;
    setReadInterrupted(false);
    setVideoPending(null);
    setVideoUnknown(false);
    setCreatedVideo(null);
    createdCatalog.current = null;
    deliveredCatalog.current = null;
    if (!videoProtocol || !videoStorageKey) return;
    try {
      const key = localStorage.getItem(videoStorageKey);
      if (key && /^product-catalog:[0-9a-f-]{36}$/iu.test(key)) {
        videoKey.current = key;
        videoOwner.current = { actor: privateCacheActor(), epoch: privateCacheEpoch() };
        setVideoUnknown(true);
        setResumedCreation(true);
        const form = readPendingCreationForm(videoStorageKey, key);
        if (form) {
          setLink(form.link);
          setCount(form.count);
          setCopyVideoToR2(form.copyVideoToR2);
          setVideoDraft(form.videoDraft);
          setResumedName(form.name);
          if (form.restitch) {
            if (form.duration)
              durationPreference.current = { key: preferenceKey, value: form.duration };
            setRestitch(true);
            setRestitchRequested(true);
          }
        }
        void checkVideo();
      }
    } catch {
      setFailure(t('catalogPublicationStorageError'));
    }
  }, [videoProtocol, videoStorageKey]);
  const checkVideoRef = useRef(checkVideo);
  checkVideoRef.current = checkVideo;
  useEffect(() => {
    if (videoProtocol && videoKey.current) void checkVideoRef.current();
  }, [videoProtocol, workspaceRevision, updaterRevision]);
  // All videos are ready and the catalog is not registered yet: normally the server
  // does it within seconds, so the nudge waits out a grace period first.
  const allVideosReady = Boolean(
    videoPending?.state === 'preparing' &&
    videoPending.registeredCount === videoPending.requestedCount
  );
  const [resumeOffered, setResumeOffered] = useState(false);
  useEffect(() => {
    setResumeOffered(false);
    if (!allVideosReady) return;
    readSoon.current = Date.now() + CREATION_FAST_READ_WINDOW_MS;
    const timer = setTimeout(() => setResumeOffered(true), CATALOG_VIDEO_RESUME_GRACE_MS);
    return () => clearTimeout(timer);
  }, [allVideosReady]);
  const videoWatching = Boolean(
    videoProtocol &&
    (videoPending ||
      videoUnknown ||
      (createdVideo && !['ready', 'canceled'].includes(createdVideo.state)))
  );
  // Agent events say when a video finished; the server then finishes the catalog
  // on its own, in the background, and nothing announces that. Re-read on a
  // widening timer while anything is still pending, so the window does not sit
  // on a stale count after the server is done (1.4.2).
  useEffect(() => {
    if (!videoWatching) return;
    let delay = VIDEO_READBACK_INITIAL_MS;
    let timer = setTimeout(function tick() {
      if (videoKey.current) void checkVideoRef.current();
      const pending = videoPendingRef.current;
      const making =
        pending?.state === 'preparing' && pending.registeredCount < pending.requestedCount;
      delay =
        Date.now() < readSoon.current
          ? VIDEO_READBACK_INITIAL_MS
          : Math.min(delay * 2, making ? VIDEO_READBACK_ACTIVE_MAX_MS : VIDEO_READBACK_MAX_MS);
      timer = setTimeout(tick, delay);
    }, delay);
    return () => clearTimeout(timer);
  }, [videoWatching]);
  useAgentEventStream<{
    type: 'team:operations';
    operations: Array<{ operationId: string; state: string }>;
  }>({
    url:
      videoProtocol &&
      (videoPending ||
        videoUnknown ||
        (createdVideo && !['ready', 'canceled'].includes(createdVideo.state)))
        ? toolEventUrl('team')
        : null,
    channel: 'team',
    multiplexed: Boolean(agent?.capabilities?.includes('event-stream')),
    enabled: Boolean(
      videoProtocol &&
      (videoPending ||
        videoUnknown ||
        (createdVideo && !['ready', 'canceled'].includes(createdVideo.state)))
    ),
    onOpen: () => {
      if (videoKey.current) void checkVideoRef.current();
    },
    onReconnect: () => {
      if (videoKey.current) void checkVideoRef.current();
    },
    onMessage: event => {
      if (event.type !== 'team:operations') return;
      const signature = event.operations
        .filter(row => row.state !== 'running')
        .map(row => `${row.operationId}:${row.state}`)
        .sort()
        .join('|');
      if (signature === nativeTerminals.current) return;
      nativeTerminals.current = signature;
      if (videoKey.current) void checkVideoRef.current();
    }
  });
  useEffect(() => {
    if (phase.kind === 'result') videoFlow.current?.complete();
    else if (videoPending?.state === 'canceled') videoFlow.current?.cancel();
  }, [phase, videoPending]);
  const copy = async (text: string, done: TranslationKey = 'productCatalogLinkCopied') => {
    try {
      await navigator.clipboard.writeText(text);
      push({ tone: 'success', text: t(done) });
    } catch {
      push({ tone: 'error', text: t('teamToastLinkCopyFailed') });
    }
  };

  // Under load the first reads after a create can take seconds; that is a result
  // still being read, not an uncertain one. «Результат ще не підтверджено» flashed
  // for 9 s before «Каталог готовий» (1.4.3 QA). It waits for a failure or a while.
  const unknownLingers = useSustained(
    videoUnknown && phase.kind !== 'busy',
    CREATION_UNCERTAIN_PATIENCE_MS
  );
  if (phase.kind === 'result') {
    const shown = phase.catalog;
    return (
      <Modal labelledBy={titleId} onClose={onClose} closeLabel={t('productCatalogDone')} size="md">
        <div className="team-dialog-form product-catalog-dialog">
          <h2 id={titleId}>{t(phase.heading)}</h2>
          <div className="product-catalog-dialog-name-row">
            <p className="product-catalog-dialog-name">{shown.name}</p>
            <InventoryButton
              type="button"
              size="sm"
              variant="secondary"
              aria-label={t('productCatalogCopyNameOf', { name: shown.name })}
              onClick={() => void copy(shown.name, 'productCatalogNameCopied')}
            >
              {t('productCatalogCopyName')}
            </InventoryButton>
          </div>
          <p className="field-hint">{t('productCatalogProducts', { count: shown.productCount })}</p>
          {/* The publication line (scheduled time, writer state) belongs to every
              video-protocol catalog, including a restitched deferred one. */}
          {videoProtocol && (
            <CatalogCreatedPublicationStatus
              teamId={teamId}
              catalogId={createdCatalog.current?.catalog.materialId ?? ''}
              read={client.readCatalogPublication}
              // Canceling the videos holds the publication; a new count may unblock it.
              refresh={createdVideo ? `${createdVideo.state}:${createdVideo.registeredCount}` : ''}
              videoCanceled={createdVideo?.state === 'canceled'}
              // The publication can see every video ready before this dialog's own
              // widening re-read does; catch the count up instead of showing 2 of 3.
              onTargetReady={() => {
                readSoon.current = Date.now() + CREATION_FAST_READ_WINDOW_MS;
                if (videoKey.current) void checkVideoRef.current();
              }}
            />
          )}
          {createdVideo && (
            <>
              <p role="status">
                {t(
                  createdVideo.state === 'canceled'
                    ? 'catalogVideoGenerationCanceled'
                    : createdVideo.state === 'cancel_requested'
                      ? 'catalogVideoCreationCanceling'
                      : 'catalogVideoCreationProgress',
                  { ready: createdVideo.registeredCount, total: createdVideo.requestedCount }
                )}
              </p>
              {createdVideo.catalogVideoCells === 'deferred_blank' && (
                <p className="field-hint">{t('catalogVideoDeferredTableReady')}</p>
              )}
              {videoKey.current && (
                <div className="team-dialog-actions">
                  <InventoryButton type="button" onClick={() => void checkVideo()}>
                    {t('catalogPublicationCheck')}
                  </InventoryButton>
                  {!['ready', 'canceled', 'cancel_requested'].includes(createdVideo.state) && (
                    <InventoryButton type="button" onClick={() => void checkVideo(true)}>
                      {t('catalogVideoCancel')}
                    </InventoryButton>
                  )}
                </div>
              )}
            </>
          )}

          <div className="team-dialog-actions">
            <a
              className="soty-button button-secondary"
              href={shown.sheetUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t('productCatalogOpen')}
            >
              {t('productCatalogOpenShort')}
            </a>
            <Button
              type="button"
              variant="secondary"
              aria-label={t('productCatalogCopyLink')}
              onClick={() => void copy(shown.sheetUrl)}
            >
              {t('productCatalogCopyLinkShort')}
            </Button>
            <Button type="button" variant="primary" onClick={onClose}>
              {t('productCatalogDone')}
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  const busy = phase.kind === 'busy' || videoPending !== null || videoUnknown;
  // While the create request is still on its way the result is not "unconfirmed"
  // yet: that only becomes true once the request failed without an answer.
  const requestInFlight = phase.kind === 'busy';
  const showVideoUnknown = videoUnknown && !requestInFlight && (failure !== null || unknownLingers);
  const checkingCreation = videoUnknown && !requestInFlight && !showVideoUnknown;
  // A tracked creation has its own actions (check, resume, cancel the video); the
  // form's close and create would be a second "Скасувати" and a dead "Створити".
  const videoTracked =
    !requestInFlight &&
    (videoPending !== null ||
      videoUnknown ||
      Boolean(createdVideo && !['ready', 'canceled'].includes(createdVideo.state)));
  // An empty field is not a mistake yet — Create simply waits for it. The dialog opened with
  // "Paste a link that starts with http://" in red before anything had been typed.
  const shownName = resumedCreation ? resumedName : plannedName;
  const linkError = touched.link && link.trim() !== '' && !linkCheck.ok;
  const countError = touched.count && !countCheck.ok;

  return (
    <Modal
      labelledBy={titleId}
      // Only the few seconds of the create request itself hold the window: once the
      // server has the creation, closing is safe and "Показати прогрес" brings it back.
      onClose={requestInFlight ? () => undefined : onClose}
      closeOnBackdrop={!requestInFlight}
      closeOnEscape={!requestInFlight}
      closeLabel={t('teamClose')}
      initialFocus={`[id="${linkId}"]`}
      size="md"
      className="product-catalog-create-surface"
    >
      <form
        noValidate
        className="team-dialog-form product-catalog-dialog"
        onSubmit={event => void submit(event)}
      >
        <header className="product-catalog-create-header">
          <h2 id={titleId}>
            {t(
              replaces
                ? 'productCatalogRecreate'
                : variation
                  ? 'productCatalogCreateVariation'
                  : 'productCatalogCreate'
            )}
          </h2>
          {shownName ? (
            <div className="product-catalog-dialog-name-row">
              <p className="product-catalog-dialog-name" title={shownName}>
                {shownName}
              </p>
              <IconButton
                size="sm"
                variant="outline"
                label={t('productCatalogCopyNameOf', { name: shownName })}
                title={t('productCatalogCopyName')}
                onClick={() => void copy(shownName, 'productCatalogNameCopied')}
              >
                <Copy size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              </IconButton>
            </div>
          ) : (
            <p className="product-catalog-dialog-name">{video.name}</p>
          )}
        </header>
        <div className="product-catalog-create-body">
          {replaces && <p className="field-hint">{t('productCatalogRecreateNotice')}</p>}

          {settings === null && !can('manage_metadata') && (
            <p className="team-inline-note">{t('productCatalogMissingSettingsNoAccess')}</p>
          )}

          <div className="product-catalog-create-fields">
            <div className="product-catalog-link-field">
              <label htmlFor={linkId}>
                <span>{t('productCatalogSourceLinkLabel')}</span>
                <input
                  id={linkId}
                  type="text"
                  inputMode="url"
                  autoComplete="off"
                  required
                  value={link}
                  placeholder={t('productCatalogSourceLinkPlaceholder')}
                  disabled={busy}
                  aria-invalid={linkError}
                  aria-describedby={`${linkId}-help`}
                  onChange={event => setLink(event.target.value)}
                  onBlur={() => setTouched(current => ({ ...current, link: true }))}
                />
              </label>
              <p
                id={`${linkId}-help`}
                className={linkError ? 'team-inline-error' : 'sr-only'}
                role={linkError ? 'alert' : undefined}
              >
                {t(linkError ? 'productCatalogLinkInvalid' : 'productCatalogSourceLinkHint')}
              </p>
            </div>
            <div className="product-catalog-count-field">
              <label htmlFor={countId}>
                <span>
                  {t('productCatalogCountLabel')}{' '}
                  <span className="product-catalog-count-limit" aria-hidden="true">
                    1–400
                  </span>
                </span>
                <input
                  id={countId}
                  className="product-catalog-count"
                  inputMode="numeric"
                  required
                  maxLength={3}
                  value={count}
                  disabled={busy}
                  aria-invalid={countError}
                  aria-describedby={`${countId}-help`}
                  onChange={event =>
                    setCount(event.target.value.replace(/[^\d]/gu, '').slice(0, 3))
                  }
                  onBlur={() => setTouched(current => ({ ...current, count: true }))}
                />
              </label>
              <p
                id={`${countId}-help`}
                className={countError ? 'team-inline-error' : 'sr-only'}
                role={countError ? 'alert' : undefined}
              >
                {t(countError ? 'productCatalogCountInvalid' : 'productCatalogCountHint')}
              </p>
            </div>
          </div>

          {videoProtocol && (
            <CatalogCreationVideoFields
              value={videoDraft}
              onChange={setVideoDraft}
              restitch={restitch}
              productCount={productTotal}
              disabled={busy}
            />
          )}
          <div className="product-catalog-restitch">
            <Checkbox
              checked={restitch}
              disabled={busy}
              onChange={event => {
                setRestitch(event.target.checked);
                if (event.target.checked) setRestitchRequested(true);
                setProcessed(null);
              }}
              label={t('productCatalogRestitch')}
            />
            {restitch && restitchDefaults === undefined && !restitchLoadError && (
              <Skeleton
                className="product-catalog-restitch-loading"
                shape="block"
                label={t('loading')}
              />
            )}
            {restitch && restitchLoadError && (
              <div className="product-catalog-dialog-missing" role="alert">
                <p className="team-inline-note">{t('productCatalogRestitchLoadFailed')}</p>
                <InventoryButton
                  size="sm"
                  variant="outline"
                  onClick={() => setRestitchReadRevision(value => value + 1)}
                >
                  {t('retry')}
                </InventoryButton>
              </div>
            )}
            {restitch &&
              restitchDefaults !== undefined &&
              (!restitchDefaults ||
                !restitchDefaultsSaveable({ ...restitchDefaults, operation: 'restitch' })) && (
                <div className="product-catalog-dialog-missing" role="status">
                  <p className="team-inline-note">{t('teamRestitchNotConfigured')}</p>
                  <SpaceSettingsLink
                    target={{ kind: 'settings', tab: 'restitch' }}
                    label={t('productCatalogOpenSettings')}
                  />
                </div>
              )}
            {restitch &&
              restitchDefaults &&
              restitchDefaultsSaveable({ ...restitchDefaults, operation: 'restitch' }) && (
                <RestitchDurationControl
                  value={duration}
                  disabled={busy}
                  labels={{
                    duration: t('launchesDuration'),
                    range: t('launchesDurationRange'),
                    exact: t('launchesDurationExact'),
                    unit: t('launchesMinutesShort')
                  }}
                  onChange={value => {
                    durationPreference.current = { key: preferenceKey, value };
                    setDuration(value);
                    saveCatalogDurationPreference(preferenceKey, value);
                  }}
                />
              )}
            {restitch && restitchDefaults && !durationValid && (
              <p className="team-inline-error" role="alert">
                {t('launchesDurationInvalid')}
              </p>
            )}
          </div>
          <div className="product-catalog-restitch">
            <CatalogVideoR2Toggle
              mode="create"
              control="checkbox"
              teamId={teamId}
              checked={copyVideoToR2}
              onChange={setCopyVideoToR2}
              disabled={busy}
            />
          </div>

          {phase.kind === 'busy' && phase.step === 'restitch' && (
            <CatalogRestitchProgress
              key={`${teamId}:${restitchOperationId ?? 'preparing'}`}
              teamId={teamId}
              operationId={restitchOperationId}
              client={client}
            />
          )}
          <ProductCatalogProgress
            active={phase.kind === 'busy' && phase.step === 'catalog'}
            productTotal={productTotal}
          />
          {videoPending && (
            <p role="status">
              {t(
                videoPending.state === 'canceled'
                  ? 'catalogVideoCreationCanceled'
                  : videoPending.state === 'cancel_requested'
                    ? 'catalogVideoCreationCanceling'
                    : 'catalogVideoCreationProgress',
                { ready: videoPending.registeredCount, total: videoPending.requestedCount }
              )}
            </p>
          )}
          {/* Only while a video is still owed by the computer: once every video
              is registered the server assembles the catalog on its own. */}
          {(videoPending?.agentSilent || videoPending?.agentUnreachable) &&
            (videoPending.state === 'preparing' || videoPending.state === 'unknown') &&
            videoPending.registeredCount < videoPending.requestedCount && (
              <p role="status">{t('catalogVideoAgentSilent')}</p>
            )}
          {readInterrupted && !failure && (
            <p role="status" className="team-inline-note">
              {t('catalogVideoReadInterrupted')}
            </p>
          )}
          {showVideoUnknown && <p role="status">{t('catalogVideoCreationUnknown')}</p>}
          {checkingCreation && !readInterrupted && (
            <p role="status" className="team-inline-note">
              {t('catalogVideoCheckingCreation')}
            </p>
          )}
          {videoTracked && (
            <div className="team-dialog-actions">
              <InventoryButton type="button" onClick={() => void checkVideo()}>
                {t('catalogPublicationCheck')}
              </InventoryButton>
              {(showVideoUnknown || (allVideosReady && resumeOffered)) && (
                <InventoryButton type="button" onClick={() => void checkVideo(false, true)}>
                  {t('catalogVideoResume')}
                </InventoryButton>
              )}
              {videoPending?.state !== 'canceled' && videoPending?.state !== 'cancel_requested' && (
                <InventoryButton
                  type="button"
                  aria-label={t('catalogVideoCancel')}
                  onClick={() => void checkVideo(true)}
                >
                  {t('productCatalogCancel')}
                </InventoryButton>
              )}
              {(videoPending?.state === 'canceled' ||
                videoPending?.state === 'cancel_requested') && (
                <InventoryButton type="button" onClick={dismissVideo}>
                  {t('productCatalogDone')}
                </InventoryButton>
              )}
            </div>
          )}
          {failure && (
            <p className="team-inline-error" role="alert">
              {failure}
            </p>
          )}
          {failure && failureNeedsSettings && can('manage_metadata') && (
            <SpaceSettingsLink
              target={{ kind: 'settings', tab: 'product-catalog' }}
              label={t('productCatalogOpenSettings')}
            />
          )}
        </div>
        {!videoTracked && (
          <div className="team-dialog-actions">
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              {t('productCatalogCancel')}
            </Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!canConfirm}>
              {t(replaces ? 'productCatalogRecreateConfirm' : 'productCatalogConfirm')}
            </Button>
          </div>
        )}
      </form>
    </Modal>
  );
}
