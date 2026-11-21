/**
 * A stand-in for Claude on the beta stack (063), so the translation UI, the allowance and every
 * failure state can be checked without an API key. Deterministic: each line becomes
 * "[target] line", after a short pause per chunk so the progress bar has something to show.
 *
 *   fake         — translates
 *   fake-refuse  — every call is declined (stop_reason "refusal")
 *   fake-down    — every call fails before reaching a model
 */
import { ClaudeTransportError, type ClaudeClient, type ClaudeRequest } from '../_shared/claude.ts';

export type FakeMode = 'fake' | 'fake-refuse' | 'fake-down';

export function isFakeMode(value: string | undefined): value is FakeMode {
  return value === 'fake' || value === 'fake-refuse' || value === 'fake-down';
}

function requestedLines(user: string): string[] {
  const range = /Translate lines (\d+)–(\d+)/u.exec(user);
  if (!range) return [];
  const from = Number(range[1]);
  const to = Number(range[2]);
  const lines = new Map<number, string>();
  for (const match of user.matchAll(/^(\d+)\. (.*)$/gmu))
    lines.set(Number(match[1]), match[2] ?? '');
  const out: string[] = [];
  for (let index = from; index <= to; index += 1) out.push(lines.get(index) ?? '');
  return out;
}

function targetOf(system: string): string {
  return /\(([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\)/u.exec(system)?.[1] ?? 'xx';
}

export function createFakeClient(mode: FakeMode, delayMs = 3_500): ClaudeClient {
  return {
    async create(request: ClaudeRequest, signal: AbortSignal) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new ClaudeTransportError(null, 'aborted'));
          },
          { once: true }
        );
      });
      if (mode === 'fake-down') throw new ClaudeTransportError(503);
      const usage = { input: request.user.length, output: 40, cacheRead: 0, cacheWrite: 0 };
      if (mode === 'fake-refuse') return { stopReason: 'refusal', text: null, usage };
      const target = targetOf(request.system);
      const translations = requestedLines(request.user).map(line => `[${target}] ${line}`);
      return { stopReason: 'end_turn', text: JSON.stringify({ translations }), usage };
    }
  };
}
