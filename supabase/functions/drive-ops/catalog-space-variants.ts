// @deno-types="../../../packages/shared/dist/team/catalog-video-set.d.ts"
import { createCatalogVideoAssignment } from '../../../packages/shared/dist/team/catalog-video-set.js';
// @deno-types="../../../packages/shared/dist/team/catalog-video-r2.d.ts"
import { isCatalogVideoR2PublicUrl } from '../../../packages/shared/dist/team/catalog-video-r2.js';
// @deno-types="../../../packages/shared/dist/team/restitch.d.ts"
import {
  parseTeamRestitchDefaults,
  type TeamRestitchDefaults
} from '../../../packages/shared/dist/team/restitch.js';
import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
import type { SpaceCatalogRpc } from './catalog-space-source.ts';
import {
  CatalogVideoPreparationPending,
  catalogPlanVideoSets,
  type CatalogInitialVideoAuthority,
  type CatalogInitialVideoPlan,
  type CatalogVideoPreparingResult
} from './catalog-video-generation.ts';

/**
 * 057 T096 (research.md R15): the video authority of a catalog with re-stitched variations in
 * an R2 space. The durable generator is the Drive one — it plans the rows, the variation
 * requests and the assignment seed, keeps the plan in the creation intent and answers
 * `preparing_video` until this authority says the videos are ready — only the authority over
 * the videos is the space's:
 *
 * - `prepare` admits the set once (`service_admit_space_catalog_variants`: the plan's set id and
 *   request ids, the member's effective re-stitch settings with the dialog's duration, frozen)
 *   and reads its progress. The variations themselves are run by the member's agent through
 *   space-storage `/catalog-variants/run`; nothing here talks to an agent or to Drive.
 * - once every variation has its output, each output gets its public R2 copy (050, planned or
 *   ready: `service_space_catalog_video_link`) and the rows take those addresses through the
 *   same seeded assignment a Drive set uses (`createCatalogVideoAssignment`).
 * - the link (`service_link_space_catalog_feed` with the set id the binding carries) binds the
 *   set to the catalog and makes the catalog the copies' user; there is no Drive publication to
 *   verify afterwards, so `registerCreated` and the re-verification lane have nothing to do.
 *
 * A link published later (T102) is the same set: the creation waits for every variation as for
 * one published at once (so the catalog never names a variation that does not exist), then makes
 * the catalog with empty video cells; the link registers the scheduled policy, and the feed's
 * publication lane writes these addresses when it is due.
 *
 * T115: a Launch's catalog of several re-stitched videos (062) has a set per video, admitted with
 * the Launch (20261226320000); each video's rows take its own variations through its segment's
 * seed, and the link binds every set. A later link for several videos is refused (it needs a
 * publication target per creative).
 */

