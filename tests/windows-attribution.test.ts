import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error - build script without type declarations
import { parseInputsManifest } from '../scripts/lib/windows-inputs.mjs';

const notices = readFileSync('THIRD_PARTY_NOTICES.md', 'utf8');

function manifest() {
  const result = parseInputsManifest(
    JSON.parse(readFileSync('packaging/windows/inputs.json', 'utf8'))
  );
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

/**
 * Attribution has to move with the bundle, not lag behind it. These tests fail
 * when a bundled Windows input has no corresponding notice, which is how the
 * whisper.cpp gap (absent for both platforms until this feature) is kept closed.
 */
describe('Windows attribution stays in step with what is bundled', () => {
  it('documents every pinned input somewhere in the notices', () => {
    const expectations: Record<string, RegExp> = {
      node: /Node\.js/u,
      whisper: /whisper\.cpp/u,
      'whisper-vad-model': /Silero VAD/u,
      ffmpeg: /FFmpeg/u,
      'ffmpeg-source': /7\.1\.1/u,
      'x264-source': /x264/u
    };
    for (const entry of manifest().inputs) {
      const pattern = expectations[entry.id];
      if (!pattern) continue;
      expect(notices, `${entry.id} is bundled but not attributed`).toMatch(pattern);
    }
  });

  it('records the whisper.cpp licence, which was missing for both platforms', () => {
    expect(notices).toMatch(/whisper\.cpp 1\.9\.1/u);
    expect(notices).toMatch(/MIT license/u);
  });

  it('names the Windows build provenance file so a reader can check the hashes', () => {
    expect(notices).toContain('packaging/windows/inputs.json');
  });

  it('records the GPL source offer for the FFmpeg it builds', () => {
    const ffmpeg = manifest().inputs.find((entry: { id: string }) => entry.id === 'ffmpeg');
    expect(ffmpeg.status).toBe('built');
    // Redistributing a GPL binary obliges us to offer its corresponding source.
    expect(notices).toMatch(/complete corresponding source/u);
    expect(notices).toMatch(/licenses\/sources\//u);
    for (const source of ffmpeg.builtFrom) {
      const entry = manifest().inputs.find((i: { id: string }) => i.id === source);
      expect(entry.status, `${source} must be pinned to back the source offer`).toBe('pinned');
    }
  });

  it('names the exact FFmpeg and x264 revisions both platforms are built from', () => {
    expect(notices).toMatch(/7\.1\.1/u);
    expect(notices).toContain('0480cb05fa188d37ae87e8f4fd8f1aea3711f7ee');
  });

  it('states that macOS and Windows bundle different builds', () => {
    expect(notices).toMatch(/Windows package bundles different builds/u);
  });
});
