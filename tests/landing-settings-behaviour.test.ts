import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LandingOptimizer } from '../apps/agent/src/landing/optimizer.js';
import { numberedRenames } from '../apps/agent/src/landing/numbering.js';
import { loadLandingSettings, saveLandingSettings } from '../apps/agent/src/landing/store.js';
import { defaultLandingSettings, type LandingAsset } from '@video-compressor/shared';
import { removeTemporaryDirectory } from './support/temp-dir.js';

/**
 * What the Landing Optimizer was asked to be able to do.
 *
 * Four settings, and one of them exists because the tool had no answer at all: a landing
 * picked with the dialog was written beside its original, the same landing dropped onto the
 * page was written to `Downloads/Soty Landings`, and nothing in the interface said which
 * would happen. The destination is now the compressor's own choice, made once and honoured
 * by every route in.
 */

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => removeTemporaryDirectory(root)));
});

async function landingFolder(parent: string, name: string): Promise<string> {
  const dir = path.join(parent, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'index.html'),
    '<html><body><img src="logo.svg"></body></html>'
  );
  await writeFile(
    path.join(dir, 'logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>'
  );
  return dir;
}

describe('where an optimized landing is written', () => {
  it('goes to the chosen folder, whatever route the landing came in by', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'landing-dest-'));
    roots.push(root);
    vi.stubEnv('AGENT_LANDING_WORKSPACE', path.join(root, 'workspaces'));
    vi.stubEnv('AGENT_LANDING_SETTINGS_PATH', path.join(root, 'settings.json'));
    const chosen = path.join(root, 'somewhere else');
    const source = await landingFolder(root, 'promo');

    const optimizer = new LandingOptimizer({ ffmpeg: true, ffprobe: true }, () => {});
    optimizer.updateSettings({ archive: false, outputMode: 'chosen-folder', outputFolder: chosen });
    await optimizer.prepareFromFolderPath(source);
    const job = optimizer.state().jobs[0] ?? optimizer.state().job!;
    await optimizer.start([job.id]);
    const output = (optimizer.state().jobs[0] ?? optimizer.state().job!).outputPath!;

    expect(path.dirname(output)).toBe(chosen);
    await expect(access(output)).resolves.toBeUndefined();
    await optimizer.shutdown();
  }, 60_000);

  it('is read when the result is written, not when the landing was added', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'landing-dest-late-'));
    roots.push(root);
    vi.stubEnv('AGENT_LANDING_WORKSPACE', path.join(root, 'workspaces'));
    vi.stubEnv('AGENT_LANDING_SETTINGS_PATH', path.join(root, 'settings.json'));
    const chosen = path.join(root, 'picked-after');
    const source = await landingFolder(root, 'promo');

    const optimizer = new LandingOptimizer({ ffmpeg: true, ffprobe: true }, () => {});
    await optimizer.prepareFromFolderPath(source);
    // The order a person actually works in: add the landings, then decide where they go.
    optimizer.updateSettings({ outputMode: 'chosen-folder', outputFolder: chosen });
    const job = optimizer.state().jobs[0] ?? optimizer.state().job!;
    await optimizer.start([job.id]);
    const output = (optimizer.state().jobs[0] ?? optimizer.state().job!).outputPath!;

    expect(path.dirname(output)).toBe(chosen);
    await optimizer.shutdown();
  }, 60_000);
});

describe('the settings survive the app closing', () => {
  it('reads back what was written, and fills in what an older file never had', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'landing-settings-'));
    roots.push(root);
    const file = path.join(root, 'landing-settings.json');

    await saveLandingSettings(
      { ...defaultLandingSettings(), outputMode: 'chosen-folder', outputFolder: '/tmp/out' },
      file
    );
    const restored = await loadLandingSettings(file);
    expect(restored.outputMode).toBe('chosen-folder');
    expect(restored.outputFolder).toBe('/tmp/out');

    // A file written before these fields existed: every one of them reads as its default
    // rather than arriving at the optimizer as undefined.
    await writeFile(file, JSON.stringify({ imageQuality: 'high' }), 'utf8');
    const older = await loadLandingSettings(file);
    expect(older.imageQuality).toBe('high');
    expect(older.optimizeImages).toBe(true);
    expect(older.optimizeVideos).toBe(true);
    expect(older.renameMedia).toBe(false);
  });

  it('answers with the defaults when there is nothing saved', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'landing-settings-none-'));
    roots.push(root);
    await expect(loadLandingSettings(path.join(root, 'absent.json'))).resolves.toEqual(
      defaultLandingSettings()
    );
  });
});

