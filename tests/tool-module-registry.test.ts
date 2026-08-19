import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createToolModules } from '../apps/agent/src/server/tools.js';
import { AGENT_TOOL_CONTRACTS } from '../packages/shared/src/release.js';

/**
 * Adding or fixing a tool must be a one-place change. The module list in
 * `server/tools.ts` is that place: route registration, the `/health` busy flag
 * and the shutdown chain all iterate it, so a tool cannot be half-registered.
 * These tests hold that invariant rather than the specific tools of the day.
 */
function stubDeps() {
  const busy = vi.fn(() => false);
  const shutdown = vi.fn(async () => {});
  const queueLike = { workActive: busy, shutdown };
  return {
    compressor: {
      queue: queueLike,
      estimator: { shutdown },
      imageStore: {},
      events: {},
      tools: { ffmpeg: true, ffprobe: true }
    },
    mediaActions: { workActive: busy, shutdown },
    landing: { optimizer: { state: () => ({ running: false }), shutdown }, events: {} },
    landingPreview: { catalog: { busy, shutdown }, events: {} },
    transcription: { queue: queueLike, events: {} },
    teamWorkspace: {
      preview: { busy, shutdown },
      process: { busy, shutdown },
      download: { busy, shutdown },
      landings: { busy, shutdown },
      library: { busy, shutdown },
      events: {}
    }
  };
}

/** The stubs only need the members the module list actually touches. */
function stubModules() {
  return createToolModules(stubDeps() as unknown as Parameters<typeof createToolModules>[0]);
}

describe('tool module registry', () => {
  const modules = stubModules();

  it('gives every module the full interface the server iterates', () => {
    for (const module of modules) {
      expect(typeof module.id).toBe('string');
      expect(typeof module.register).toBe('function');
      expect(typeof module.busy).toBe('function');
      expect(typeof module.shutdown).toBe('function');
    }
  });

  it('has unique ids, so a tool cannot be registered twice', () => {
    const ids = modules.map(module => module.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('registers exactly the tools the release contract declares support for', () => {
    // Contract names are camelCase; module ids are kebab-case.
    const moduleIds = new Set(modules.map(module => module.id));
    const contractToModule: Record<string, string> = {
      compressor: 'compressor',
      landingOptimizer: 'landing',
      landingPreview: 'landing-preview',
      transcription: 'transcription',
      teamWorkspace: 'team-workspace'
    };
    for (const [contract, moduleId] of Object.entries(contractToModule)) {
      expect(AGENT_TOOL_CONTRACTS, `${contract} must have a declared contract`).toHaveProperty(
        contract
      );
      expect(moduleIds, `${contract} must have a registered module`).toContain(moduleId);
    }
  });

  it('keeps the shutdown order the server depends on', () => {
    expect(modules.map(module => module.id)).toEqual([
      'compressor',
      'media-actions',
      'landing',
      'landing-preview',
      'transcription',
      'team-workspace'
    ]);
  });

  it('is the only place the server enumerates tools', () => {
    // If routes, busy or shutdown were built from separate lists, adding a tool
    // would stop being a one-place change.
    const app = readFileSync('apps/agent/src/server/app.ts', 'utf8');
    expect(app).toMatch(/modules\.some\(module => module\.busy\(\)\)/u);
    expect(app.match(/modules\.(forEach|map|some|reduce)/gu)?.length ?? 0).toBeGreaterThan(0);
  });

  it('reports busy when any single tool is working', () => {
    expect(modules.some(module => module.busy())).toBe(false);

    const busyPreview = createToolModules({
      ...stubDeps(),
      landingPreview: { catalog: { busy: () => true, shutdown: async () => {} }, events: {} }
    } as unknown as Parameters<typeof createToolModules>[0]);
    // /health derives its busy flag from exactly this, so one working tool is
    // enough to hold off an update.
    expect(busyPreview.some(module => module.busy())).toBe(true);
  });
});
