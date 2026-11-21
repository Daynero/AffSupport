/**
 * One way to ask a Claude model for structured JSON from an edge function (063).
 *
 * Pure: no `npm:` import, so vitest loads it in Node. The SDK lives behind `ClaudeClient` in
 * `claude-sdk.ts`, which only an `index.ts` imports. Every attempt — finished, refused or failed —
 * is handed to `record`, so the cost ledger sees what was billed even when nothing came back.
 *
 * The next feature that needs a model reuses this file and `ai-allowance.ts`; nothing here knows
 * about translation.
 */

export type ClaudeModel = 'claude-haiku-5-5' | 'claude-sonnet-5-5';
export type ClaudeEffort = 'low' | 'medium' | 'high';

export interface ClaudeRequest {
  model: ClaudeModel;
  effort: ClaudeEffort;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
}

export interface ClaudeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** What an adapter returns for one call that reached the model. */
export interface ClaudeRawResult {
  stopReason: string | null;
  /** Concatenated text blocks, or null when there were none. */
  text: string | null;
  usage: ClaudeUsage;
}

/** Thrown by an adapter when the call never produced a model response. */
export class ClaudeTransportError extends Error {
  readonly status: number | null;
  constructor(status: number | null, message = 'CLAUDE_TRANSPORT') {
    super(message);
    this.name = 'ClaudeTransportError';
    this.status = status;
  }
}

export interface ClaudeClient {
  create(request: ClaudeRequest, signal: AbortSignal): Promise<ClaudeRawResult>;
}

export type StructuredFailure = 'refused' | 'unavailable' | 'invalid_output' | 'truncated';

export type StructuredOutcome =
  | {
      ok: true;
      value: unknown;
      model: ClaudeModel;
      usage: ClaudeUsage;
      costMicroUsd: number;
      durationMs: number;
    }
  | {
      ok: false;
      reason: StructuredFailure;
      model: ClaudeModel;
      usage: ClaudeUsage;
      costMicroUsd: number;
      durationMs: number;
      stopReason: string | null;
      httpStatus: number | null;
    };

export interface UsageRecord {
  model: ClaudeModel;
  outcome: 'completed' | 'refused' | 'failed';
  /** False when the call left without usage figures (transport failure): unknown, not zero. */
  usageKnown?: boolean;
  stopReason: string | null;
  usage: ClaudeUsage;
  costMicroUsd: number;
  durationMs: number;
}

/** USD per million tokens, i.e. micro-USD per token. Official price list, 2026-11-21. */
const PRICES: Readonly<
  Record<ClaudeModel, { input: number; output: number; cacheRead: number; cacheWrite: number }>
> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }
};

/** Per-token prices in micro-USD (USD per million tokens) for one model. */
export function modelPrice(model: ClaudeModel): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} {
  return PRICES[model];
}

const NO_USAGE: ClaudeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Rounded up to a whole micro-dollar per call, so many small calls never sum to zero. */
export function costMicroUsd(model: ClaudeModel, usage: ClaudeUsage): number {
  const price = PRICES[model];
  const exact =
    usage.input * price.input +
    usage.output * price.output +
    usage.cacheRead * price.cacheRead +
    usage.cacheWrite * price.cacheWrite;
  return Math.ceil(exact);
}

/** Strips a ```json fence a model may still put around the object. */
function parseJsonText(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/u, '')
    .replace(/\s*```$/u, '');
  return JSON.parse(trimmed);
}

export async function callStructured(
  client: ClaudeClient,
  request: ClaudeRequest,
  options: {
    signal: AbortSignal;
    record: (entry: UsageRecord) => Promise<void> | void;
    now?: () => number;
  }
): Promise<StructuredOutcome> {
  const now = options.now ?? Date.now;
  const started = now();
  let raw: ClaudeRawResult;
  try {
    raw = await client.create(request, options.signal);
  } catch (error) {
    const durationMs = Math.max(0, now() - started);
    const httpStatus = error instanceof ClaudeTransportError ? error.status : null;
    await options.record({
      model: request.model,
      outcome: 'failed',
      usageKnown: false,
      stopReason: null,
      usage: NO_USAGE,
      costMicroUsd: 0,
      durationMs
    });
    return {
      ok: false,
      reason: 'unavailable',
      model: request.model,
      usage: NO_USAGE,
      costMicroUsd: 0,
      durationMs,
      stopReason: null,
      httpStatus
    };
  }
  const durationMs = Math.max(0, now() - started);
  const cost = costMicroUsd(request.model, raw.usage);
  const fail = async (reason: StructuredFailure): Promise<StructuredOutcome> => {
    await options.record({
      model: request.model,
      outcome: reason === 'refused' ? 'refused' : 'failed',
      stopReason: raw.stopReason,
      usage: raw.usage,
      costMicroUsd: cost,
      durationMs
    });
    return {
      ok: false,
      reason,
      model: request.model,
      usage: raw.usage,
      costMicroUsd: cost,
      durationMs,
      stopReason: raw.stopReason,
      httpStatus: null
    };
  };
  if (raw.stopReason === 'refusal') return fail('refused');
  if (raw.stopReason === 'max_tokens') return fail('truncated');
  if (!raw.text) return fail('invalid_output');
  let value: unknown;
  try {
    value = parseJsonText(raw.text);
  } catch {
    return fail('invalid_output');
  }
  await options.record({
    model: request.model,
    outcome: 'completed',
    stopReason: raw.stopReason,
    usage: raw.usage,
    costMicroUsd: cost,
    durationMs
  });
  return {
    ok: true,
    value,
    model: request.model,
    usage: raw.usage,
    costMicroUsd: cost,
    durationMs
  };
}
