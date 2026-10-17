import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Persist progress even when a worker hangs before Vitest writes its JSON
// summary. The normal console budget and verification verdict stay unchanged.
const progressPath = path.resolve('verification-progress.log');
const record = (stage, moduleId) =>
  appendFileSync(progressPath, `${new Date().toISOString()} ${stage} ${moduleId}\n`);

export default class SuiteProgressReporter {
  onTestRunStart() {
    const shard = process.env.SOTY_VERIFY_SHARD;
    const header = `${new Date().toISOString()} suite started${shard ? ` shard ${shard}` : ''}\n`;
    if (shard && !shard.startsWith('1/')) appendFileSync(progressPath, header);
    else writeFileSync(progressPath, header);
  }

  /** @param {import('vitest/node').TestModule} testModule */
  onTestModuleQueued(testModule) {
    record('COLLECT', testModule.moduleId);
  }

  /** @param {import('vitest/node').TestModule} testModule */
  onTestModuleStart(testModule) {
    record('START', testModule.moduleId);
  }

  /** @param {import('vitest/node').TestModule} testModule */
  onTestModuleEnd(testModule) {
    record('END', testModule.moduleId);
  }
}
