import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LandingPreviewCatalog,
  type LandingRenderer
} from '../apps/agent/src/landing-preview/catalog.js';
import { inspectZip } from '../apps/agent/src/landing-preview/archive.js';
import { LandingPageRenderer } from '../apps/agent/src/landing-preview/renderer.js';
import { discoverLandings } from '../apps/agent/src/landing-preview/scanner.js';
import { zipDirectory } from '../apps/agent/src/platform/platform.js';

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

class TestRenderer implements LandingRenderer {
  renders = 0;
  failNext = false;

  async init() {}

  availability() {
    return { available: true, error: null };
  }

  async render({ root, entryFile, outputPath }: Parameters<LandingRenderer['render']>[0]) {
    await access(path.join(root, entryFile));
    this.renders += 1;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('Synthetic renderer failure.');
    }
    await writeFile(outputPath, fakePreview(`preview-${this.renders}`));
    return {
      width: 1440,
      height: 1200,
      segmentFiles: [outputPath],
      title: null,
      blockedExternalRequests: 0,
      warning: null
    };
  }

  async shutdown() {}
}

async function waitForIdle(catalog: LandingPreviewCatalog) {
  const deadline = Date.now() + 10_000;
  while (catalog.state().running && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (catalog.state().running) throw new Error('Landing preview run did not finish.');
}

describe('landing preview discovery and cache', () => {
  it('stops at folder landing roots and discovers one or many landings inside ZIPs', async () => {
    const workspace = await temporaryDirectory('wishly-preview-scan-');
    const catalogue = path.join(workspace, 'catalogue');
    const archiveSource = path.join(workspace, 'archive-bundle');
    await Promise.all([
      mkdir(path.join(catalogue, 'client-a', 'nested', 'ignored'), { recursive: true }),
      mkdir(path.join(catalogue, 'group', 'client-b'), { recursive: true }),
      mkdir(path.join(archiveSource, 'facebook'), { recursive: true }),
      mkdir(path.join(archiveSource, 'tiktok', 'nested'), { recursive: true })
    ]);
    await Promise.all([
      writeFile(path.join(catalogue, 'client-a', 'index.html'), '<h1>A</h1>'),
      writeFile(path.join(catalogue, 'client-a', 'nested', 'ignored', 'index.html'), '<h1>X</h1>'),
      writeFile(path.join(catalogue, 'group', 'client-b', 'INDEX.HTM'), '<h1>B</h1>'),
      writeFile(path.join(archiveSource, 'facebook', 'index.html'), '<h1>Facebook</h1>'),
      writeFile(path.join(archiveSource, 'tiktok', 'index.htm'), '<h1>TikTok</h1>'),
      writeFile(path.join(archiveSource, 'tiktok', 'nested', 'index.html'), '<h1>Ignored</h1>')
    ]);
    const archive = path.join(catalogue, 'network-offers.zip');
    await zipDirectory(archiveSource, archive);

    const result = await discoverLandings(catalogue);
    expect(result.warnings).toEqual([]);
    expect(result.landings.map(item => item.relativePath)).toEqual([
      'client-a',
      'group/client-b',
      'network-offers.zip/archive-bundle/facebook',
      'network-offers.zip/archive-bundle/tiktok'
    ]);
    expect(result.landings.filter(item => item.sourceKind === 'zip')).toHaveLength(2);
    const inspection = await inspectZip(archive);
    expect(inspection.landingRoots).toEqual(['archive-bundle/facebook', 'archive-bundle/tiktok']);
  });

  it('rejects ZIP entries that could escape the extraction directory', async () => {
    const workspace = await temporaryDirectory('wishly-preview-unsafe-');
    const archive = path.join(workspace, 'unsafe.zip');
    await writeFile(archive, storedZip([{ name: '../escape.txt', contents: 'nope' }]));
    await expect(inspectZip(archive)).rejects.toThrow(/(?:relative path|parent-directory)/u);
  });

  it('reuses unchanged previews, persists them, and keeps the old image after a failed refresh', async () => {
    const workspace = await temporaryDirectory('wishly-preview-cache-');
    const catalogueRoot = path.join(workspace, 'catalogue');
    const cacheRoot = path.join(workspace, 'cache');
    const landingRoot = path.join(catalogueRoot, 'campaign');
    await mkdir(landingRoot, { recursive: true });
    const entry = path.join(landingRoot, 'index.html');
    await writeFile(entry, '<!doctype html><title>First</title>');

    const renderer = new TestRenderer();
    const catalog = new LandingPreviewCatalog({ root: cacheRoot, renderer });
    await catalog.init();
    expect(await catalog.openRoot(catalogueRoot)).toBe(true);
    await waitForIdle(catalog);
    expect(renderer.renders).toBe(1);
    const first = catalog.state().landings[0];
    expect(first).toMatchObject({ status: 'ready', stale: false, previewAvailable: true });
    const originalPreview = await catalog.previewPath(first.id);
    expect(originalPreview).not.toBeNull();
    expect((await readFile(originalPreview!)).includes(Buffer.from('preview-1'))).toBe(true);

    expect(catalog.refresh('changed')).toBe(true);
    await waitForIdle(catalog);
    expect(renderer.renders).toBe(1);

    await writeFile(entry, '<!doctype html><title>Changed landing with more bytes</title>');
    renderer.failNext = true;
    expect(catalog.refresh('changed')).toBe(true);
    await waitForIdle(catalog);
    expect(renderer.renders).toBe(2);
    expect(catalog.state().landings[0]).toMatchObject({
      status: 'failed',
      stale: true,
      previewAvailable: true,
      error: 'Synthetic renderer failure.'
    });
    expect((await readFile(originalPreview!)).includes(Buffer.from('preview-1'))).toBe(true);
    await catalog.shutdown();

    const restoredRenderer = new TestRenderer();
    const restored = new LandingPreviewCatalog({ root: cacheRoot, renderer: restoredRenderer });
    await restored.init();
    expect(restored.state().catalogs).toHaveLength(1);
    expect(restored.state().landings[0]).toMatchObject({
      stale: true,
      previewAvailable: true
    });
    expect(await restored.clearActiveCache()).toBe(true);
    expect(restored.state().landings[0]).toMatchObject({
      status: 'queued',
      previewAvailable: false
    });
    await restored.shutdown();
  });

  it('extracts ZIP landings only into the managed cache and exposes that safe copy', async () => {
    const workspace = await temporaryDirectory('wishly-preview-archive-');
    const catalogueRoot = path.join(workspace, 'catalogue');
    const source = path.join(workspace, 'offer');
    await mkdir(source, { recursive: true });
    await mkdir(catalogueRoot, { recursive: true });
    await writeFile(path.join(source, 'index.html'), '<h1>Archived</h1>');
    const archive = path.join(catalogueRoot, 'offer.zip');
    await zipDirectory(source, archive);

    const catalog = new LandingPreviewCatalog({
      root: path.join(workspace, 'cache'),
      renderer: new TestRenderer()
    });
    await catalog.init();
    await catalog.openRoot(catalogueRoot);
    await waitForIdle(catalog);
    const landing = catalog.state().landings[0];
    expect(landing).toMatchObject({
      sourceKind: 'zip',
      status: 'ready',
      extractedAvailable: true
    });
    const extracted = catalog.extractedPath(landing.id);
    expect(extracted).not.toBeNull();
    await expect(access(path.join(extracted!, 'index.html'))).resolves.toBeUndefined();
    expect(catalog.sourcePath(landing.id)).toBe(await realpath(archive));
    await catalog.shutdown();
  });

  it('does not restore an empty cached screenshot as a ready preview', async () => {
    const workspace = await temporaryDirectory('wishly-preview-empty-cache-');
    const catalogueRoot = path.join(workspace, 'catalogue');
    const landingRoot = path.join(catalogueRoot, 'campaign');
    const cacheRoot = path.join(workspace, 'cache');
    await mkdir(landingRoot, { recursive: true });
    await writeFile(path.join(landingRoot, 'index.html'), '<h1>Campaign</h1>');

    const catalog = new LandingPreviewCatalog({ root: cacheRoot, renderer: new TestRenderer() });
    await catalog.init();
    await catalog.openRoot(catalogueRoot);
    await waitForIdle(catalog);
    const preview = await catalog.previewPath(catalog.state().landings[0].id);
    expect(preview).not.toBeNull();
    await catalog.shutdown();
    await writeFile(preview!, Buffer.alloc(0));

    const restored = new LandingPreviewCatalog({ root: cacheRoot, renderer: new TestRenderer() });
    await restored.init();
    expect(restored.state().landings[0]).toMatchObject({
      status: 'queued',
      previewAvailable: false,
      previewWidth: null,
      previewHeight: null
    });
    await restored.shutdown();
  });

  it('queues previews made by the old capture profile for an automatic rebuild', async () => {
    const workspace = await temporaryDirectory('wishly-preview-profile-upgrade-');
    const catalogueRoot = path.join(workspace, 'catalogue');
    const landingRoot = path.join(catalogueRoot, 'campaign');
    const cacheRoot = path.join(workspace, 'cache');
    await mkdir(landingRoot, { recursive: true });
    await writeFile(path.join(landingRoot, 'index.html'), '<h1>Campaign</h1>');

    const original = new LandingPreviewCatalog({ root: cacheRoot, renderer: new TestRenderer() });
    await original.init();
    await original.openRoot(catalogueRoot);
    await waitForIdle(original);
    await original.shutdown();

    const statePath = path.join(cacheRoot, 'state.json');
    const stored = JSON.parse(await readFile(statePath, 'utf8'));
    stored.catalogs[0].landings[0].renderProfile = 'desktop-1440x900-v1';
    await writeFile(statePath, JSON.stringify(stored));

    const renderer = new TestRenderer();
    const upgraded = new LandingPreviewCatalog({ root: cacheRoot, renderer });
    await upgraded.init();
    expect(upgraded.state().landings[0]).toMatchObject({
      status: 'queued',
      stale: true,
      previewAvailable: true
    });
    await upgraded.activate(upgraded.state().activeCatalogId!);
    await waitForIdle(upgraded);
    expect(renderer.renders).toBe(1);
    expect(upgraded.state().landings[0]).toMatchObject({ status: 'ready', stale: false });
    await upgraded.shutdown();
  });
});

describe('landing preview Chromium renderer', () => {
  it('renders a full-page WebP locally while blocking external resources', async () => {
    const workspace = await temporaryDirectory('wishly-preview-render-');
    const landing = path.join(workspace, 'landing');
    const output = path.join(workspace, 'preview.webp');
    await mkdir(landing, { recursive: true });
    await writeFile(
      path.join(landing, 'index.html'),
      `<!doctype html>
      <style>html,body{margin:0} main{height:1800px;background:linear-gradient(#123,#def)}</style>
      <script src="https://example.invalid/tracker.js"></script>
      <main><h1>Local preview</h1></main>`
    );
    const renderer = new LandingPageRenderer();
    await renderer.init();
    expect(renderer.availability().available).toBe(true);
    try {
      const result = await renderer.render({
        root: landing,
        entryFile: 'index.html',
        outputPath: output
      });
      expect(result.width).toBe(1440);
      expect(result.height).toBeGreaterThanOrEqual(1800);
      expect(result.segmentFiles).toEqual([output]);
      expect(result.blockedExternalRequests).toBeGreaterThanOrEqual(1);
      const bytes = await readFile(output);
      expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(bytes.subarray(8, 12).toString('ascii')).toBe('WEBP');

      const longOutput = path.join(workspace, 'long-preview.webp');
      await writeFile(
        path.join(landing, 'index.html'),
        `<!doctype html>
        <style>
          html,body{margin:0}
          .scroll-root{height:900px;overflow-y:auto}
          .content{height:20500px;background:linear-gradient(#213 0%,#def 100%)}
        </style>
        <div class="scroll-root"><main class="content"><h1>Long landing</h1></main></div>`
      );
      const longResult = await renderer.render({
        root: landing,
        entryFile: 'index.html',
        outputPath: longOutput
      });
      expect(longResult.height).toBeGreaterThanOrEqual(20_000);
      expect(longResult.segmentFiles.length).toBeGreaterThanOrEqual(3);
      for (const segment of longResult.segmentFiles) {
        const segmentBytes = await readFile(segment);
        expect(segmentBytes.length).toBeGreaterThan(32);
        expect(segmentBytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
        expect(segmentBytes.subarray(8, 12).toString('ascii')).toBe('WEBP');
      }
    } finally {
      await renderer.shutdown();
    }
  }, 45_000);
});

function fakePreview(label: string) {
  const payload = Buffer.alloc(32, 0);
  payload.write(label, 0, 'utf8');
  return Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), payload]);
}

function storedZip(entries: Array<{ name: string; contents: string }>) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const contents = Buffer.from(entry.contents, 'utf8');
    const crc = crc32(contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(contents.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, contents);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(contents.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + contents.length;
  }
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function crc32(value: Buffer) {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
