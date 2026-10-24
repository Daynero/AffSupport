import { open } from 'node:fs/promises';
import path from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { parseFaultRequest } from './fault-model.mjs';

// soty.acceptance.worker-checkpoint.v1 — fixture metadata, never product work.
if (!process.send || !process.connected) process.exit(2);
process.on('disconnect', () => process.exit(0));
process.once('message', async message => {
  try {
    if (
      !message ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      Object.keys(message).sort().join(',') !== 'mode,namespace,request' ||
      !['write', 'read'].includes(Reflect.get(message, 'mode'))
    )
      throw Error('INVALID');
    const parsed = parseFaultRequest(
      Reflect.get(message, 'request'),
      Reflect.get(message, 'namespace')
    );
    if (!parsed.ok || parsed.value.kind !== 'worker_crash_after_checkpoint') throw Error('INVALID');
    const request = parsed.value;
    const source = new URL('../../apps/agent/src/team-bridge/recovery-journal.ts', import.meta.url);
    const { RecoveryJournal } = await tsImport(source.href, import.meta.url);
    const journal = new RecoveryJournal(process.cwd());
    if (Reflect.get(message, 'mode') === 'write') {
      await journal.save({
        registrations: [
          {
            actorId: request.actorId,
            teamId: request.teamId,
            installationId: request.faultId,
            delegationId: request.flowId,
            endpoint: 'http://127.0.0.1:54321/functions/v1/team-recovery',
            account: `soty-recovery-${request.faultId}`
          }
        ],
        checkpoints: [
          {
            delegationId: request.flowId,
            requestId: request.faultId,
            operationId: request.operationId,
            stage: 'accepted',
            reason: null,
            updatedAt: new Date().toISOString()
          }
        ]
      });
      const file = await open(path.join(process.cwd(), 'recovery.json'), 'r');
      try {
        await file.sync();
      } finally {
        await file.close();
      }
    }
    const data = await journal.load();
    if (
      data.checkpoints.length !== 1 ||
      data.checkpoints[0].requestId !== request.faultId ||
      data.checkpoints[0].operationId !== request.operationId
    )
      throw Error('INVALID');
    process.send?.({ kind: 'checkpoint', faultId: request.faultId });
    setTimeout(() => process.exit(0), request.ttlMs + 1000).unref();
  } catch {
    process.send?.({ kind: 'refused' });
    process.exitCode = 2;
    process.disconnect?.();
  }
});
