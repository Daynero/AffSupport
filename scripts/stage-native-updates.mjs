import { stageSparkle } from './lib/native-update-sdk.mjs';
import { writeFile } from 'node:fs/promises';
import {
  RELEASE_ARTIFACT_ORIGIN,
  RELEASE_ARTIFACT_PATH_PREFIX,
  NATIVE_UPDATE_CODES,
  NATIVE_UPDATE_LIMITS
} from '../packages/shared/dist/index.js';
const [app, generatedPolicy, arch] = process.argv.slice(2);
if (!app?.endsWith('.app') || !generatedPolicy || !['arm64', 'x64'].includes(arch ?? ''))
  throw new Error('NATIVE_UPDATE_STAGE_ARGUMENTS');
await stageSparkle(app);
await writeFile(
  generatedPolicy,
  `// Generated from the shared release authority; do not edit.\nimport Foundation\nenum NativeUpdateBuildPolicy {\n  static let frameBytes = ${NATIVE_UPDATE_LIMITS.frameBytes}\n  static let canonicalPayloadBytes = ${NATIVE_UPDATE_LIMITS.canonicalPayloadBytes}\n  static let historyEntries = ${NATIVE_UPDATE_LIMITS.historyEntries}\n  static let archiveBytes: Int64 = ${NATIVE_UPDATE_LIMITS.archiveBytes}\n  static let readinessSeconds: Double = ${NATIVE_UPDATE_LIMITS.readinessTimeoutMs / 1000}\n  static let downloadTimeoutMs: Double = ${NATIVE_UPDATE_LIMITS.downloadTimeoutMs}\n  static let maximumPreparationTimeoutMs: Double = ${NATIVE_UPDATE_LIMITS.maximumPreparationTimeoutMs}\n  static let target = ${JSON.stringify(`macos-${arch}`)}\n  static let artifactPrefix = ${JSON.stringify(RELEASE_ARTIFACT_ORIGIN + RELEASE_ARTIFACT_PATH_PREFIX.replace(/\/$/u, ''))}\n  static let failureCodes: Set<String> = [${NATIVE_UPDATE_CODES.map(code => JSON.stringify(code)).join(', ')}]\n}\n`
);
