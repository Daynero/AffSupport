import type { TeamProcessBridge, TeamProcessRequest } from './process.js';
import type { CatalogVariantChild } from './catalog-variant-executor.js';
/** Trusted recovery adapter supplies a fresh original-child grant only when that
 * child's durable authority permits execution. It is never an HTTP request body. */
export function catalogVariantProcessAdapter(input: {
  bridge: Pick<TeamProcessBridge, 'process' | 'cancel'>;
  authorizeExecution: (
    child: Readonly<CatalogVariantChild>,
    signal: AbortSignal
  ) => Promise<boolean>;
  claim: (child: Readonly<CatalogVariantChild>, signal: AbortSignal) => Promise<TeamProcessRequest>;
}) {
  return async (child: Readonly<CatalogVariantChild>, signal: AbortSignal) => {
    const current = () => {
      if (signal.aborted) throw new Error('PROCESS_CANCELED');
    };
    current();
    const request = await input.claim(child, signal);
    current();
    // The persisted child binds the server-issued process identity. Substituting a
    // newly generated operation here would defeat upload/readback idempotency.
    if (
      child.operationId === null ||
      request.operationId !== child.operationId ||
      request.toolId !== 'restitch'
    )
      throw new Error('PROCESS_RESULT_UNCERTAIN');
    if (!(await input.authorizeExecution(child, signal)))
      throw new Error('PROCESS_RESULT_UNCERTAIN');
    current();
    const cancel = () => {
      input.bridge.cancel(child.operationId!);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      current();
      const completion = input.bridge.process(request);
      if (signal.aborted) cancel();
      const result = await completion;
      if (
        result.operationId !== child.operationId ||
        result.state !== 'succeeded' ||
        !result.materialId
      )
        throw new Error('PROCESS_RESULT_UNCERTAIN');
      // A registered result wins a simultaneous cancellation; the parent saves
      // that durable receipt before it refrains from starting another child.
      return { outputId: result.materialId };
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  };
}
