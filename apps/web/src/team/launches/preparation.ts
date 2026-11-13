export class LaunchPreparationError extends Error {
  constructor(readonly reason: 'canceled' | 'timeout') {
    super(reason);
  }
}

export interface LaunchCatalogPreparationClient {
  getProductCatalogSettings?(teamId: string): Promise<{
    title: string | null;
    description: string | null;
    imageLink: string | null;
  } | null>;
  listProductCatalogTexts?(teamId: string): Promise<readonly unknown[]>;
  listProductCatalogImageSources?(teamId: string): Promise<{ poolSize: number }>;
  catalogImages: {
    globalReadiness?: (teamId: string) => Promise<{ state: string; usable: boolean }>;
    capabilities(teamId: string): Promise<{ mode: 'legacy' | 'v2' }>;
    inventory(teamId: string): Promise<{ total: number; unclassified: number }>;
  };
}

/** Use the same admitted image source as the generator, including paused imports. */
export async function isLaunchCatalogReady(
  client: LaunchCatalogPreparationClient,
  teamId: string
): Promise<boolean> {
  if (client.catalogImages.globalReadiness) {
    const policy = await client.catalogImages.globalReadiness(teamId);
    if (policy.state !== 'prepared') return policy.usable;
  }
  const capabilities = await client.catalogImages.capabilities(teamId);
  if (capabilities.mode === 'v2') {
    const inventory = await client.catalogImages.inventory(teamId);
    return inventory.total > 0;
  }
  // Legacy source/fallback eligibility is checked by the authoritative generator.
  // Browser admission never depends on retired price/text settings.
  return true;
}

/** Only read-only preflight work belongs here. A late read must never start generation. */
export async function readLaunchPreparation<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void read.catch(() => {});
    throw new LaunchPreparationError('canceled');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  try {
    const value = await Promise.race([
      read,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new LaunchPreparationError('canceled'));
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(new LaunchPreparationError('timeout')), 15_000);
      })
    ]);
    if (signal.aborted) throw new LaunchPreparationError('canceled');
    return value;
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
