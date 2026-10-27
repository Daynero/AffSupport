export class LaunchPreparationError extends Error {
  constructor(readonly reason: 'canceled' | 'timeout') {
    super(reason);
  }
}

export interface LaunchCatalogPreparationClient {
  getProductCatalogSettings(teamId: string): Promise<{
    title: string | null;
    description: string | null;
    imageLink: string | null;
  } | null>;
  listProductCatalogTexts(teamId: string): Promise<readonly unknown[]>;
  listProductCatalogImageSources(teamId: string): Promise<{ poolSize: number }>;
  catalogImages: {
    capabilities(teamId: string): Promise<{ mode: 'legacy' | 'v2' }>;
    inventory(teamId: string): Promise<{ total: number; unclassified: number }>;
  };
}

/** Use the same admitted image source as the generator, including paused imports. */
export async function isLaunchCatalogReady(
  client: LaunchCatalogPreparationClient,
  teamId: string
): Promise<boolean> {
  const [settings, texts, capabilities] = await Promise.all([
    client.getProductCatalogSettings(teamId),
    client.listProductCatalogTexts(teamId),
    client.catalogImages.capabilities(teamId)
  ]);
  if (!settings) return false;
  const hasTexts = texts.length > 0 || Boolean(settings.title && settings.description);
  if (capabilities.mode === 'v2') {
    const inventory = await client.catalogImages.inventory(teamId);
    // Every selected matched picture can supply factual canonical text. Random
    // pictures still require the user's generic text pool or fallback values.
    return inventory.total > 0 && (hasTexts || inventory.unclassified === 0);
  }
  const images = await client.listProductCatalogImageSources(teamId);
  return hasTexts && (images.poolSize > 0 || Boolean(settings.imageLink));
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
