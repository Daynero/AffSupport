import {
  APPAREL_POOL_MAX,
  clothesInPictures,
  generateApparelTexts,
  type PicturedClothes
} from '../_shared/apparel-texts.ts';

type Rpc = (name: string, parameters: Record<string, unknown>) => Promise<unknown>;
interface Claim {
  teamId: string;
  runId: string;
  leaseToken: string;
  count: number;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function claim(value: unknown): Claim {
  if (
    !record(value) ||
    typeof value.teamId !== 'string' ||
    typeof value.runId !== 'string' ||
    typeof value.leaseToken !== 'string' ||
    !Number.isInteger(value.count) ||
    (value.count as number) < 1 ||
    (value.count as number) > APPAREL_POOL_MAX
  ) {
    throw new Error('INVALID_RESPONSE');
  }
  return value as unknown as Claim;
}
function pictured(value: unknown): PicturedClothes | undefined {
  if (!record(value)) throw new Error('INVALID_RESPONSE');
  if (value.mode === 'legacy') {
    if (!Array.isArray(value.names) || !value.names.every(name => typeof name === 'string'))
      throw new Error('INVALID_RESPONSE');
    return value.names.length ? clothesInPictures(value.names) : undefined;
  }
  if (
    value.mode !== 'v2' ||
    !Array.isArray(value.pairs) ||
    !value.pairs.every(
      pair => record(pair) && typeof pair.garment === 'string' && typeof pair.color === 'string'
    )
  )
    throw new Error('INVALID_RESPONSE');
  const pairs = value.pairs as Array<{ garment: string; color: string }>;
  return pairs.length
    ? {
        garments: [...new Set(pairs.map(pair => pair.garment))],
        colors: [...new Set(pairs.map(pair => pair.color))],
        pairs
      }
    : undefined;
}

/** No network provider or browser is required: only bounded reads, pure generation and one DB commit. */
export async function runCatalogTextScheduleTick(rpc: Rpc, random: () => number = Math.random) {
  const claimed = await rpc('service_claim_catalog_text_schedule', { p_limit: 2 });
  if (!Array.isArray(claimed) || claimed.length > 2) throw new Error('INVALID_RESPONSE');
  const summary = { claimed: claimed.length, committed: 0, failed: 0, unsettled: 0 };
  for (const raw of claimed) {
    const item = claim(raw);
    const ids = { p_team: item.teamId, p_run: item.runId, p_lease: item.leaseToken };
    let code = 'READ_FAILED';
    try {
      const inputs = pictured(await rpc('service_catalog_text_schedule_inputs', ids));
      code = 'VALIDATION';
      const texts = generateApparelTexts(item.count, random, inputs);
      // Never replace a full pool with a short generation or invalid classification result.
      if (texts.length !== item.count) throw new Error('INVALID_RESPONSE');
      code = 'SAVE_FAILED';
      const committed = await rpc('service_commit_catalog_text_schedule', {
        ...ids,
        p_items: texts
      });
      if (committed !== true) {
        code = 'CONFLICT';
        throw new Error('CONFLICT');
      }
      summary.committed += 1;
    } catch {
      summary.failed += 1;
      // A lost commit reply may already be committed. Failure settlement is lease-fenced;
      // a false/unknown reply never authorizes a second write in this invocation.
      try {
        const settled = await rpc('service_fail_catalog_text_schedule', { ...ids, p_code: code });
        if (settled !== true) summary.unsettled += 1;
      } catch {
        summary.unsettled += 1;
      }
    }
  }
  return summary;
}

/** Isolate this independent lane: claim/transport failure must not starve catalog or Launch recovery. */
export async function runCatalogTextScheduleTickSafely(rpc: Rpc) {
  try {
    return await runCatalogTextScheduleTick(rpc);
  } catch {
    // No raw provider errors or content. Existing claims remain lease-recoverable;
    // absent claim evidence is unknown, never reported as a completed replacement.
    return { unavailable: true as const };
  }
}
