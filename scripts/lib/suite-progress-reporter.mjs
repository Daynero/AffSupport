import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Persist progress even when a worker hangs before Vitest writes its JSON
// summary. The normal console budget and verification verdict stay unchanged.
const progressPath = path.resolve('verification-progress.log');

export default class SuiteProgressReporter {
  onTestRunStart() {
    writeFileSync(progressPath, `${new Date().toISOString()} suite started\n`);
  }

  /** @param {import('vitest/node').TestModule} testModule */
  onTestModuleQueued(testModule) {
    appendFileSync(progressPath, `COLLECT ${testModule.moduleId}\n`);
  }

  /** @param {import('vitest/node').TestModule} testModule */
  onTestModuleStart(testModule) {
    appendFileSync(progressPath, `START ${testModule.moduleId}\n`);
  }

  /** @param {import('vitest/node').TestModule} testModule */
  onTestModuleEnd(testModule) {
    appendFileSync(progressPath, `END ${testModule.moduleId}\n`);
  }
}
