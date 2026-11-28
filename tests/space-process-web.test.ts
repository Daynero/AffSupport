// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../apps/web/src/lib/config', async importOriginal => {
  const actual = await importOriginal<typeof import('../apps/web/src/lib/config')>();
  return {
    ...actual,
    publicConfig: {
      ok: true,
      value: { supabaseUrl: 'https://project.supabase.co', supabaseAnonKey: 'anon' }
    }
  };
});

const { startTeamAgentProcess } = await import('../apps/web/src/api/client');
const { rememberSpaceRun } = await import('../apps/web/src/api/space-operations');

/**
 * 057 T035 — the web hands the agent the space-storage endpoints for a run opened in an R2
 * space, and only an agent of team workspace contract 3 gets one. A Drive run is sent exactly
 * as before.
 */

const SPACE_RUN = '05735000-0000-4000-8000-0000000000c1';
const DRIVE_RUN = '05735000-0000-4000-8000-0000000000c2';
const grant = (purpose: 'process_input' | 'finalize') => ({
  ticket: 't'.repeat(43),
  purpose,
  expiresAt: '2099-01-01T00:00:00.000Z',
  maxRangeBytes: 32 * 1024 * 1024,
  maxUses: 8
});
const request = (operationId: string) => ({
  operationId,
  toolId: 'compressor',
  options: {},
  sourceGrant: grant('process_input'),
  finalizeGrant: grant('finalize')
});

function agent(teamWorkspace: number) {
  const calls: { url: string; body: Record<string, unknown> | null }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith('/api/health'))
        return new Response(
          JSON.stringify({ toolContracts: { teamWorkspace, compressor: 3, imageEmbedding: 2 } })
        );
      return new Response(
        JSON.stringify({
          operationId: calls.at(-1)!.body!.operationId,
          state: 'succeeded',
          materialId: null,
          reused: false
        })
      );
    })
  );
  return calls;
}

beforeEach(() => {
  localStorage.setItem('agentToken', 'a'.repeat(64));
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('startTeamAgentProcess in an R2 space (057 T035)', () => {
  it('hands the agent the space-storage endpoints', async () => {
    rememberSpaceRun(SPACE_RUN);
    const calls = agent(3);
    await startTeamAgentProcess(request(SPACE_RUN));
    const sent = calls.find(call => call.url.endsWith('/api/team/process'))!.body!;
    expect(sent.transferUrl).toBe(
      'https://project.supabase.co/functions/v1/space-storage/agent/source'
    );
    expect(sent.cloudBaseUrl).toBe('https://project.supabase.co/functions/v1/space-storage');
  });

  it('asks an older agent to update instead of handing it an R2 run', async () => {
    rememberSpaceRun(SPACE_RUN);
    const calls = agent(2);
    await expect(startTeamAgentProcess(request(SPACE_RUN))).rejects.toThrow(
      'AGENT_UPDATE_REQUIRED'
    );
    expect(calls.some(call => call.url.endsWith('/api/team/process'))).toBe(false);
  });

  it('sends a Drive run to drive-transfer and drive-ops as before, to a contract-2 agent', async () => {
    const calls = agent(2);
    await startTeamAgentProcess(request(DRIVE_RUN));
    const sent = calls.find(call => call.url.endsWith('/api/team/process'))!.body!;
    expect(sent.transferUrl).toBe('https://project.supabase.co/functions/v1/drive-transfer/range');
    expect(sent.cloudBaseUrl).toBe('https://project.supabase.co/functions/v1/drive-ops');
  });
});