export interface SpaceVariantBinding {
  /** The set whose outputs the catalog links, once `prepare` answered ready. */
  setId: string | null;
  /** T115: a Launch's catalog of several videos links a set per video (each video's own). */
  setIds?: readonly string[] | null;
  /** T102: the rows' addresses `prepare` proved, kept for a catalog whose cells wait for later. */
  videoLinks?: readonly string[] | null;
  /** T115: each video creative's own first variation, for the creative's record in the layout. */
  creativeLinks?: Readonly<Record<string, string>> | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** The settings a new set freezes, or null when the member's cannot make a file. */
export function spaceVariantSettings(
  raw: unknown,
  duration: CatalogInitialVideoPlan['preferences']['restitchDuration']
): TeamRestitchDefaults | null {
  const parsed = parseTeamRestitchDefaults(raw);
  if (!parsed.ok || !parsed.value.configured) return null;
  const merged = parseTeamRestitchDefaults({ ...(raw as object), ...(duration ?? {}) });
  if (!merged.ok || !merged.value.configured) return null;
  return merged.value;
}

interface Progress {
  state: 'preparing' | 'ready' | 'unknown' | 'canceled';
  requestedCount: number;
  registeredCount: number;
}

function parseProgress(value: unknown, setId: string): Progress {
  if (
    !isRecord(value) ||
    value.setId !== setId ||
    !['preparing', 'ready', 'unknown', 'canceled'].includes(String(value.state)) ||
    !Number.isSafeInteger(value.requestedCount) ||
    !Number.isSafeInteger(value.registeredCount) ||
    (value.registeredCount as number) < 0 ||
    (value.registeredCount as number) > (value.requestedCount as number)
  )
    throw new TeamFunctionError('INVALID_RESPONSE');
  return {
    state: value.state as Progress['state'],
    requestedCount: value.requestedCount as number,
    registeredCount: value.registeredCount as number
  };
}

/** One video's set of a plan: its rows, its requests and its seed (a plan's segment, or the plan). */
interface PlannedSet {
  ordinal: number;
  setId: string;
  sourceMaterialId: string;
  rowIds: string[];
  variantCount: number;
  requestIds: string[];
  seed: string;
}

function plannedSets(plan: CatalogInitialVideoPlan, sourceMaterialId: string): PlannedSet[] {
  return catalogPlanVideoSets(plan, sourceMaterialId).map(set => {
    const segment = plan.segments?.find(candidate => candidate.ordinal === set.ordinal);
    return {
      ...set,
      requestIds: segment ? segment.childRequestIds : plan.childRequestIds,
      seed: segment ? segment.assignmentSeed : plan.assignmentSeed
    };
  });
}

export function spaceCatalogVideoAuthority(input: {
  rpc: SpaceCatalogRpc;
  teamId: string;
  actorId: string;
  sourceMaterialId: string;
  binding: SpaceVariantBinding;
  /**
   * T115: the settings a Launch froze when it was accepted (its sets were admitted then); a set
   * admitted here for the first time freezes the member's current settings instead.
   */
  frozenSettings?: TeamRestitchDefaults;
}): CatalogInitialVideoAuthority {
  const { rpc, teamId, actorId, sourceMaterialId, binding } = input;
  return {
    async serverNow() {
      const now = await rpc('service_catalog_publication_clock', {});
      if (typeof now !== 'number' || !Number.isSafeInteger(now))
        throw new TeamFunctionError('INVALID_RESPONSE');
      return now;
    },
    async prepare({ intentId, plan }) {
      const scheduled = plan.preferences.videoPublication.mode === 'scheduled';
      if (!scheduled && plan.preferences.videoPublication.mode !== 'immediate')
        throw new TeamFunctionError('STORAGE_BACKEND_MISMATCH', { retryable: false });
      const sets = plannedSets(plan, sourceMaterialId);
      // T115: a later link for several videos needs a publication target per creative.
      if (sets.length > 1 && scheduled)
        throw new TeamFunctionError('MULTI_CREATIVE_UNSUPPORTED', { retryable: false });
      const count = plan.preferences.videoVariationCount;
      if (
        sets.length < 1 ||
        plan.childRequestIds.length !== count ||
        sets.reduce((total, set) => total + set.variantCount, 0) !== count ||
        sets.some(set => !UUID.test(set.setId) || set.requestIds.length !== set.variantCount)
      )
        throw new TeamFunctionError('INVALID_RESPONSE');
      const settings =
        input.frozenSettings ??
        spaceVariantSettings(
          await rpc('service_space_catalog_variant_defaults', { p_team: teamId, p_actor: actorId }),
          plan.preferences.restitchDuration
        );
      const digest = settings ? await sha256Hex(JSON.stringify(settings)) : null;
      // A set admitted before keeps what it froze; a new one needs settings that make a file.
      let registered = 0;
      const states: Array<Progress['state']> = [];
      let failedOrdinal: number | undefined;
      for (const set of sets) {
        const progress = parseProgress(
          await rpc('service_admit_space_catalog_variants', {
            p_team: teamId,
            p_actor: actorId,
            p_intent: intentId,
            p_set: set.setId,
            p_source: set.sourceMaterialId,
            p_requests: set.requestIds,
            p_settings: settings,
            p_settings_digest: digest
          }),
          set.setId
        );
        if (progress.requestedCount !== set.variantCount)
          throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
        registered += progress.registeredCount;
        states.push(progress.state);
        if (progress.state === 'unknown') failedOrdinal ??= set.ordinal;
      }
      // The worst set decides, as for Drive sets (catalog_video_sets_state).
      const state: Progress['state'] = states.includes('unknown')
        ? 'unknown'
        : states.includes('canceled')
          ? 'canceled'
          : states.includes('preparing')
            ? 'preparing'
            : 'ready';
      if (state !== 'ready') {
        // T102: a Drive set answers a later link with the catalog at once and its cells filled
        // when the set is ready; an R2 creation waits for its variations either way.
        if (scheduled)
          throw new CatalogVideoPreparationPending({
            outcome: 'preparing_video',
            catalogIntentId: intentId,
            videoSetId: sets[0]!.setId,
            requestedCount: count,
            registeredCount: registered,
            state
          });
        return {
          state,
          registeredCount: registered,
          ...(sets.length > 1 && failedOrdinal !== undefined ? { failedOrdinal } : {})
        };
      }
      const byRow = new Map<string, string>();
      const creativeLinks: Record<string, string> = {};
      let planned = false;
      for (const set of sets) {
        const outputs = await rpc('service_space_catalog_variant_outputs', {
          p_team: teamId,
          p_actor: actorId,
          p_set: set.setId
        });
        if (
          !Array.isArray(outputs) ||
          outputs.length !== set.variantCount ||
          outputs.some(
            (output, index) =>
              !isRecord(output) ||
              output.index !== index ||
              typeof output.materialId !== 'string' ||
              !UUID.test(output.materialId)
          )
        )
          throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
        const urls: string[] = [];
        for (const output of outputs as Array<{ materialId: string }>) {
          const link = await rpc('service_space_catalog_video_link', {
            p_team: teamId,
            p_actor: actorId,
            p_material: output.materialId
          });
          if (!isRecord(link) || !isCatalogVideoR2PublicUrl(link.url))
            throw new TeamFunctionError('INVALID_RESPONSE');
          if (link.state !== 'ready') planned = true;
          urls.push(link.url as string);
        }
        // Each video's rows take its own variations through its own seed (one set: the plan's).
        const assignment = createCatalogVideoAssignment({
          recipeRevision: 1,
          recipeRowIds: set.rowIds,
          variantCount: set.variantCount,
          seed: set.seed
        });
        for (const row of assignment.assignments)
          byRow.set(row.recipeRowId, urls[row.videoVariantIndex]!);
        const first = byRow.get(set.rowIds[0]!.toLowerCase());
        if (first) creativeLinks[set.sourceMaterialId] = first;
      }
      // The copies not made yet are made by the catalog video worker; nudge it once.
      if (planned)
        await rpc('service_catalog_video_r2_kick', { p_route: 'claim' }).catch(() => undefined);
      const videoLinks = plan.recipeRowIds.map(row => {
        const url = byRow.get(row.toLowerCase());
        if (url === undefined) throw new TeamFunctionError('INVALID_RESPONSE');
        return url;
      });
      binding.setId = sets.length === 1 ? sets[0]!.setId : null;
      binding.setIds = sets.length > 1 ? sets.map(set => set.setId) : null;
      binding.videoLinks = videoLinks;
      binding.creativeLinks = creativeLinks;
      return { state: 'ready', videoLinks };
    },
    // The link registered the set with the catalog in its own transaction.
    async registerCreated() {},
    async claimReverify() {
      return 'done';
    },
    async noteReverify() {}
  };
}

/** The dialog's progress read of an R2 creation, or null when there is none to read. */
export async function readSpaceCatalogVariants(
  service: ServiceRpcClient,
  actorId: string,
  body: unknown
): Promise<CatalogVideoPreparingResult | Record<string, unknown> | null> {
  if (!isRecord(body) || body.expectedActorId !== actorId || typeof body.teamId !== 'string')
    return null;
  if (typeof body.idempotencyKey !== 'string') return null;
  const result = await service.rpc('service_read_space_catalog_variants', {
    p_team: body.teamId,
    p_actor: actorId,
    p_key: body.idempotencyKey
  });
  // A Drive space (STORAGE_BACKEND_MISMATCH) or a stranger: nothing of this kind to read.
  if (result.error || !isRecord(result.data)) return null;
  return result.data;
}

export async function cancelSpaceCatalogVariants(
  service: ServiceRpcClient,
  actorId: string,
  body: unknown
): Promise<CatalogVideoPreparingResult> {
  if (!isRecord(body) || body.expectedActorId !== actorId)
    throw new TeamFunctionError('PERMISSION_DENIED');
  if (
    typeof body.teamId !== 'string' ||
    !UUID.test(body.teamId) ||
    typeof body.idempotencyKey !== 'string'
  )
    throw new TeamFunctionError('INVALID_INPUT');
  const result = await service.rpc('service_cancel_space_catalog_variants', {
    p_team: body.teamId,
    p_actor: actorId,
    p_key: body.idempotencyKey
  });
  if (result.error)
    throw new TeamFunctionError(
      result.error.message === 'PERMISSION_DENIED'
        ? 'PERMISSION_DENIED'
        : result.error.message === 'WRONG_STATE'
          ? 'WRONG_STATE'
          : 'PROCESS_RESULT_UNCERTAIN'
    );
  const data = result.data;
  if (!isRecord(data) || data.outcome !== 'preparing_video' || data.state !== 'canceled')
    throw new TeamFunctionError('INVALID_RESPONSE');
  return data as unknown as CatalogVideoPreparingResult;
}
