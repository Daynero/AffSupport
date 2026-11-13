/** Read-only HTTP observations of explicitly owned isolated retirement fixtures.
 * A public404 never proves origin deletion or quota settlement; those remain separate receipts.
 */
export async function probeCatalogGlobalRetirement(
  manifest,
  { phase, fetcher = fetch, now = Date.now() }
) {
  const fixture = manifest.retirement;
  const deadline = Date.parse(fixture?.deleteAfter ?? '');
  if (
    !['retirement-before', 'retirement-after'].includes(phase) ||
    !Number.isFinite(deadline) ||
    !Array.isArray(fixture?.managed) ||
    fixture.managed.length < 1 ||
    fixture.managed.length > 10 ||
    !Array.isArray(fixture?.protected) ||
    fixture.protected.length < 1 ||
    fixture.protected.length > 10 ||
    (phase === 'retirement-before' ? now >= deadline : now < deadline)
  )
    throw new Error('Owned retirement phase/deadline fixture is invalid');
  const protectedOrigins = [manifest.origin, ...(fixture.protectedOrigins ?? [])];
  if (
    protectedOrigins.length > 5 ||
    protectedOrigins.some(raw => {
      const origin = new URL(raw);
      return (
        origin.protocol !== 'https:' || origin.origin !== raw || origin.username || origin.password
      );
    })
  )
    throw new Error('Protected fixtures require explicitly owned HTTPS origins');
  const checks = [];
  for (const [kind, images] of [
    ['managed', fixture.managed],
    ['protected', fixture.protected]
  ]) {
    for (const image of images) {
      const url = new URL(image.url);
      if (
        (kind === 'managed'
          ? url.origin !== manifest.origin
          : !protectedOrigins.includes(url.origin)) ||
        url.search ||
        url.hash ||
        !/^[0-9a-f-]{36}$/u.test(image.id) ||
        (kind === 'managed' && !/^\/v1\/[0-9a-f-]{36}$/u.test(url.pathname)) ||
        (kind === 'protected' && !/^\/[A-Za-z0-9._/-]{1,512}$/u.test(url.pathname))
      )
        throw new Error('Foreign or invalid retirement fixture');
      const response = await fetcher(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(15_000)
      });
      if (kind === 'managed' && phase === 'retirement-after') {
        await response.body?.cancel();
        if (![404, 410].includes(response.status))
          throw new Error('Retired managed bytes are still public or unknown');
      } else {
        if (
          response.status !== 200 ||
          !response.body ||
          !/^[0-9a-f]{64}$/u.test(image.sha256 ?? '') ||
          !Number.isSafeInteger(image.size) ||
          image.size < 1 ||
          image.size > 8_000_000
        )
          throw new Error('Preserved fixture is not readable');
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > image.size) {
              await reader.cancel();
              throw new Error('Fixture exceeds declared bound');
            }
            chunks.push(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const digest = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
        if (size !== image.size || digest !== image.sha256)
          throw new Error('Protected fixture bytes changed');
      }
      checks.push({ kind, image_id: image.id, status: response.status });
    }
  }
  return {
    phase,
    delete_after: new Date(deadline).toISOString(),
    http: 'verified',
    checks,
    origin_delete_receipt: 'unverified',
    cdn_purge_receipt: 'unverified',
    quota_settlement: 'unverified',
    acceptance: 'blocked'
  };
}
