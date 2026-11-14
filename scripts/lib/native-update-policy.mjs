import {
  RELEASE_ARTIFACT_ORIGIN,
  RELEASE_ARTIFACT_PATH_PREFIX,
  NATIVE_UPDATE_CODES,
  NATIVE_UPDATE_LIMITS
} from '../../packages/shared/dist/index.js';
import { BETA_PROFILE } from '../../packages/shared/dist/environment.js';

/** Production and dev compile no fixture identity; beta uses the shared authority. */
export function renderNativeUpdatePolicy(arch, fixture = false) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('NATIVE_UPDATE_STAGE_ARGUMENTS');
  return `// Generated from the shared release authority; do not edit.
import Foundation
enum NativeUpdateBuildPolicy {
  static let frameBytes = ${NATIVE_UPDATE_LIMITS.frameBytes}
  static let canonicalPayloadBytes = ${NATIVE_UPDATE_LIMITS.canonicalPayloadBytes}
  static let historyEntries = ${NATIVE_UPDATE_LIMITS.historyEntries}
  static let archiveBytes: Int64 = ${NATIVE_UPDATE_LIMITS.archiveBytes}
  static let readinessSeconds: Double = ${NATIVE_UPDATE_LIMITS.readinessTimeoutMs / 1000}
  static let downloadTimeoutMs: Double = ${NATIVE_UPDATE_LIMITS.downloadTimeoutMs}
  static let maximumPreparationTimeoutMs: Double = ${NATIVE_UPDATE_LIMITS.maximumPreparationTimeoutMs}
  static let target = ${JSON.stringify(`macos-${arch}`)}
  static let artifactPrefix = ${JSON.stringify(RELEASE_ARTIFACT_ORIGIN + RELEASE_ARTIFACT_PATH_PREFIX.replace(/\/$/u, ''))}
  static let failureCodes: Set<String> = [${NATIVE_UPDATE_CODES.map(code => JSON.stringify(code)).join(', ')}]
  static let fixtureBundleId: String? = ${fixture ? JSON.stringify(BETA_PROFILE.bundleId) : 'nil'}
  static let fixtureSupportDirectory: String? = ${fixture ? JSON.stringify(BETA_PROFILE.supportDirectoryName) : 'nil'}
}
`;
}
