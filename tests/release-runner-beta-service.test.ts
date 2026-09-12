import { expect, it } from 'vitest';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { betaStopPolicy } from '../scripts/lib/release/beta-service.mjs';
import {
  digestOf,
  readResidentReservations,
  residentBetaReservation,
  restorableEnv
} from '../scripts/lib/release/adapters/beta.mjs';

it('never stops a beta listener unless it matches the recorded owned child', () => {
  const record = {
    schemaVersion: 1,
    stackStarted: true,
    agentPid: 11,
    webPid: 12,
    ports: [43140, 5175]
  };
  expect(
    betaStopPolicy(record, { 43140: [11], 5175: [12] }, { agentPort: 43140, webPort: 5175 })
  ).toEqual({ ok: true });
  expect(
    betaStopPolicy(record, { 43140: [99] }, { agentPort: 43140, webPort: 5175 })
  ).toMatchObject({ ok: false, code: 'BETA_SERVICE_BORROWED' });
  expect(betaStopPolicy(null, {}, { agentPort: 43140, webPort: 5175 })).toMatchObject({
    ok: false
  });
});

it('claims the stack as a standing reservation without double-counting resident memory', async () => {
  const { default: profile } = JSON.parse(
    await readFile('config/release-resource-profiles.json', 'utf8')
  );
  expect(residentBetaReservation(profile)).toEqual({
    ramBytes: profile.classes.beta_stack.ramBytes,
    diskBytes: profile.classes.beta_stack.diskBytes
  });
  // The probe already subtracts what the stack occupies; only possible growth
  // is still owed to it.
  expect(residentBetaReservation(profile, { residentBytes: 2e9 }).ramBytes).toBe(
    profile.classes.beta_stack.ramBytes - 2e9
  );

  const directory = await mkdtemp(join(tmpdir(), 'beta-reservations-'));
  try {
    await writeFile(
      join(directory, 'beta-service.json'),
      JSON.stringify({
        schemaVersion: 1,
        stackStarted: true,
        reservation: { ramBytes: 3e9, diskBytes: 8e9 }
      })
    );
    expect(await readResidentReservations(directory)).toEqual({ ramBytes: 3e9, diskBytes: 8e9 });
    // Somebody else's beta, or none at all, claims nothing on our behalf.
    expect(await readResidentReservations(join(directory, 'missing'))).toEqual({
      ramBytes: 0,
      diskBytes: 0
    });
  } finally {
    await removeTemporaryDirectory(directory);
  }
});

it('restores only the environment content beta itself wrote and left untouched', () => {
  const written = Buffer.from('SUPABASE_KEY=beta\n');
  const digest = digestOf(written);
  expect(restorableEnv({ writtenDigest: digest, currentContent: written })).toEqual({ ok: true });
  expect(
    restorableEnv({ writtenDigest: digest, currentContent: Buffer.from('EDITED=1\n') })
  ).toMatchObject({ ok: false, code: 'ENV_MODIFIED_EXTERNALLY' });
  expect(restorableEnv({ writtenDigest: digest, currentContent: null })).toMatchObject({
    ok: false,
    code: 'ENV_MISSING'
  });
  expect(restorableEnv({ writtenDigest: '', currentContent: written })).toMatchObject({
    ok: false,
    code: 'ENV_PROVENANCE_UNKNOWN'
  });
});
