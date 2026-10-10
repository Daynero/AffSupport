import { LINK_DURATION_MAX_MS, type AnalyticsTool, type ReadinessStage } from './events';
import { safeErrorCode } from './errors';
import { analytics, type ProductAnalytics } from './service';

/**
 * 031 FR-051 — `tool_ready`: the tool page finished its first read of the local app's state
 * (or gave up on it) after `tool_opened`. Emitted once per transition into `connected`, so a
 * page that never becomes usable is a visible finding rather than silence.
 */
export function trackToolReady(
  input: {
    tool: AnalyticsTool;
    outcome: 'success' | 'failure' | 'skipped';
    durationMs: number;
    stage?: ReadinessStage;
    errorCode?: string;
  },
  tracker: Pick<ProductAnalytics, 'track'> = analytics
): void {
  const duration = Number.isFinite(input.durationMs) ? Math.round(input.durationMs) : 0;
  tracker.track('tool_ready', {
    tool_identifier: input.tool,
    outcome: input.outcome,
    duration_ms: Math.min(LINK_DURATION_MAX_MS, Math.max(0, duration)),
    ...(input.stage ? { error_stage: input.stage } : {}),
    ...(input.errorCode !== undefined ? { error_code: safeErrorCode(input.errorCode) } : {})
  });
}
