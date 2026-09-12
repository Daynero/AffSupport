import type { ReleaseIntent } from '../../../packages/shared/src/release-runner';

export function fixtureClock(start = '2026-09-09T00:00:00.000Z') {
  let now = new Date(start).getTime();
  return { now: () => new Date(now).toISOString(), advance: (ms: number) => (now += ms) };
}

export function recordingEffects() {
  const calls: Array<{ kind: string; targetId: string }> = [];
  return { calls, execute: (kind: string, targetId: string) => calls.push({ kind, targetId }) };
}

export const sandboxIntent: ReleaseIntent = {
  schemaVersion: 1,
  runId: '11111111-1111-4111-8111-111111111111',
  repository: 'example/soty-sandbox',
  sourceSha: 'a'.repeat(40),
  version: '1.1.1',
  notes: { digest: 'b'.repeat(64) },
  targetId: 'sandbox-local',
  targetKind: 'sandbox',
  platforms: ['macos-arm64', 'windows-x64'],
  resourceProfile: { maxHeavy: 1 },
  createdAt: '2026-09-09T00:00:00.000Z'
};
