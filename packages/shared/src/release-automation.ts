/** Operator-only contracts. Never grants production authorization. */
export type AutomationState =
  | 'accepted'
  | 'running'
  | 'waiting'
  | 'repairing'
  | 'validating'
  | 'needs_owner'
  | 'cancelling'
  | 'cancelled'
  | 'completed';

export interface AutomationPolicy {
  schemaVersion: 1;
  providerVersion: string;
  maxAttemptsPerCause: number;
  maxAttemptsPerTask: number;
  maxTokensPerAttempt: number;
  maxTokensPerTask: number;
  maxActiveMsPerAttempt: number;
  maxActiveMsPerTask: number;
  heartbeatMs: number;
  staleAfterMs: number;
  panelPort: number;
  networkEnabled: false;
  allowPaidFallback: false;
}

export interface RepairUsage {
  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningOutputTokens: number | null;
}

export interface ProviderCapability {
  schemaVersion: 1;
  executable: string;
  version: string;
  boundaryDigest: string;
  measuredAt: string;
  ready: boolean;
  checks: Record<string, boolean>;
  error: string | null;
}

export interface ReleasePanelSnapshot {
  schemaVersion: 1;
  taskId: string;
  revision: number;
  generation: number;
  version: string;
  targetId: string;
  state: AutomationState;
  runId: string;
  candidates: string[];
  progress: {
    percent: number;
    final: boolean;
    nativePercent: number | null;
    steps: { id: string; weight: number; confidence: string; status: string }[];
  };
  currentStep: string | null;
  updatedAt: string;
  workerHeartbeatAt: string | null;
  serverObservedAt?: string;
  serverEpoch?: string;
  waiting: string | null;
  nextCheckAt?: string | null;
  progressReason?: string | null;
  repair: { state: string; cause: string; executionId: string } | null;
  usage: number | null;
  attempts: number;
  blocker: { code: string; detail: string | null; requiredAction: string } | null;
  windowsUrl: string | null;
  logRef?: string | null;
}
