import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  permissionOverrides,
  normalizeUsage,
  validateAutomationPolicy,
  CodexProvider,
  allowReadCommand
} from '../scripts/lib/release/codex-provider.mjs';
import policy from '../config/release-automation-policy.json';

describe('release repair provider boundary', () => {
  it('allows only bounded native reads, not compound commands, secrets or symlinks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'repair-read-'));
    await writeFile(path.join(root, 'source.ts'), 'safe');
    await writeFile(path.join(root, '.env'), 'synthetic');
    await symlink('/etc/passwd', path.join(root, 'escape'));
    const request = (command: string) => ({ command, cwd: root });
    expect(await allowReadCommand(request("/bin/zsh -c '/bin/cat source.ts'"), root)).toBe(true);
    for (const command of [
      'npm run build',
      'node script.mjs',
      'cat source.ts; npm test',
      'cat .env',
      'cat escape',
      'cat /etc/passwd',
      'cat -',
      'cat source.ts > output'
    ]) {
      expect(await allowReadCommand(request(command), root)).toBe(false);
    }
    expect(
      await allowReadCommand({ ...request('cat source.ts'), additionalPermissions: {} }, root)
    ).toBe(false);
  });
  it('rejects paid fallback and networking', () => {
    expect(validateAutomationPolicy(policy)).toEqual(policy);
    expect(() => validateAutomationPolicy({ ...policy, allowPaidFallback: true })).toThrow();
    expect(() => validateAutomationPolicy({ ...policy, networkEnabled: true })).toThrow();
    expect(() => validateAutomationPolicy({ ...policy, maxAttemptsPerTask: 0 })).toThrow();
  });

  it('uses a named read/write boundary, never legacy broad sandbox', () => {
    const args = permissionOverrides('/private/tmp/repair', ['/private/tmp/secret']);
    expect(args.join(' ')).toContain('default_permissions="soty_repair"');
    expect(args.join(' ')).toContain('":root" = "deny"');
    expect(args.join(' ')).toContain('network.enabled=false');
    expect(args.join(' ')).not.toContain('sandbox_mode');
    expect(args.join(' ')).not.toContain('danger-full-access');
  });

  it('preserves unknown usage and normalizes cumulative totals without summing', () => {
    expect(normalizeUsage(null).totalTokens).toBeNull();
    const total = {
      totalTokens: 20,
      inputTokens: 15,
      outputTokens: 5,
      cachedInputTokens: 10,
      reasoningOutputTokens: 2
    };
    expect(normalizeUsage({ total })).toEqual(total);
    expect(normalizeUsage({ total: { totalTokens: -1 } }).totalTokens).toBeNull();
  });
});

function fixture(timeoutMs = 100) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      child.emit('exit', 0);
      return true;
    })
  });
  const sent: Record<string, unknown>[] = [];
  child.stdin.on('data', chunk => sent.push(JSON.parse(chunk.toString())));
  const spawnProcess = vi.fn(() => child);
  const provider = new CodexProvider({
    executable: '/usr/bin/codex',
    checkout: '/private/tmp/repair',
    timeoutMs,
    inspectVersion: async () => policy.providerVersion,
    spawnProcess: spawnProcess as unknown as typeof spawn
  });
  return { child, sent, provider, spawnProcess };
}

describe('stdio protocol lifecycle', () => {
  it('handles fragmented responses and never starts a turn during health', async () => {
    const { child, provider, sent } = fixture();
    const health = provider.health();
    await vi.waitFor(() => expect(sent[0]?.method).toBe('initialize'));
    child.stdout.write('{"id":1,"res');
    child.stdout.write('ult":{}}\n');
    await Promise.resolve();
    child.stdout.write('{"id":2,"result":{"account":{"type":"chatgpt"}}}\n');
    expect(await health).toEqual({ ready: true, managedAuth: true });
    expect(sent.map(m => m.method)).toEqual(['initialize', 'initialized', 'account/read']);
    provider.close();
  });

  it('rejects API-key auth without fallback', async () => {
    const { child, provider, sent } = fixture();
    const health = provider.health();
    await vi.waitFor(() => expect(sent[0]?.method).toBe('initialize'));
    child.stdout.write('{"id":1,"result":{}}\n');
    await Promise.resolve();
    child.stdout.write('{"id":2,"result":{"account":{"type":"apiKey"}}}\n');
    await expect(health).rejects.toThrow('MANAGED_CHATGPT_AUTH_REQUIRED');
    provider.close();
  });

  it('denies unsolicited approval/tool requests', () => {
    const { child, provider, sent } = fixture();
    child.stdout.write(
      '{"id":"approval","method":"item/permissions/requestApproval","params":{}}\n'
    );
    expect(sent[0]).toMatchObject({ id: 'approval', error: { code: -32601 } });
    provider.close();
  });

  it('interrupts only explicit thread and turn IDs', async () => {
    const { child, provider, sent } = fixture();
    const result = provider.interrupt('thread-1', 'turn-2');
    expect(sent[0]).toMatchObject({
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-2' }
    });
    child.stdout.write('{"id":1,"result":{}}\n');
    await result;
    provider.close();
  });

  it('bounds responses and fails pending RPCs on exit', async () => {
    const { child, provider } = fixture();
    const request = provider.request('account/read', {});
    child.stdout.write('x'.repeat(1048577));
    await expect(request).rejects.toThrow('PROVIDER_OUTPUT_LIMIT');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('times out transport without starting another execution', async () => {
    const { provider, sent } = fixture(5);
    await expect(provider.request('account/read', {})).rejects.toThrow('PROVIDER_RPC_TIMEOUT');
    expect(sent).toHaveLength(1);
    provider.close();
  });
});
