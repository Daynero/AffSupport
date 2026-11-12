import {
  RELEASE_ARTIFACT_ORIGIN,
  RELEASE_ARTIFACT_PATH_PREFIX
} from '../../packages/shared/src/release';
import type {
  NativeUpdateDescriptor,
  NativeUpdateSnapshot
} from '../../packages/shared/src/native-app-updates';
export function nativeCandidate(): NativeUpdateDescriptor {
  return {
    schemaVersion: 1,
    channel: 'stable',
    target: 'macos-arm64',
    version: '9.0.0',
    buildNumber: '999',
    buildId: '9.0.0+999',
    sourceRevision: 'a'.repeat(40),
    publisherTeamId: 'TESTTEAM12',
    minimumSystemVersion: '13.0',
    archive: {
      url: `${RELEASE_ARTIFACT_ORIGIN}${RELEASE_ARTIFACT_PATH_PREFIX}v9.0.0/Soty-v9.0.0-macOS-arm64.zip`,
      length: 5,
      sha256: 'a'.repeat(64),
      edSignature: Buffer.alloc(64).toString('base64')
    }
  };
}
export function nativeSnapshot(): NativeUpdateSnapshot {
  const candidate = nativeCandidate();
  return {
    schemaVersion: 1,
    installationId: '10000000-0000-4000-8000-000000000001',
    operationId: '10000000-0000-4000-8000-000000000002',
    attemptId: '10000000-0000-4000-8000-000000000003',
    candidateId: `${candidate.target}:${candidate.archive.sha256}`,
    candidate,
    revision: 1,
    stage: 'prepared',
    lastProvenStage: 'prepared',
    code: null,
    downloadedBytes: 5,
    totalBytes: 5,
    nativeSuccess: false,
    uiSuccess: false,
    availableActions: ['accept', 'defer', 'cancel'],
    automaticDownload: true
  };
}
