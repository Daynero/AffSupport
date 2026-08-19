import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error - build script without type declarations
import {
  copyleftSourceGaps,
  parseInputsManifest,
  releaseBlockers
} from '../scripts/lib/windows-inputs.mjs';

const manifestSource = JSON.parse(readFileSync('packaging/windows/inputs.json', 'utf8')) as unknown;

function parsed() {
  const result = parseInputsManifest(manifestSource);
  if (!result.ok) throw new Error(`manifest did not parse: ${result.error}`);
  return result.value;
}

/**
 * Environment variables scripts/stage-windows-runtime.mjs requires. FFmpeg and
 * FFprobe are compiled in CI rather than downloaded, so their entry is `built`,
 * but it still has to declare the same staging variables.
 */
const REQUIRED_STAGING_ENV = [
  'NODE_BINARY_WIN',
  'FFMPEG_BINARY_WIN',
  'FFPROBE_BINARY_WIN',
  'WHISPER_BINARY_WIN',
  'WHISPER_VAD_MODEL'
];

describe('windows build input manifest', () => {
  it('parses under an explicit guard', () => {
    expect(parseInputsManifest(manifestSource).ok).toBe(true);
  });

  it('produces every staging variable the runtime stager requires', () => {
    const provided = parsed().inputs.flatMap(entry =>
      entry.staging.map((target: { env: string }) => target.env)
    );
    for (const env of REQUIRED_STAGING_ENV) {
      expect(provided.filter(name => name === env)).toHaveLength(1);
    }
  });

  it('gives every downloaded input a complete checksum, size and https source', () => {
    for (const entry of parsed().inputs.filter(
      e => e.status === 'pinned' && e.archiveKind !== 'git'
    )) {
      expect(entry.sha256, entry.id).toMatch(/^[a-f0-9]{64}$/u);
      expect(entry.sizeBytes, entry.id).toBeGreaterThan(0);
      expect(entry.mirrorUrl ?? entry.upstreamUrl, entry.id).toMatch(/^https:\/\//u);
    }
  });

  it('records a license and provenance for every input, for attribution', () => {
    for (const entry of parsed().inputs) {
      expect(entry.license, entry.id).toBeTruthy();
      expect(entry.provenance, entry.id).toBeTruthy();
    }
  });

  it('keeps the Windows bundle on the same upstream versions as macOS', () => {
    const inputs = parsed().inputs;
    // macOS bundles a local build of whisper.cpp 1.9.1; Windows must not drift.
    expect(inputs.find(e => e.id === 'whisper').upstreamUrl).toContain('/v1.9.1/');
    expect(inputs.find(e => e.id === 'node').upstreamUrl).toContain('v24.13.0');
    // FFmpeg is built from the same 7.1.1 release and the same x264 commit the
    // macOS binary was built from, so the two platforms encode identically.
    expect(inputs.find(e => e.id === 'ffmpeg-source').upstreamUrl).toContain('ffmpeg-7.1.1');
    expect(inputs.find(e => e.id === 'x264-source').gitRevision).toBe(
      '0480cb05fa188d37ae87e8f4fd8f1aea3711f7ee'
    );
  });

  it('compiles FFmpeg from pinned sources instead of trusting a third-party build', () => {
    const ffmpeg = parsed().inputs.find((entry: { id: string }) => entry.id === 'ffmpeg');
    expect(ffmpeg.status).toBe('built');
    expect(ffmpeg.builtFrom).toEqual(['ffmpeg-source', 'x264-source']);
    expect(ffmpeg.sha256).toBeNull();
  });

  it('pins a git source by commit hash rather than a regenerated tarball', () => {
    const x264 = parsed().inputs.find((entry: { id: string }) => entry.id === 'x264-source');
    expect(x264.archiveKind).toBe('git');
    expect(x264.gitRevision).toMatch(/^[a-f0-9]{40}$/u);
  });
});

describe('release readiness rules', () => {
  it('refuses to call a copyleft binary shippable without its source archive', () => {
    const manifest = {
      inputs: [
        { id: 'ffmpeg', status: 'pinned', license: 'GPL-2.0-or-later', sourceArchiveFor: null },
        { id: 'node', status: 'pinned', license: 'MIT', sourceArchiveFor: null }
      ]
    };
    expect(copyleftSourceGaps(manifest)).toEqual(['ffmpeg']);
  });

  it('accepts a copyleft binary once a pinned source archive accompanies it', () => {
    const manifest = {
      inputs: [
        { id: 'ffmpeg', status: 'pinned', license: 'GPL-2.0-or-later', sourceArchiveFor: null },
        {
          id: 'ffmpeg-source',
          status: 'pinned',
          license: 'GPL-2.0-or-later',
          sourceArchiveFor: 'ffmpeg'
        }
      ]
    };
    expect(copyleftSourceGaps(manifest)).toEqual([]);
  });

  it('does not accept a source archive that is itself still pending', () => {
    const manifest = {
      inputs: [
        { id: 'ffmpeg', status: 'pinned', license: 'GPL-2.0-or-later', sourceArchiveFor: null },
        {
          id: 'ffmpeg-source',
          status: 'pending',
          license: 'GPL-2.0-or-later',
          sourceArchiveFor: 'ffmpeg'
        }
      ]
    };
    expect(copyleftSourceGaps(manifest)).toEqual(['ffmpeg']);
  });

  it('reports the manifest as buildable now that every input resolves', () => {
    expect(releaseBlockers(parsed())).toEqual([]);
  });

  it('blocks a built input whose sources are not all pinned', () => {
    const manifest = {
      inputs: [
        {
          id: 'ffmpeg',
          status: 'built',
          builtFrom: ['ffmpeg-source'],
          license: 'GPL-2.0-or-later',
          sourceArchiveFor: null
        },
        {
          id: 'ffmpeg-source',
          status: 'pending',
          license: 'GPL-2.0-or-later',
          sourceArchiveFor: 'ffmpeg'
        }
      ]
    };
    expect(releaseBlockers(manifest)).toContain('ffmpeg');
  });
});

describe('manifest guard rejects malformed input', () => {
  const cases: Array<[string, unknown]> = [
    ['a non-object', 'nope'],
    ['an unknown schema version', { schemaVersion: 99, inputs: [] }],
    ['an empty input list', { schemaVersion: 1, inputs: [] }],
    [
      'a duplicate id',
      {
        schemaVersion: 1,
        inputs: [
          {
            id: 'node',
            status: 'pending',
            archiveKind: 'raw',
            staging: [{ env: 'A_B', memberPath: null }],
            license: 'MIT',
            provenance: 'x',
            sourceArchiveFor: null
          },
          {
            id: 'node',
            status: 'pending',
            archiveKind: 'raw',
            staging: [{ env: 'A_B', memberPath: null }],
            license: 'MIT',
            provenance: 'x',
            sourceArchiveFor: null
          }
        ]
      }
    ],
    [
      'a pinned entry with a short hash',
      {
        schemaVersion: 1,
        inputs: [
          {
            id: 'node',
            status: 'pinned',
            sha256: 'abc',
            sizeBytes: 1,
            upstreamUrl: 'https://example.com/a',
            archiveKind: 'raw',
            staging: [{ env: 'A_B', memberPath: null }],
            license: 'MIT',
            provenance: 'x',
            sourceArchiveFor: null
          }
        ]
      }
    ],
    [
      'a pinned archive without a member path',
      {
        schemaVersion: 1,
        inputs: [
          {
            id: 'node',
            status: 'pinned',
            sha256: 'a'.repeat(64),
            sizeBytes: 1,
            upstreamUrl: 'https://example.com/a.zip',
            archiveKind: 'zip',
            staging: [{ env: 'A_B', memberPath: null }],
            license: 'MIT',
            provenance: 'x',
            sourceArchiveFor: null
          }
        ]
      }
    ],
    [
      'a source archive pointing at an unknown input',
      {
        schemaVersion: 1,
        inputs: [
          {
            id: 'ghost-source',
            status: 'pending',
            archiveKind: 'raw',
            staging: [{ env: 'A_B', memberPath: null }],
            license: 'GPL-2.0-or-later',
            provenance: 'x',
            sourceArchiveFor: 'ghost'
          }
        ]
      }
    ]
  ];

  for (const [label, value] of cases) {
    it(`rejects ${label} with a named reason`, () => {
      const result = parseInputsManifest(value);
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });
  }
});
