import { stageSparkle } from './lib/native-update-sdk.mjs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BETA_PROFILE } from '../packages/shared/dist/environment.js';
import { renderNativeUpdatePolicy } from './lib/native-update-policy.mjs';
const [app, generatedPolicy, arch] = process.argv.slice(2);
if (!app?.endsWith('.app') || !generatedPolicy || !['arm64', 'x64'].includes(arch ?? ''))
  throw new Error('NATIVE_UPDATE_STAGE_ARGUMENTS');
await stageSparkle(app);
await writeFile(
  generatedPolicy,
  renderNativeUpdatePolicy(arch, path.basename(app, '.app') === BETA_PROFILE.appName)
);
