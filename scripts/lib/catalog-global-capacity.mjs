/** Wait only for a definite staging-capacity refusal, outside all catalog paths.
 * Unknown outcomes must be reconciled with the same durable grant key.
 * @template T
 * @param {(timeoutMs:number)=>Promise<T>} operation
 * @param {{sleep?:(ms:number)=>Promise<void>,now?:()=>number}} [deps]
 * @returns {Promise<T>}
 */
export async function withCatalogGlobalCapacity(operation, deps = {}) {
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => performance.now());
  const deadline = now() + 60_000;
  let lastBusy = new Error('IMAGE_UPLOAD_CAPACITY_BUSY');
  for (let attempt = 0; attempt < 30; attempt++) {
    const remaining = deadline - now();
    if (remaining <= 0) throw lastBusy;
    try {
      return await operation(Math.min(15_000, Math.max(1, Math.floor(remaining))));
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'IMAGE_UPLOAD_CAPACITY_BUSY') throw error;
      lastBusy = error;
      const left = deadline - now();
      if (left <= 0 || attempt === 29) throw lastBusy;
      await sleep(Math.min(2000, 250 * 2 ** Math.min(attempt, 3), left));
    }
  }
  throw lastBusy;
}
