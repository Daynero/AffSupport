import {
  SPACE_DERIVATIVE_RECIPE_VERSION,
  spaceFilesUrl,
  type SpaceDerivativeVariant
} from '@video-compressor/shared';
import { privateCacheActor, privateCacheEpoch, registerPrivateCache } from '../private-cache-scope';

/**
 * 057 T051: one address per picture of an R2 file, kept (FR-036).
 *
 * The files host answers every picture `immutable` under a key that names its content, so the
 * browser may keep the bytes for a year — but only under the exact URL it fetched, and that URL
 * carries the read grant, which changes every ten minutes. Building a picture's URL afresh from
 * each new grant would make a grid of two hundred tiles ask the Worker for two hundred pictures
 * every ten minutes it stays open, on a free plan of 100 000 requests a day for everyone.
 *
 * So the first URL built for a picture is the one used from then on, here and after a reload:
 * the browser serves it from its cache without a request. When the browser no longer has the
 * bytes and the old grant is refused (401), the tile forgets the address once and the next one
 * is built from the current grant — exactly one retry (`forgetSpaceMediaUrl`).
 *
 * The addresses are kept per person and dropped with the account. A stored URL's grant has
 * expired long since or will within minutes; it opens nothing the person cannot already open.
 */

const STORE_PREFIX = 'soty-space-media-urls/1:';
/** Enough for a few large folders; the oldest go first. */
export const SPACE_MEDIA_URLS_MAX = 2_000;

let loadedFor: string | null = null;
let urls = new Map<string, string>();
/** Where pictures were last read from: the host whose browser cache a sign-out clears. */
let lastFilesOrigin: string | null = null;

function storageKey(actor: string): string {
  return `${STORE_PREFIX}${actor}`;
}

function load(actor: string): void {
  if (loadedFor === actor) return;
  loadedFor = actor;
  urls = new Map();
  try {
    const raw = window.localStorage.getItem(storageKey(actor));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed))
      for (const item of parsed)
        if (
          Array.isArray(item) &&
          typeof item[0] === 'string' &&
          typeof item[1] === 'string' &&
          item[1].startsWith('http')
        )
          urls.set(item[0], item[1]);
  } catch {
    // No storage: the addresses live as long as the page.
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function save(actor: string): void {
  if (saveTimer !== null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (loadedFor !== actor) return;
    try {
      window.localStorage.setItem(storageKey(actor), JSON.stringify([...urls]));
    } catch {
      // Full or blocked: nothing is lost but a request.
    }
  }, 500);
}

const keyOf = (teamId: string, contentId: string, variant: SpaceDerivativeVariant | null) =>
  `${teamId}/${contentId}/${variant === null ? 'o' : `${SPACE_DERIVATIVE_RECIPE_VERSION}/${variant}`}`;

/** The kept URL of one picture (or the original), or a new one from this grant, then kept. */
export function stableSpaceMediaUrl(input: {
  teamId: string;
  contentId: string;
  variant: SpaceDerivativeVariant | null;
  filesOrigin: string;
  grant: string;
}): string {
  const build = () =>
    spaceFilesUrl({
      filesOrigin: input.filesOrigin,
      teamId: input.teamId,
      contentId: input.contentId,
      grant: input.grant,
      ...(input.variant
        ? {
            derivative: { recipeVersion: SPACE_DERIVATIVE_RECIPE_VERSION, variant: input.variant }
          }
        : {})
    });
  lastFilesOrigin = input.filesOrigin;
  const actor = privateCacheActor();
  if (!actor) return build();
  load(actor);
  const key = keyOf(input.teamId, input.contentId, input.variant);
  const kept = urls.get(key);
  // A files host that moved (a beta stack rebuilt, another channel) makes the kept one useless.
  if (kept && kept.startsWith(`${input.filesOrigin}/`)) {
    urls.delete(key);
    urls.set(key, kept);
    return kept;
  }
  const url = build();
  urls.set(key, url);
  while (urls.size > SPACE_MEDIA_URLS_MAX) urls.delete(urls.keys().next().value!);
  save(actor);
  return url;
}

/**
 * A picture's kept URL was refused: forget it, so the next one is built from the current grant.
 * True when there was one to forget — the caller retries once on true and never on false.
 */
export function forgetSpaceMediaUrl(
  teamId: string,
  contentId: string,
  variant: SpaceDerivativeVariant | null
): boolean {
  const actor = privateCacheActor();
  if (!actor) return false;
  load(actor);
  const removed = urls.delete(keyOf(teamId, contentId, variant));
  if (removed) save(actor);
  return removed;
}

/** Tests, and a sign-out: nothing of this person is kept. */
export function clearSpaceMediaUrls(actor: string | null = loadedFor): void {
  urls = new Map();
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = null;
  if (actor) {
    try {
      window.localStorage.removeItem(storageKey(actor));
    } catch {
      // Nothing to remove.
    }
  }
  loadedFor = null;
}

/**
 * The files host keeps what it served in this browser's cache; `/clear-site-data` answers
 * `Clear-Site-Data: "cache"` for that host (research R4), so a signed-out or removed person's
 * pictures do not stay readable from the disk cache.
 */
export function clearFilesHostCache(
  fetcher: typeof fetch = (input, init) => fetch(input, init)
): void {
  const origin = lastFilesOrigin;
  if (!origin) return;
  void fetcher(`${origin}/clear-site-data`, {
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer'
  }).catch(() => undefined);
}

/*
 * Any change of who is signed in or of what they may open (a sign-out, another account, a space
 * taken away) drops the kept addresses and the files host's cache. Rare, and correct first: a
 * picture is fetched again, never shown to someone who lost it.
 */
let scopeEpoch = privateCacheEpoch();
registerPrivateCache(() => {
  if (privateCacheEpoch() === scopeEpoch) return;
  scopeEpoch = privateCacheEpoch();
  const hadPictures = loadedFor !== null || urls.size > 0;
  clearSpaceMediaUrls();
  if (hadPictures) clearFilesHostCache();
});
