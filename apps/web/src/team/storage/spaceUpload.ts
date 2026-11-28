import {
  SPACE_STORAGE_LIMITS,
  normalizePartEtag,
  spaceContentId,
  spaceMd5HexToBase64,
  spacePartBytes,
  spacePartCount,
  spacePartRange
} from '@video-compressor/shared';
import type {
  SpaceAdmitResult,
  SpaceDerivativeVariant,
  SpaceIngress,
  SpaceMaterialSnapshot,
  SpacePartUrl
} from '@video-compressor/shared';
import { rememberSpaceMaterials, spaceStorageApi } from '../../api/space-storage';
import { TeamApiError } from '../../api/team';
import {
  privateCacheActor,
  privateCacheActorEpoch,
  registerPrivateCache
} from '../private-cache-scope';
import {
  defaultSpacePartHasher,
  readSpaceRange,
  spaceCanceled,
  type SpacePartHasher,
  type SpaceUploadSource
} from './spaceHash';
import {
  indexedDbSpaceUploadJournal,
  spaceUploadJournalKey,
  type SpaceUploadJournal,
  type SpaceUploadJournalEntry
} from './spaceUploadJournal';
import { makeSpaceDerivatives, type SpaceDerivativeMaker } from './spaceDerivatives';

export type { SpaceUploadSource } from './spaceHash';

/**
 * 057 T045: one file into an R2 space, straight to R2 (research R3, FR-039).
 *
 * 1. Every part's MD5 is made in a Web Worker and the content id derived from them, so the
 *    server can answer «already there» before a byte moves.
 * 2. Admit. A session names the parts (their size follows from the file's size alone, as on the
 *    server) and the derivatives the server wants of this file.
 * 3. Up to eight parts at a time go to R2 on URLs signed with their `Content-MD5`; R2 refuses a
 *    damaged one. Each acknowledged part is journaled in IndexedDB: a lost network waits for it
 *    to come back, and a reload (or the same file chosen again) resumes with the missing parts.
 * 4. Meanwhile the browser makes the file's pictures from the local file (T047) and stages them
 *    as part of the same commit. A picture that fails never fails the upload.
 * 5. Complete with the ETags R2 returned; the server recomputes the content id from R2's own list.
 *
 * Cancel closes the multipart. A refusal that cannot change (the content does not match, the
 * session is over) forgets the journal; anything else keeps it for the next attempt.
 */

const PART_URL_MARGIN_MS = 30_000;
/** Waits between attempts of one part while the network is away (then it waits for `online`). */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

export interface SpaceUploadInput {
  teamId: string;
  /** Null for the space root. */
  parentMaterialId: string | null;
  name: string;
  contentType: string;
  source: SpaceUploadSource;
  idempotencyKey: string;
  ingress?: SpaceIngress;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
}

export interface SpaceUploadResult {
  materialId: string;
  /** The same content was already there: nothing was sent. */
  reused: boolean;
  material: SpaceMaterialSnapshot | null;
}

export interface SpaceUploadDeps {
  api: Pick<
    typeof spaceStorageApi,
    'admitUpload' | 'partUrls' | 'completeUpload' | 'abortUpload' | 'declareDerivatives'
  >;
  hash: SpacePartHasher;
  journal: SpaceUploadJournal;
  fetch: typeof fetch;
  derivatives: SpaceDerivativeMaker | null;
  parallelParts: number;
  /** Resolves when the network is back (or at once when it never left). */
  online: (signal?: AbortSignal) => Promise<void>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  actor: () => string | null;
}