describe('renumbering the media', () => {
  function asset(id: string, relPath: string, type: 'image' | 'video'): LandingAsset {
    return {
      id,
      relPath,
      fileName: path.posix.basename(relPath),
      type,
      status: 'optimized',
      originalSize: 10,
      optimizedSize: 5,
      savedBytes: 5,
      savedPercent: 50,
      progress: null,
      newRelPath: null,
      note: null,
      preview: null
    };
  }

  it('numbers each kind in order, and leaves every file in its own folder', () => {
    const renames = numberedRenames(
      [
        asset('a', 'assets/hero.webp', 'image'),
        asset('b', 'clip.mp4', 'video'),
        asset('c', 'assets/deep/photo.webp', 'image'),
        asset('d', 'promo.mp4', 'video')
      ],
      new Set()
    );
    expect(renames.get('assets/hero.webp')).toBe('assets/img1.webp');
    expect(renames.get('assets/deep/photo.webp')).toBe('assets/deep/img2.webp');
    expect(renames.get('clip.mp4')).toBe('vid1.mp4');
    expect(renames.get('promo.mp4')).toBe('vid2.mp4');
  });

  it('follows a file to the name optimizing already gave it', () => {
    const optimized = asset('a', 'hero.jpg', 'image');
    optimized.newRelPath = 'hero.webp';
    // The chain ends in one place: `.jpg` → `.webp` → `img1.webp`, never at the middle of it.
    expect(numberedRenames([optimized], new Set()).get('hero.webp')).toBe('img1.webp');
  });

  it('leaves a name that is already taken alone rather than overwriting it', () => {
    // A landing that already ships an `img1.png` keeps it; overwriting a file to tidy the
    // names would be a worse outcome than an unnumbered one.
    const renames = numberedRenames([asset('a', 'hero.png', 'image')], new Set(['img1.png']));
    expect(renames.size).toBe(0);
  });

  it('counts a file that keeps its own name, so the sequence has no holes', () => {
    const renames = numberedRenames(
      [asset('a', 'img1.webp', 'image'), asset('b', 'hero.webp', 'image')],
      new Set(['img1.webp', 'hero.webp'])
    );
    // The first is already `img1`; the second becomes `img2`, not `img1`.
    expect(renames.get('hero.webp')).toBe('img2.webp');
  });
});

describe('the media a run is told to leave alone', () => {
  it('keeps images exactly as they arrived when images are switched off', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'landing-images-off-'));
    roots.push(root);
    vi.stubEnv('AGENT_LANDING_WORKSPACE', path.join(root, 'workspaces'));
    vi.stubEnv('AGENT_LANDING_SETTINGS_PATH', path.join(root, 'settings.json'));
    const source = path.join(root, 'promo');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'index.html'), '<img src="photo.png">');
    // A real PNG, so the run would genuinely have had something to convert.
    await writeFile(
      path.join(source, 'photo.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
      )
    );

    const optimizer = new LandingOptimizer({ ffmpeg: true, ffprobe: true }, () => {});
    optimizer.updateSettings({ optimizeImages: false, archive: false, renameMedia: false });
    await optimizer.prepareFromFolderPath(source);
    const job = optimizer.state().jobs[0] ?? optimizer.state().job!;
    await optimizer.start([job.id]);
    const finished = optimizer.state().jobs[0] ?? optimizer.state().job!;

    const written = await readdir(finished.outputPath!);
    // Still a PNG, still under its own name, and the page still points at it.
    expect(written).toContain('photo.png');
    expect(written).not.toContain('photo.webp');
    expect(await readFile(path.join(finished.outputPath!, 'index.html'), 'utf8')).toContain(
      'photo.png'
    );
    const image = finished.assets.find(item => item.fileName === 'photo.png');
    expect(image?.status).toBe('skipped');
    expect(image?.note).toBe('images-off');
    await optimizer.shutdown();
  }, 60_000);
});

