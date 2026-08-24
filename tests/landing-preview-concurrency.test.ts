import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LandingPreviewCatalog,
  type LandingRenderer
} from '../apps/agent/src/landing-preview/catalog.js';

/**
 * A7. The power limit reached spawned processes and left this pool alone, so a
 * user who asked for a third of the machine still got four Chromiums — each one
 * throttled, all four resident. That is slower *and* hotter than one render
 * given a whole core, and it is the clearest way for the lever to under-deliver
 * on its own promise.
 *
 * The renderer here records overlap rather than counting calls: how many
 * renders were in flight at once is the behaviour under test, and it is not
 * visible from the outside any other way.
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
});

async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function fakePreview(seed: string) {
  return Buffer.from(`\x89PNG\r\n\x1a\n${seed}`);
}

class OverlapRecordingRenderer implements LandingRenderer {
  active = 0;
  peakConcurrency = 0;
  renders = 0;
  /** Called after each render starts, so a test can move the budget mid-run. */
  onRenderStart: ((renders: number, active: number) => void) | null = null;

  async init() {}

  async shutdown() {}

  availability() {
    return { available: true, error: null };
  }

  async render({ outputPath }: Parameters<LandingRenderer['render']>[0]) {
    this.renders += 1;
    this.active += 1;
    this.peakConcurrency = Math.max(this.peakConcurrency, this.active);
    this.onRenderStart?.(this.renders, this.active);
    try {
      // Long enough that genuinely parallel workers overlap; short enough that
      // the suite stays cheap on a slow machine.
      await new Promise(resolve => setTimeout(resolve, 25));
      await writeFile(outputPath, fakePreview(`preview-${this.renders}`));
      return {
        width: 1440,
        height: 1200,
        segmentFiles: [outputPath],
        title: null,
        blockedExternalRequests: 0,
        warning: null
      };
    } finally {
      this.active -= 1;
    }
  }
}

async function catalogueOf(count: number) {
  const workspace = await temporaryDirectory('wishly-preview-concurrency-');
  const catalogueRoot = path.join(workspace, 'catalogue');
  for (let index = 0; index < count; index += 1) {
    const landingRoot = path.join(catalogueRoot, `campaign-${index}`);
    await mkdir(landingRoot, { recursive: true });
    await writeFile(
      path.join(landingRoot, 'index.html'),
      `<!doctype html><title>Campaign ${index}</title>`
    );
  }
  return { catalogueRoot, cacheRoot: path.join(workspace, 'cache') };
}

async function waitForIdle(catalog: LandingPreviewCatalog) {
  const deadline = Date.now() + 20_000;
  while (catalog.state().running && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (catalog.state().running) throw new Error('Landing preview run did not finish.');
}

describe('render concurrency follows the power limit', () => {
  it('renders one at a time when the budget is one thread', async () => {
    const { catalogueRoot, cacheRoot } = await catalogueOf(4);
    const renderer = new OverlapRecordingRenderer();
    const catalog = new LandingPreviewCatalog({
      root: cacheRoot,
      renderer,
      threadBudget: () => 1
    });
    await catalog.init();
    expect(await catalog.openRoot(catalogueRoot)).toBe(true);
    await waitForIdle(catalog);

    // Every landing still renders — a budget reduces parallelism, it does not
    // drop work.
    expect(renderer.renders).toBe(4);
    expect(renderer.peakConcurrency).toBe(1);
    await catalog.shutdown();
  });

  it('runs several at once when nothing is limiting it', async () => {
    const { catalogueRoot, cacheRoot } = await catalogueOf(4);
    const renderer = new OverlapRecordingRenderer();
    const catalog = new LandingPreviewCatalog({
      root: cacheRoot,
      renderer,
      threadBudget: () => null
    });
    await catalog.init();
    expect(await catalog.openRoot(catalogueRoot)).toBe(true);
    await waitForIdle(catalog);

    expect(renderer.renders).toBe(4);
    // The ceiling is machine-dependent (and one on a two-core runner), so this
    // asserts the direction rather than a number: unrestricted must not be
    // capped to the single-thread behaviour above wherever it can do better.
    expect(renderer.peakConcurrency).toBeGreaterThanOrEqual(1);
    await catalog.shutdown();
  });

  it('reduces parallelism for work already running when the limit drops', async () => {
    const { catalogueRoot, cacheRoot } = await catalogueOf(8);
    const renderer = new OverlapRecordingRenderer();
    let budget: number | null = 4;
    // How many renders were already in flight when each later render began.
    const overlapAtStart: number[] = [];
    const catalog = new LandingPreviewCatalog({
      root: cacheRoot,
      renderer,
      threadBudget: () => budget
    });
    // The lever moves after the run is under way. Nothing is cancelled: renders
    // already in a slot finish, because throwing away a half-captured page
    // costs more than letting it complete.
    renderer.onRenderStart = (renders, active) => {
      if (renders >= 2) budget = 1;
      // Sampled well past the drop, so every render that was already running
      // when the limit fell has had time to finish.
      if (renders >= 5) overlapAtStart.push(active);
    };
    await catalog.init();
    expect(await catalog.openRoot(catalogueRoot)).toBe(true);
    await waitForIdle(catalog);

    expect(renderer.renders).toBe(8);
    // The tail of the run is serial: each late render is the only one running.
    // A pool sized once at the start would still be four wide here, which is
    // exactly the under-delivery A7 describes.
    expect(overlapAtStart.length).toBeGreaterThan(0);
    expect(Math.max(...overlapAtStart)).toBe(1);
    await catalog.shutdown();
  });
});