function waitOnline(signal?: AbortSignal): Promise<void> {
  if (typeof navigator === 'undefined' || navigator.onLine !== false) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      window.removeEventListener('online', onOnline);
      signal?.removeEventListener('abort', onAbort);
    };
    const onOnline = () => {
      done();
      resolve();
    };
    const onAbort = () => {
      done();
      reject(spaceCanceled(signal));
    };
    window.addEventListener('online', onOnline);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(spaceCanceled(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(spaceCanceled(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

let sharedJournal: SpaceUploadJournal | null = null;
const journalOf = () => (sharedJournal ??= indexedDbSpaceUploadJournal());

/* Another account must never resume this one's upload: a change of account forgets them all. */
let journalActorEpoch = privateCacheActorEpoch();
registerPrivateCache(() => {
  if (privateCacheActorEpoch() === journalActorEpoch) return;
  journalActorEpoch = privateCacheActorEpoch();
  void journalOf().clear();
});

export function defaultSpaceUploadDeps(): SpaceUploadDeps {
  return {
    api: spaceStorageApi,
    hash: defaultSpacePartHasher,
    journal: journalOf(),
    fetch: (input, init) => fetch(input, init),
    derivatives: makeSpaceDerivatives,
    parallelParts: SPACE_STORAGE_LIMITS.browserParallelParts,
    online: waitOnline,
    sleep,
    actor: privateCacheActor
  };
}

class RestartFresh extends Error {}

/** Aborted when the caller's signal is (`AbortSignal.any`, which an older Safari lacks). */
function eitherSignal(signal: AbortSignal, halt: AbortController): AbortSignal {
  if (signal.aborted) halt.abort(signal.reason);
  else signal.addEventListener('abort', () => halt.abort(signal.reason), { once: true });
  return halt.signal;
}

/** A file says when it last changed; with its name and size that is what the journal keys on. */
function lastModifiedOf(source: SpaceUploadSource): number | null {
  const value = (source as { lastModified?: unknown }).lastModified;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export async function uploadFileToSpace(
  input: SpaceUploadInput,
  overrides: Partial<SpaceUploadDeps> = {}
): Promise<SpaceUploadResult> {
  const deps = { ...defaultSpaceUploadDeps(), ...overrides };
  const { source, signal } = input;
  const total = source.size;
  if (!Number.isSafeInteger(total) || total < 0) throw new TeamApiError('INVALID_INPUT', false);
  if (total > SPACE_STORAGE_LIMITS.maxObjectBytes)
    throw new TeamApiError('STORAGE_OBJECT_TOO_LARGE', false);
  if (signal?.aborted) throw spaceCanceled(signal);
  const actor = deps.actor();
  const key = actor
    ? spaceUploadJournalKey({
        actorId: actor,
        teamId: input.teamId,
        parentMaterialId: input.parentMaterialId,
        name: input.name,
        size: total,
        lastModified: lastModifiedOf(source)
      })
    : null;
  try {
    return await attempt(input, deps, key, true);
  } catch (failure) {
    if (!(failure instanceof RestartFresh)) throw failure;
    // The journal's hashes no longer match the file (it changed under the same name, size and
    // time): read it again, under a new session.
    return attempt({ ...input, idempotencyKey: crypto.randomUUID() }, deps, key, false);
  }
}

async function attempt(
  input: SpaceUploadInput,
  deps: SpaceUploadDeps,
  key: string | null,
  mayResume: boolean
): Promise<SpaceUploadResult> {
  const { teamId, source, signal } = input;
  const total = source.size;
  const count = spacePartCount(total);
  const saved = key && mayResume ? await deps.journal.get(key) : null;
  const resumed = saved?.teamId === teamId && saved.md5s.length === count ? saved : null;

  const md5s =
    resumed?.md5s ??
    (await deps.hash(source, {
      ...(signal ? { signal } : {}),
      onProgress: () => undefined
    }));
  if (md5s.length !== count) throw new TeamApiError('INVALID_INPUT', false);
  const identity = await spaceContentId(total, md5s);
  if (!identity.ok) throw new TeamApiError('INVALID_INPUT', false);
  const entry: SpaceUploadJournalEntry = {
    key: key ?? '',
    teamId,
    idempotencyKey: resumed?.idempotencyKey ?? input.idempotencyKey,
    md5s,
    contentId: identity.contentId,
    uploadId: resumed?.uploadId ?? null,
    expiresAt: resumed?.expiresAt ?? null,
    etags: resumed && resumed.contentId === identity.contentId ? { ...resumed.etags } : {},
    updatedAt: Date.now()
  };
  const remember = () => (key ? deps.journal.put({ ...entry, updatedAt: Date.now() }) : undefined);
  const forget = () => (key ? deps.journal.delete(key) : undefined);
  await remember();

  const admitted: SpaceAdmitResult = await deps.api.admitUpload(
    {
      teamId,
      parentMaterialId: input.parentMaterialId,
      name: input.name,
      contentType: input.contentType,
      bytes: total,
      contentId: identity.contentId,
      ingress: input.ingress ?? 'explorer',
      idempotencyKey: entry.idempotencyKey
    },
    signal
  );
  if (admitted.kind === 'exists') {
    await forget();
    input.onProgress?.(total, total);
    return { materialId: admitted.materialId, reused: true, material: null };
  }
  const uploadId = admitted.uploadId;
  if (admitted.partCount !== count || admitted.partBytes !== spacePartBytes(total)) {
    await deps.api.abortUpload(teamId, uploadId).catch(() => undefined);
    await forget();
    throw new TeamApiError('INVALID_RESPONSE', false);
  }
  if (entry.uploadId !== uploadId) entry.etags = {};
  entry.uploadId = uploadId;
  entry.expiresAt = admitted.expiresAt;
  await remember();

  // The pictures are made from the local file while its parts go; a failure costs only them.
  const pictures =
    deps.derivatives && admitted.derivativeSlots.length > 0 && source instanceof Blob
      ? stagePictures(
          teamId,
          uploadId,
          source,
          input.contentType,
          admitted.derivativeSlots,
          deps,
          signal
        )
      : Promise.resolve();

  let completing = false;
  try {
    let sent = Object.keys(entry.etags).reduce(
      (sum, part) => sum + spacePartRange(total, Number(part)).bytes,
      0
    );
    input.onProgress?.(sent, total);
    const missing = Array.from({ length: count }, (_, index) => index + 1).filter(
      part => !entry.etags[part]
    );
    for (let first = 0; first < missing.length; first += SPACE_STORAGE_LIMITS.partUrlBatch) {
      const numbers = missing.slice(first, first + SPACE_STORAGE_LIMITS.partUrlBatch);
      const signed = new Map(
        (
          await deps.api.partUrls(
            teamId,
            uploadId,
            numbers.map(partNumber => ({ partNumber, md5: md5s[partNumber - 1]! })),
            signal
          )
        ).map(part => [part.partNumber, part])
      );
      const queue = [...numbers];
      // The first part that fails stops its siblings: none of them keeps sending (or retrying)
      // after this attempt has given up, and the journal holds exactly what R2 acknowledged.
      const halt = new AbortController();
      const partSignal = signal ? eitherSignal(signal, halt) : halt.signal;
      let firstFailure: { error: unknown } | null = null;
      const worker = async () => {
        try {
          await sendParts();
        } catch (error) {
          firstFailure ??= { error };
          halt.abort(new Error('HALTED'));
        }
      };
      const sendParts = async () => {
        for (
          let partNumber = queue.shift();
          partNumber !== undefined && !halt.signal.aborted;
          partNumber = queue.shift()
        ) {
          const md5 = md5s[partNumber - 1]!;
          const range = spacePartRange(total, partNumber);
          const resign = async (): Promise<SpacePartUrl> => {
            const [again] = await deps.api.partUrls(
              teamId,
              uploadId,
              [{ partNumber, md5 }],
              signal
            );
            if (!again || again.partNumber !== partNumber)
              throw new TeamApiError('INVALID_RESPONSE', false);
            signed.set(partNumber, again);
            return again;
          };
          let url = signed.get(partNumber) ?? (await resign());
          if (Date.parse(url.expiresAt) - PART_URL_MARGIN_MS < Date.now()) url = await resign();
          const etag = await putPart(
            {
              url: url.url,
              md5,
              body: () => readSpaceRange(source, range.start, range.end + 1, signal),
              resign: async () => (await resign()).url,
              resumed: resumed !== null,
              signal: partSignal
            },
            deps
          );
          entry.etags[partNumber] = etag;
          await remember();
          sent += range.bytes;
          input.onProgress?.(sent, total);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(deps.parallelParts, numbers.length) }, worker)
      );
      if (firstFailure) throw (firstFailure as { error: unknown }).error;
    }
    await pictures;
    if (signal?.aborted) throw spaceCanceled(signal);
    completing = true;
    const material = await completeWithRetry(
      deps,
      teamId,
      uploadId,
      Array.from({ length: count }, (_, index) => ({
        partNumber: index + 1,
        etag: entry.etags[index + 1]!
      }))
    );
    await forget();
    rememberSpaceMaterials(teamId, [material]);
    return { materialId: material.id, reused: false, material };
  } catch (failure) {
    await pictures.catch(() => undefined);
    if (failure instanceof RestartFresh) {
      await deps.api.abortUpload(teamId, uploadId).catch(() => undefined);
      await forget();
      throw failure;
    }
    if (signal?.aborted) {
      // Cancel: the multipart is closed and nothing is kept to resume.
      await deps.api.abortUpload(teamId, uploadId).catch(() => undefined);
      await forget();
      throw spaceCanceled(signal);
    }
    const final =
      failure instanceof TeamApiError &&
      !failure.retryable &&
      failure.code !== 'TEAM_TRANSPORT_UNAVAILABLE';
    // A complete whose answer was lost may have committed; the session settles on its own and
    // the journal lets the next attempt ask again. A final refusal ends the upload for good.
    if (final && !completing) {
      await deps.api.abortUpload(teamId, uploadId).catch(() => undefined);
      await forget();
    } else if (final) {
      await forget();
    }
    throw failure;
  }
}

/** Makes, declares and stages the pictures the server asked for. Never throws. */
async function stagePictures(
  teamId: string,
  uploadId: string,
  file: Blob,
  contentType: string,
  slots: readonly SpaceDerivativeVariant[],
  deps: SpaceUploadDeps,
  signal?: AbortSignal
): Promise<void> {
  try {
    const made = await deps.derivatives!(file, {
      contentType,
      slots,
      ...(signal ? { signal } : {})
    });
    const urls = await deps.api.declareDerivatives(
      teamId,
      uploadId,
      {
        derivatives: made.derivatives.map(({ blob: _blob, ...declared }) => declared),
        media: made.media,
        unsupported: made.unsupported
      },
      signal
    );
    await Promise.all(
      urls.map(async target => {
        const picture = made.derivatives.find(item => item.variant === target.variant);
        if (!picture) return;
        const response = await deps.fetch(target.url, {
          method: 'PUT',
          headers: { 'Content-MD5': target.contentMd5, 'Content-Type': target.contentType },
          body: picture.blob,
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          ...(signal ? { signal } : {})
        });
        // A refused picture is simply not there at complete; the server then asks an agent.
        await response.body?.cancel().catch(() => undefined);
      })
    );
  } catch {
    // The file goes up without its pictures; the commit opens an agent job for them.
  }
}

/**
 * One part to its signed URL. A URL R2 refused (400/403: expired, or signed wrong) is re-signed
 * once; a second refusal of a part whose MD5 came from the journal means the file changed since,
 * and the upload starts again. A network failure waits and tries again, the network first.
 */
async function putPart(
  input: {
    url: string;
    md5: string;
    body: () => Promise<Blob>;
    signal?: AbortSignal;
    resign: () => Promise<string>;
    resumed: boolean;
  },
  deps: SpaceUploadDeps
): Promise<string> {
  const contentMd5 = spaceMd5HexToBase64(input.md5);
  if (!contentMd5) throw new TeamApiError('INVALID_INPUT', false);
  let url = input.url;
  let resigned = false;
  for (let failures = 0; ;) {
    let response: Response;
    try {
      response = await deps.fetch(url, {
        method: 'PUT',
        headers: { 'Content-MD5': contentMd5 },
        body: await input.body(),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        ...(input.signal ? { signal: input.signal } : {})
      });
    } catch {
      if (input.signal?.aborted) throw spaceCanceled(input.signal);
      const delay = RETRY_DELAYS_MS[failures];
      if (delay === undefined) throw new TeamApiError('STORAGE_UNAVAILABLE', true);
      failures += 1;
      await deps.online(input.signal);
      await deps.sleep(delay, input.signal);
      continue;
    }
    if (response.ok) {
      const reported = response.headers.get('ETag');
      // R2 checked the bytes against Content-MD5, so its ETag is that MD5. A missing header
      // (not exposed to the page) is read as that; a different one is not trusted.
      const etag = reported === null ? input.md5 : normalizePartEtag(reported);
      if (etag !== input.md5) throw new TeamApiError('CHECKSUM_MISMATCH', false);
      return etag;
    }
    if (response.status === 400 || response.status === 403) {
      if (!resigned) {
        resigned = true;
        url = await input.resign();
        continue;
      }
      if (input.resumed) throw new RestartFresh();
      throw new TeamApiError('STORAGE_UNAVAILABLE', false);
    }
    if (response.status >= 500 || response.status === 429 || response.status === 408) {
      const delay = RETRY_DELAYS_MS[failures];
      if (delay === undefined) throw new TeamApiError('STORAGE_UNAVAILABLE', true);
      failures += 1;
      await deps.sleep(delay, input.signal);
      continue;
    }
    throw new TeamApiError('STORAGE_UNAVAILABLE', false);
  }
}

/** Complete is idempotent on the server, so a lost answer is asked again, a few times. */
async function completeWithRetry(
  deps: SpaceUploadDeps,
  teamId: string,
  uploadId: string,
  parts: { partNumber: number; etag: string }[]
): Promise<SpaceMaterialSnapshot> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await deps.api.completeUpload(teamId, uploadId, parts);
    } catch (failure) {
      const retry =
        failure instanceof TeamApiError &&
        (failure.code === 'TEAM_TRANSPORT_UNAVAILABLE' || failure.code === 'STORAGE_UNAVAILABLE');
      if (!retry || attempt >= 3) throw failure;
    }
  }
}
