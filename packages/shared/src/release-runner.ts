/**
 * Public, serializable boundary types for the unattended release runner.
 * These are deliberately data-only: command execution and credentials never
 * cross this boundary.
 */
export const RELEASE_RUNNER_SCHEMA_VERSION = 1 as const;

export const RELEASE_RUN_STATES = [
  'draft',
  'preflight',
  'queued',
  'running',
  'waiting_resource',
  'waiting_remote',
  'reconciling',
  'blocked',
  'cancelling',
  'cancelled',
  'completed'
] as const;
export type ReleaseRunState = (typeof RELEASE_RUN_STATES)[number];

export type ReleaseTargetKind = 'production' | 'sandbox';
export type ReleaseRunnerPlatform = 'macos-arm64' | 'windows-x64';

export interface ReleaseIntent {
  schemaVersion: typeof RELEASE_RUNNER_SCHEMA_VERSION;
  runId: string;
  repository: string;
  sourceSha: string;
  version?: string;
  bump?: 'patch' | 'minor' | 'major';
  notes: { digest: string } | { commitRange: string };
  targetId: string;
  targetKind: ReleaseTargetKind;
  platforms: ReleaseRunnerPlatform[];
  resourceProfile: Readonly<Record<string, number | string | boolean>>;
  createdAt: string;
  deadlineAt?: string;
  backendPlanDigest?: string;
}

export interface ReleaseEffect {
  schemaVersion: typeof RELEASE_RUNNER_SCHEMA_VERSION;
  id: string;
  kind: string;
  targetId: string;
  correlation: string;
  requestDigest: string;
  state: 'prepared' | 'observed' | 'unknown' | 'matching' | 'conflicting';
  observedAt?: string;
}

export interface ReleaseEvidence {
  schemaVersion: typeof RELEASE_RUNNER_SCHEMA_VERSION;
  id: string;
  stepId: string;
  inputDigest: string;
  sourceSha: string;
  runnerRevision: string;
  publicConfigDigest: string;
  toolDigests: Readonly<Record<string, string>>;
  artifactDigests: Readonly<Record<string, string>>;
  observedAt: string;
}

export interface ReleaseResourceLease {
  schemaVersion: typeof RELEASE_RUNNER_SCHEMA_VERSION;
  leaseId: string;
  runId: string;
  generation: number;
  stepId: string;
  state: 'waiting' | 'granted' | 'uncertain' | 'released';
  grantedAt?: string;
}

export interface ReleaseRunSnapshot {
  schemaVersion: typeof RELEASE_RUNNER_SCHEMA_VERSION;
  runId: string;
  intentDigest: string;
  sourceSha: string;
  state: ReleaseRunState;
  currentStep: string | null;
  generation: number;
  publicationState: 'none' | 'partial' | 'complete';
  updatedAt: string;
}
