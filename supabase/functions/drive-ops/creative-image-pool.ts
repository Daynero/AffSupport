/**
 * A Launch's image creatives are published a few at a time and within one invocation's CPU.
 *
 * Prod 2026-11-25 (generation 42f6e719, 20 PNG creatives of ~3 MB): each image took ~5 s of
 * Drive and R2 round trips one after another, and every invocation was killed by the edge
 * runtime's CPU limit ("CPU Time exceeded", HTTP 546) after 3–6 images. The lease it held then
 * kept the generation still for its full 180 s before the next minute's pass took it again,
 * so the twenty images took ~20 minutes. Here images overlap (bounded by count and by bytes in
 * memory), and once an invocation has read its share of bytes — or the runtime announces its
 * shutdown — no further image starts: the step yields and the generation is handed straight to
 * a fresh invocation, which resumes from the images already checkpointed.
 */

/** Images published at once: Drive and R2 round trips overlap, quotas stay far away. */
export const CREATIVE_IMAGE_CONCURRENCY = 3;
/** Source bytes held in flight at once (one larger image still runs alone). */
export const CREATIVE_IMAGE_IN_FLIGHT_BYTES = 24_000_000;
/**
 * Source bytes one invocation reads before it yields. Prod CPU per source MB was ~120 ms with
 * the re-deflate and is ~4x less without it (lossless-v1 'when-too-large'); 20 MB keeps an
 * invocation near the 1 s soft limit, well below the 2 s at which the runtime kills it.
 */
export const CREATIVE_IMAGE_INVOCATION_BYTES = 20_000_000;
/** A size Drive did not report counts as the optimizer's public limit. */
const UNKNOWN_SIZE = 8_000_000;

/** Not a failure: the step stopped between images so a fresh invocation continues it. */
export class CatalogStepYield extends Error {
  constructor() {
    super('CATALOG_STEP_YIELD');
    this.name = 'CatalogStepYield';
  }
}

let shutdownAnnounced = false;
try {
  // The edge runtime dispatches `beforeunload` when a worker reaches a soft limit (CPU,
  // memory, wall clock); the hard limit follows. Nothing new should start after it.
  (
    globalThis as { addEventListener?: (type: string, listener: () => void) => void }
  ).addEventListener?.('beforeunload', () => {
    shutdownAnnounced = true;
  });
} catch {
  /* A runtime without the event keeps the byte budget alone. */
}
export const workerShutdownAnnounced = (): boolean => shutdownAnnounced;

export interface CreativeImageBudget {
  bytes: number;
  stopping: () => boolean;
}

/**
 * Runs `publish` over `images` in order, at most `concurrency` at once and at most
 * `inFlightBytes` of sources at once. The first failure stops admission; images already
 * running settle (their checkpoints land) before it is thrown. With a budget, admission stops
 * once the budget's bytes were started or it says it is stopping, and the call throws
 * `CatalogStepYield` after the running ones settle. The first image is always admitted.
 */
export async function publishCreativeImagesBounded<T extends { live: { size: number | null } }>(
  images: readonly T[],
  options: {
    publish: (image: T) => Promise<void>;
    budget: CreativeImageBudget | null;
    concurrency?: number;
    inFlightBytes?: number;
  }
): Promise<void> {
  const concurrency = Math.max(1, options.concurrency ?? CREATIVE_IMAGE_CONCURRENCY);
  const cap = options.inFlightBytes ?? CREATIVE_IMAGE_IN_FLIGHT_BYTES;
  const sizeOf = (image: T) =>
    typeof image.live.size === 'number' && image.live.size > 0 ? image.live.size : UNKNOWN_SIZE;
  let next = 0;
  let started = 0;
  let inFlight = 0;
  let running = 0;
  let failure: { error: unknown } | null = null;
  let yielded = false;
  await new Promise<void>(resolve => {
    const pump = () => {
      while (!failure && !yielded && next < images.length && running < concurrency) {
        const image = images[next]!;
        const size = sizeOf(image);
        if (running > 0 && inFlight + size > cap) break;
        if (
          options.budget &&
          next > 0 &&
          (started >= options.budget.bytes || options.budget.stopping())
        ) {
          yielded = true;
          break;
        }
        next++;
        started += size;
        inFlight += size;
        running++;
        void options
          .publish(image)
          .catch(error => {
            failure ??= { error };
          })
          .finally(() => {
            inFlight -= size;
            running--;
            pump();
          });
      }
      if (running === 0) resolve();
    };
    pump();
  });
  if (failure) throw (failure as { error: unknown }).error;
  if (next < images.length) throw new CatalogStepYield();
}
