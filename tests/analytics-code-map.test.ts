import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMPRESSION_ERROR_CODES,
  DIAGNOSTIC_CATEGORIES,
  ESTIMATE_ERROR_CODES,
  LANDING_ERROR_CODES,
  STITCH_ERROR_CODES,
  TRANSCRIPTION_ERROR_CODES
} from '../packages/shared/src/types';
import { LINK_REASONS, READINESS_STAGES } from '../apps/web/src/analytics/events';
import {
  landingErrorStage,
  stitchErrorStage,
  transcriptionErrorStage
} from '../apps/web/src/analytics/errors';
import { compressionErrorStage } from '../apps/web/src/analytics/compression';
import { CODE_MAP, lookupCodeLocations } from '../scripts/analytics/code-map';

/**
 * 033 FR-008 / T007 — every failure the product can name points at code. A new code in a
 * closed list, a new journal record in the agent, or a new link reason without an entry in
 * `scripts/analytics/code-map.ts` fails here, and so does an entry naming a file that is gone.
 */

const ROOT = join(__dirname, '..');

function fingerprintsOf(tool: string, codes: readonly string[], stage: (code: string) => string) {
  return codes.map(code => `${tool}:${stage(code)}:${code}`);
}

function agentSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...agentSources(path));
    else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(path);
  }
  return out;
}

/** Every literal (category, code) pair handed to a journal `record(...)` in the agent. */
function journalPairsInAgent(): Array<{ pair: string; file: string }> {
  const categories = DIAGNOSTIC_CATEGORIES.join('|');
  const call = new RegExp(`\\brecord\\(\\s*'(${categories})'\\s*,\\s*([^,)]+)`, 'g');
  const pairs: Array<{ pair: string; file: string }> = [];
  for (const file of agentSources(join(ROOT, 'apps/agent/src'))) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(call)) {
      // A ternary names both codes; an identifier (a typed union) is covered by its literals.
      for (const literal of match[2].matchAll(/'([a-z][a-z0-9_]{1,63})'/g)) {
        pairs.push({ pair: `${match[1]}:${literal[1]}`, file: relative(ROOT, file) });
      }
    }
  }
  return pairs;
}

describe('code map · completeness', () => {
  it('has an entry for every code of every closed list, at the web stage', () => {
    const expected = [
      ...fingerprintsOf('compressor', COMPRESSION_ERROR_CODES, compressionErrorStage),
      ...fingerprintsOf('compressor', ESTIMATE_ERROR_CODES, () => 'estimate'),
      ...fingerprintsOf('transcription', TRANSCRIPTION_ERROR_CODES, transcriptionErrorStage),
      ...fingerprintsOf('stitcher', STITCH_ERROR_CODES, stitchErrorStage),
      ...fingerprintsOf('landing-optimizer', LANDING_ERROR_CODES, landingErrorStage)
    ];
    const missing = expected.filter(fingerprint => !CODE_MAP[fingerprint]);
    expect(missing).toEqual([]);
    expect(expected.length).toBeGreaterThan(60);
  });

  it('has no closed-list entry the web would never send (stage drift)', () => {
    const stageOf: Record<string, (code: string) => string> = {
      transcription: transcriptionErrorStage,
      stitcher: stitchErrorStage,
      'landing-optimizer': landingErrorStage
    };
    for (const key of Object.keys(CODE_MAP)) {
      const [tool, , code] = key.split(':');
      if (code === undefined || code === '*' || !stageOf[tool]) continue;
      expect(`${tool}:${stageOf[tool](code)}:${code}`).toBe(key);
    }
    for (const key of Object.keys(CODE_MAP).filter(key => key.startsWith('compressor:'))) {
      const [, stage, code] = key.split(':');
      if (code === undefined || code === '*') continue;
      if (stage === 'estimate') expect(ESTIMATE_ERROR_CODES).toContain(code);
      else expect(compressionErrorStage(code)).toBe(stage);
    }
  });

  it('has an entry for every journal record the agent writes', () => {
    const pairs = journalPairsInAgent();
    // The scan must find the writers, or it proves nothing.
    expect(pairs.length).toBeGreaterThan(20);
    expect(pairs.map(p => p.pair)).toEqual(
      expect.arrayContaining([
        'spawn:exited',
        'picker:exit',
        'auth:token_mismatch',
        'auth:limiter_hit'
      ])
    );
    const missing = pairs.filter(({ pair }) => !CODE_MAP[`journal:${pair}`]);
    expect(missing).toEqual([]);
  });

  it('points every journal category, link reason and readiness stage somewhere', () => {
    for (const category of DIAGNOSTIC_CATEGORIES) {
      expect(CODE_MAP[`journal:${category}:*`], category).toBeDefined();
    }
    for (const reason of LINK_REASONS) {
      expect(CODE_MAP[`link:${reason}`], reason).toBeDefined();
    }
    for (const stage of READINESS_STAGES) {
      expect(lookupCodeLocations(`readiness:${stage}:CONNECTION_FAILED`)?.matched).toBe(
        `readiness:${stage}:*`
      );
    }
    for (const stage of ['transfer', 'process', 'download', 'library']) {
      expect(CODE_MAP[`team:${stage}:*`], stage).toBeDefined();
    }
  });
});

describe('code map · files', () => {
  it('lists only files that exist under apps, packages or supabase', () => {
    for (const [key, entry] of Object.entries(CODE_MAP)) {
      expect(entry.files.length, key).toBeGreaterThan(0);
      for (const file of entry.files) {
        expect(file, key).toMatch(/^(apps|packages|supabase)\/[\w.@/-]+$/);
        expect(file, key).not.toContain('..');
        expect(existsSync(join(ROOT, file)), `${key} → ${file}`).toBe(true);
      }
    }
  });

  it('keeps check sentences printable: no path, address or credential word', () => {
    for (const [key, entry] of Object.entries(CODE_MAP)) {
      expect(entry.check.length, key).toBeGreaterThan(10);
      expect(entry.check, key).not.toMatch(/[/\\@]|:\/\/|token|bearer/i);
    }
  });
});

describe('lookupCodeLocations', () => {
  it('returns the exact entry first', () => {
    const hit = lookupCodeLocations('transcription:model:MODEL_MISSING');
    expect(hit?.matched).toBe('transcription:model:MODEL_MISSING');
    expect(hit?.files).toContain('apps/agent/src/queue/transcription-queue.ts');
    expect(hit?.files).toContain('apps/web/src/analytics/errors.ts');
  });

  it('falls back to the stage, then to the tool', () => {
    expect(lookupCodeLocations('stitcher:picker:unknown')?.matched).toBe('stitcher:picker:*');
    expect(lookupCodeLocations('stitcher:stitch:unknown')?.matched).toBe('stitcher:*');
    expect(lookupCodeLocations('journal:power:throttled')?.matched).toBe('journal:power:*');
    expect(lookupCodeLocations('link:something_new')?.matched).toBe('link:*');
    expect(lookupCodeLocations('nothing')).toBeNull();
  });

  it('returns a copy, never the shared entry', () => {
    const hit = lookupCodeLocations('link:timeout');
    hit?.files.push('mutated');
    expect(CODE_MAP['link:timeout'].files).not.toContain('mutated');
  });
});
