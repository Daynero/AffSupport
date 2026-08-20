import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PowerGovernor } from '../apps/agent/src/power/governor.js';
import { registerPowerRoutes } from '../apps/agent/src/power/routes.js';

/**
 * The limit governs local *processing* and nothing else.
 *
 * It must never slow the interface, a file transfer, or anything that happens
 * on a server. A user who caps Soty at 20% to keep their machine usable would
 * be baffled to find their uploads crawling as a result — and would have no way
 * to connect the two.
 */

const AGENT_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/agent/src');

afterEach(() => {
  vi.restoreAllMocks();
});

async function sourcesUnder(directory: string): Promise<{ relative: string; source: string }[]> {
  const files: { relative: string; source: string }[] = [];
  const root = path.join(AGENT_SRC, directory);
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.name.endsWith('.ts'))
        files.push({
          relative: path.relative(AGENT_SRC, absolute),
          source: await readFile(absolute, 'utf8')
        });
    }
  };
  await walk(root);
  return files;
}

describe('transfers stay outside the budget', () => {
  it('registers nothing from the team transfer path', async () => {
    const transfers = await sourcesUnder('team-bridge');
    const registering = transfers
      .filter(({ source }) => /governor\.register\(|spawnManaged\(|spawnTracked\(/.test(source))
      .map(({ relative }) => relative);

    // Uploads and downloads are network work, not CPU work: throttling them
    // would deliver a slowdown the user never asked for.
    expect(registering).toEqual([]);
  });

  it('leaves the transfer client free of any resource-budget coupling', async () => {
    const transfer = await readFile(path.join(AGENT_SRC, 'team-bridge/transfer.ts'), 'utf8');
    expect(transfer).not.toMatch(/PowerGovernor|spawnManaged|spawnTracked|scaleTimeout/);
  });
});

describe('the agent stays responsive', () => {
  it('answers HTTP promptly at the minimum limit', async () => {
    const app = Fastify({ logger: false });
    const governor = new PowerGovernor({ cpuCount: 8, pauseSupported: true });
    registerPowerRoutes(app, { governor, allowedOrigins: new Set(['http://127.0.0.1:5173']) });
    await governor.setLimit(20);

    const started = Date.now();
    const response = await app.inject({ method: 'GET', url: '/api/power' });
    // The throttle applies to spawned tools, never to the agent's own event
    // loop; a request served under a limit is served at normal speed.
    expect(response.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(1_000);
    await app.close();
  });

  it('never lowers the priority of the agent process itself', async () => {
    const spawn = await readFile(path.join(AGENT_SRC, 'power/spawn.ts'), 'utf8');
    // os.setPriority is called with a child's pid, never with 0 or the agent's
    // own pid — throttling the agent would throttle the UI it serves.
    expect(spawn).toMatch(/os\.setPriority\(child\.pid,/);
    expect(spawn).not.toMatch(/os\.setPriority\(\s*(0|process\.pid)/);
  });
});

describe('only sustained local work is governed', () => {
  it('leaves sub-second probes and dialogs unmanaged', async () => {
    const probes = [
      'ffmpeg/tools.ts',
      'whisper/tools.ts',
      'files/picker.ts',
      'files/dropped-source.ts'
    ];
    for (const relative of probes) {
      const source = await readFile(path.join(AGENT_SRC, relative), 'utf8');
      // Managing a 30 ms version probe would cost more than it could ever save.
      expect(source, `${relative} should stay unmanaged`).not.toMatch(/spawnManaged|spawnTracked/);
    }
  });
});
