import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOG_IMAGE_ERROR_CODES } from '../packages/shared/src/team/catalog-images';
import {
  AUTH_SESSION_MUTATION_CODES,
  PROFILE_SYNC_CODES,
  WORKSPACE_READ_CODES,
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
import { LAUNCH_ANALYTICS_CODES } from '../packages/shared/src/team/launches/lifecycle';

/**
 * 033 FR-008 / T007 — every failure the product can name points at code. A new code in a
 * closed list, a new journal record in the agent, or a new link reason without an entry in
 * `scripts/analytics/code-map.ts` fails here, and so does an entry naming a file that is gone.
 */

const ROOT = join(__dirname, '..');
it('maps an abandoned catalog video handoff to its lease recovery and browser owner', () => {
  const fingerprint = 'team:process:LEASE_EXPIRED';
  expect(lookupCodeLocations(fingerprint)?.matched).toBe(fingerprint);
  expect(lookupCodeLocations(fingerprint)?.files).toContain(
    'supabase/migrations/20261206146000_catalog_expired_browser_handoff.sql'
  );
});
it('maps every bounded workspace read failure', () => {
  for (const code of WORKSPACE_READ_CODES) {
    expect(lookupCodeLocations(`team:read:${code}`)?.files).toContain(
      'apps/web/src/team/readCoordinator.ts'
    );
    expect(lookupCodeLocations(`members:members_list:${code}`)?.matched).toBe(
      `members:members_list:${code}`
    );
  }
});
it('maps every closed profile synchronization failure', () => {
  for (const code of PROFILE_SYNC_CODES)
    expect(lookupCodeLocations(`auth:library:${code}`)?.files).toContain(
      'apps/web/src/auth/AuthContext.tsx'
    );
});
it('maps process output uncertainty to its durable ownership and upload seams', () => {
  const fingerprint = 'process:output:PROCESS_RESULT_UNCERTAIN';
  expect(lookupCodeLocations(fingerprint)?.matched).toBe(fingerprint);
  expect(lookupCodeLocations(fingerprint)?.files).toContain(
    'supabase/migrations/20261206134000_process_upload_ownership.sql'
  );
});
it('maps every catalog image failure to its updater diagnostic location', () => {
  for (const code of CATALOG_IMAGE_ERROR_CODES)
    expect(lookupCodeLocations(`catalog:update:${code}`)?.matched).toBe(`catalog:update:${code}`);
});

it('maps every closed Launch failure to an exact diagnostic code location', () => {
  for (const code of LAUNCH_ANALYTICS_CODES) {
    const fingerprint = `launches:generation:${code}`;
    expect(lookupCodeLocations(fingerprint)?.matched).toBe(fingerprint);
  }
});

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
  it('lists only files that exist under product source roots', () => {
    for (const [key, entry] of Object.entries(CODE_MAP)) {
      expect(entry.files.length, key).toBeGreaterThan(0);
      for (const file of entry.files) {
        expect(file, key).toMatch(
          /^(apps|packages|supabase|packaging\/windows\/SotyAgentHost|packaging)\/[\w.@/-]+$/
        );
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

it('maps every closed browser session mutation failure to its ownership seam', () => {
  for (const code of AUTH_SESSION_MUTATION_CODES) {
    expect(lookupCodeLocations(`auth:library:${code}`)?.matched).toBe(`auth:library:${code}`);
  }
});

it('maps native catalog export and selection budgets to their concrete producers', () => {
  for (const code of ['CATALOG_EXPORT_TOO_LARGE', 'RESTITCH_SCREEN_SELECTION_LIMIT'])
    expect(lookupCodeLocations(`team:download:${code}`)?.matched).toBe(`team:download:${code}`);
});

it('maps an uncertain catalog stop to its guarded database boundary', () => {
  expect(lookupCodeLocations('team:library:CATALOG_UPDATE_RECONCILIATION_REQUIRED')?.matched).toBe(
    'team:library:CATALOG_UPDATE_RECONCILIATION_REQUIRED'
  );
});

it('points native team restitch failures at the actual image preparation origin', () => {
  const entry = lookupCodeLocations('team:process:RESTITCH_SCREEN_FETCH_FAILED');
  expect(entry?.matched).toBe('team:process:RESTITCH_SCREEN_FETCH_FAILED');
  expect(entry?.files).toContain('apps/agent/src/team-bridge/screen-cache.ts');
  expect(entry?.files).toContain('apps/agent/src/team-bridge/restitch.ts');
});

it('maps native source byte refusals to the real downloader before processing', () => {
  for (const stage of ['download', 'process']) {
    const entry = lookupCodeLocations(`team:${stage}:SOURCE_CHANGED`);
    expect(entry?.matched).toBe(`team:${stage}:SOURCE_CHANGED`);
    expect(entry?.files).toContain('apps/agent/src/team-bridge/transfer.ts');
  }
});

it('points unknown restitch admission and claim acknowledgements at their exact readback adapters', () => {
  const entry = lookupCodeLocations('team:download:RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
  expect(entry?.files).toContain('supabase/functions/drive-ops/restitch-root.ts');
  expect(entry?.files).toContain('supabase/functions/drive-ops/restitch-executor.ts');
});
