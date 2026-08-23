import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const START = readFileSync('scripts/beta-up.mjs', 'utf8');
const DOCTOR = readFileSync('scripts/verify-beta-env.mjs', 'utf8');

describe('beta startup flow', () => {
  it('starts an installed Colima runtime before running the doctor', () => {
    expect(START.indexOf("spawnSync('colima', ['start']")).toBeGreaterThan(-1);
    expect(START.indexOf("spawnSync('colima', ['start']")).toBeLessThan(
      START.indexOf("['scripts/verify-beta-env.mjs']")
    );
  });

  it('serves source beta through the pinned web workspace', () => {
    expect(START).toContain("['run', 'dev:beta', '--workspace', '@video-compressor/web']");
    expect(START).not.toContain("start('web', 'npx'");
  });

  it('pairs the source agent back to the Vite beta origin', () => {
    expect(START).toContain('PUBLIC_SITE_ORIGIN: profile.VITE_SITE_URL');
  });

  it('feeds the local Functions environment to the Supabase runtime', () => {
    expect(START).toContain("const functionsLocalEnv = 'supabase/functions/.env.local'");
    expect(START).toContain("const functionsRuntimeEnv = 'supabase/functions/.env'");
    expect(DOCTOR).toContain('AGENT_TOKEN_PRIVATE_KEY');
    expect(DOCTOR).toContain('functionsEnv.WISHLY_SITE_URL !== profile.VITE_SITE_URL');
  });

  it('proves the edge runtime is serving before it reports beta up', () => {
    // `supabase start` exits 0 even after giving up on an unhealthy service. If
    // that service is the edge runtime, every server-side team feature answers
    // 503 while beta still says it is up -- the product looks broken rather
    // than unstarted, which is the one outcome a verification environment must
    // never produce.
    expect(START).toContain('await requireEdgeFunctions()');
    expect(START.indexOf("spawnSync('npx', ['supabase', 'start']")).toBeLessThan(
      START.indexOf('await requireEdgeFunctions()')
    );
    expect(START.indexOf('await requireEdgeFunctions()')).toBeLessThan(
      START.indexOf('Beta is up.')
    );
  });

  it('treats an unreachable runtime as not serving, and restarts it once', () => {
    // 503 is Kong reporting it cannot reach the runtime; a thrown fetch is the
    // container being gone outright. Both must read as "not serving".
    expect(START).toContain('response.status !== 503');
    expect(START).toContain(
      "spawnSync('docker', ['start', `supabase_edge_runtime_${projectId()}`]"
    );
    expect(START).toContain('function projectId()');
  });

  it('requires the source transcription binary', () => {
    expect(DOCTOR).toContain('brew install whisper-cpp');
  });
});