describe('renumbering a whole landing', () => {
  it('renames the files and rewrites every reference to them', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'landing-rename-'));
    roots.push(root);
    vi.stubEnv('AGENT_LANDING_WORKSPACE', path.join(root, 'workspaces'));
    vi.stubEnv('AGENT_LANDING_SETTINGS_PATH', path.join(root, 'settings.json'));
    const source = path.join(root, 'promo');
    await mkdir(path.join(source, 'assets'), { recursive: true });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    await writeFile(path.join(source, 'assets', 'Знімок екрана.png'), png);
    await writeFile(path.join(source, 'assets', 'hero-final-FINAL.png'), png);
    await writeFile(
      path.join(source, 'index.html'),
      [
        '<html><body>',
        '<img src="assets/hero-final-FINAL.png">',
        '<img src="./assets/%D0%97%D0%BD%D1%96%D0%BC%D0%BE%D0%BA%20%D0%B5%D0%BA%D1%80%D0%B0%D0%BD%D0%B0.png">',
        '<a href="https://example.com/assets/hero-final-FINAL.png">off-site</a>',
        '</body></html>'
      ].join('\n')
    );
    await writeFile(
      path.join(source, 'assets', 'style.css'),
      '.a{background:url(hero-final-FINAL.png)}.b{background:url(../assets/hero-final-FINAL.png)}'
    );

    const optimizer = new LandingOptimizer({ ffmpeg: true, ffprobe: true }, () => {});
    optimizer.updateSettings({ renameMedia: true, archive: false });
    await optimizer.prepareFromFolderPath(source);
    const job = optimizer.state().jobs[0] ?? optimizer.state().job!;
    await optimizer.start([job.id]);
    const output = (optimizer.state().jobs[0] ?? optimizer.state().job!).outputPath!;

    /* A one-pixel PNG is already smaller than any WebP of it, so the run keeps the original
       and the numbering follows it to the extension it actually has. That is the point of
       reading the current path rather than assuming the optimized one. */
    const written = await readdir(path.join(output, 'assets'));
    expect(written).toContain('img1.png');
    expect(written).toContain('img2.png');
    // The names they arrived with are gone, not left beside the new ones.
    expect(written).not.toContain('hero-final-FINAL.png');
    expect(written).not.toContain('Знімок екрана.png');

    const html = await readFile(path.join(output, 'index.html'), 'utf8');
    /* Which of the two got which number is the order the landing was walked in, and not
       something this test should pin. What it pins is that both were renumbered, that each
       reference kept the prefix it was written with, and that nothing else was touched. */
    expect(html).toMatch(/<img src="assets\/img[12]\.png">/u);
    expect(html).toMatch(/<img src="\.\/assets\/img[12]\.png">/u);
    expect(html).not.toContain('Знімок');
    // Somebody else's copy of the same file name is not ours to rewrite.
    expect(html).toContain('https://example.com/assets/hero-final-FINAL.png');

    const css = await readFile(path.join(output, 'assets', 'style.css'), 'utf8');
    expect(css).toMatch(/url\(img[12]\.png\)/u);
    // The `../assets/` prefix resolves to the same file and keeps its own spelling.
    expect(css).toMatch(/url\(\.\.\/assets\/img[12]\.png\)/u);
    expect(css).not.toContain('hero-final-FINAL');

    await optimizer.shutdown();
  }, 60_000);
});

describe('a name that is already taken', () => {
  it('optimizes beside it rather than giving the file up', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'landing-collide-'));
    roots.push(root);
    vi.stubEnv('AGENT_LANDING_WORKSPACE', path.join(root, 'workspaces'));
    vi.stubEnv('AGENT_LANDING_SETTINGS_PATH', path.join(root, 'settings.json'));
    const source = path.join(root, 'promo');
    await mkdir(source, { recursive: true });
    /* A landing that ships `doc.png` and a different `doc.webp`. Converting the PNG wants a
       name the WebP already has — and the run used to answer that by keeping the PNG whole.
       On the landing this was found on, that one file was 1.66 MB of a 2.58 MB result. */
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    await run('ffmpeg', [
      '-hide_banner', '-nostdin', '-y', '-f', 'lavfi',
      '-i', 'testsrc2=size=600x400:rate=1', '-frames:v', '1',
      path.join(source, 'doc.png')
    ]);
    // A real one-pixel WebP, written directly: this FFmpeg has no WebP encoder, and all this
    // file has to do is own the name.
    await writeFile(
      path.join(source, 'doc.webp'),
      Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64')
    );
    await writeFile(
      path.join(source, 'index.html'),
      '<img src="doc.png"><img src="doc.webp">'
    );

    const optimizer = new LandingOptimizer({ ffmpeg: true, ffprobe: true }, () => {});
    optimizer.updateSettings({ archive: false, renameMedia: false });
    await optimizer.prepareFromFolderPath(source);
    const job = optimizer.state().jobs[0] ?? optimizer.state().job!;
    await optimizer.start([job.id]);
    const finished = optimizer.state().jobs[0] ?? optimizer.state().job!;

    const written = await readdir(finished.outputPath!);
    // The PNG became a WebP under a name nothing owned, and the file that owned the first one
    // is untouched.
    expect(written).toContain('doc-2.webp');
    expect(written).toContain('doc.webp');
    expect(written).not.toContain('doc.png');

    const html = await readFile(path.join(finished.outputPath!, 'index.html'), 'utf8');
    expect(html).toContain('src="doc-2.webp"');
    // The other reference still points where it always did.
    expect(html).toContain('src="doc.webp"');

    const converted = finished.assets.find(item => item.fileName === 'doc.png');
    expect(converted?.status).toBe('optimized');
    expect(converted?.note).toBeNull();
    await optimizer.shutdown();
  }, 60_000);
});
