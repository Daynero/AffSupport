#!/usr/bin/env node
import { readFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendExecution } from './records.mjs';
import { validateLocalTarget } from './target.mjs';
import { preflightLocal } from './preflight.mjs';
import { provisionLocalFixtures } from './fixtures.mjs';
import { provisionLocalVariants } from './variants.mjs';
import { clearLocalFixtures } from './cleanup.mjs';
import { runTariffSmoke } from './tariff-smoke.mjs';
import { runLocalSmoke } from './local-smoke.mjs';
import { calibrateLocal } from './calibrate.mjs';
import { calibrateRealtimeLocal } from './realtime-calibrate.mjs';
import { prepareMediaFixtures } from './media-fixtures.mjs';
import { runLocalDiagnosis } from './diagnostics.mjs';
import { prepareLoginPage } from './login-page.mjs';
import { validateManifest } from './schema.mjs';
import { buildReport } from './report.mjs';
import { changeLocalTariffClock, parseClockAction } from './clock.mjs';
import { captureLocalTariffNotices } from './mail-capture.mjs';
import { changeLocalFaultJournal } from './faults.mjs';
import {
  openLocalResourceSampler,
  readLocalResourceSample,
  closeLocalResourceSampler
} from './local-resources.mjs';

const args = process.argv.slice(2);
const command = args[0] ?? null;
function output(ok, data, code) {
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      command,
      ok,
      ...(ok ? { data } : { error: { code }, ...(data ? { data } : {}) })
    }) + '\n'
  );
  if (!ok) process.exitCode = 1;
}
async function json(file) {
  if ((await stat(file)).size > 1024 * 1024) throw new Error('ACCEPTANCE_INPUT_TOO_LARGE');
  return JSON.parse(await readFile(file, 'utf8'));
}
try {
  if (command === 'validate-target' && args.length === 2 && !args[1].startsWith('--')) {
    const result = validateLocalTarget(await json(args[1]));
    output(
      result.ok,
      { configurationOnly: true, liveIdentityVerified: false },
      result.ok ? undefined : 'ACCEPTANCE_TARGET_UNSAFE'
    );
  } else if (command === 'resources' && args.length === 2 && !args[1].startsWith('--')) {
    const handle = await openLocalResourceSampler(await json(args[1]), { maxSamples: 2 });
    try {
      const first = await readLocalResourceSample(handle);
      await new Promise(resolve => setTimeout(resolve, 1500));
      const second = await readLocalResourceSample(handle);
      output(true, {
        scope: 'local-resource-observation',
        samples: [first, second],
        hostedCapacityVerified: false,
        fullAcceptanceBinding: false
      });
    } finally {
      closeLocalResourceSampler(handle);
    }
  } else if (
    command === 'faults' &&
    args.length === 3 &&
    args.slice(1).every(value => !value.startsWith('--'))
  ) {
    const result = await changeLocalFaultJournal(await json(args[1]), await json(args[2]));
    output(result.ok, result, result.ok ? undefined : result.code);
  } else if (command === 'mail-capture' && args.length === 2 && !args[1].startsWith('--')) {
    const result = await captureLocalTariffNotices(await json(args[1]));
    output(result.ok, result, result.ok ? undefined : result.code);
  } else if (
    command === 'fixture' &&
    args[1] === 'clock' &&
    typeof args[2] === 'string' &&
    !args[2].startsWith('--') &&
    parseClockAction(args.slice(3))
  ) {
    const result = await changeLocalTariffClock(
      await json(args[2]),
      parseClockAction(args.slice(3))
    );
    output(result.ok, result, result.ok ? undefined : result.code);
  } else if (
    command === 'fixture' &&
    args[1] === 'clear' &&
    [3, 4].includes(args.length) &&
    !args[2].startsWith('--') &&
    (args.length === 3 || args[3] === '--dry-run')
  ) {
    const result = await clearLocalFixtures(await json(args[2]), {
      dryRun: args[3] === '--dry-run'
    });
    output(result.ok, result, 'ACCEPTANCE_CLEANUP_UNSAFE');
  } else if (
    command === 'fixture' &&
    args[1] === 'variants' &&
    args.length === 3 &&
    !args[2].startsWith('--')
  ) {
    output(true, await provisionLocalVariants(await json(args[2])));
  } else if (
    command === 'record' &&
    args.length === 4 &&
    args.slice(1).every(value => !value.startsWith('--'))
  ) {
    const context = await json(args[2]);
    const record = await json(args[3]);
    if (!validateManifest(context).ok) throw new Error('ACCEPTANCE_MANIFEST_INVALID');
    const expected = path.resolve(
      fileURLToPath(new URL('../../release/acceptance/', import.meta.url)),
      context.campaignId
    );
    if (path.resolve(args[1]) !== expected || (await realpath(args[1])) !== expected)
      throw new Error('ACCEPTANCE_RECORD_PATH_UNSAFE');
    const result = await appendExecution(args[1], record, context);
    output(true, result);
  } else if (
    command === 'report' &&
    args.length === 3 &&
    args.slice(1).every(value => !value.startsWith('--'))
  ) {
    output(true, await buildReport(args[1], await json(args[2])));
  } else if (
    command === 'calibrate-realtime' &&
    [2, 3].includes(args.length) &&
    !args[1].startsWith('--') &&
    (args.length === 2 || ['steady', 'burst'].includes(args[2]))
  ) {
    const result = await calibrateRealtimeLocal(await json(args[1]), args[2] ?? 'steady');
    output(result.ok, result, 'ACCEPTANCE_REALTIME_CALIBRATION_FAILED');
  } else if (command === 'calibrate' && args.length === 2 && !args[1].startsWith('--')) {
    output(true, await calibrateLocal(await json(args[1])));
  } else if (command === 'media' && args.length === 2 && !args[1].startsWith('--')) {
    output(true, await prepareMediaFixtures(await json(args[1])));
  } else if (
    command === 'diagnose' &&
    [3, 4].includes(args.length) &&
    args.slice(1).every(value => !value.startsWith('--'))
  ) {
    output(true, await runLocalDiagnosis(await json(args[1]), args[2], args[3]));
  } else if (command === 'preflight' && args.length === 2 && !args[1].startsWith('--')) {
    const result = await preflightLocal(await json(args[1]));
    output(result.ok, result, 'ACCEPTANCE_PREFLIGHT_FAILED');
  } else if (
    command === 'fixture' &&
    args[1] === 'apply' &&
    args.length === 3 &&
    !args[2].startsWith('--')
  ) {
    const fixture = await provisionLocalFixtures(await json(args[2]));
    output(true, {
      namespace: fixture.state.namespace,
      actors: Object.keys(fixture.actors),
      teams: fixture.state.teams
    });
  } else if (command === 'smoke' && args.length === 2 && !args[1].startsWith('--')) {
    const result = await runLocalSmoke(await json(args[1]));
    output(result.ok, result, 'ACCEPTANCE_SMOKE_FAILED');
  } else if (command === 'tariff-smoke' && args.length === 2 && !args[1].startsWith('--')) {
    const result = await runTariffSmoke(await json(args[1]));
    output(result.ok, result, 'ACCEPTANCE_SMOKE_FAILED');
  } else if (command === 'login-page' && args.length === 2 && !args[1].startsWith('--')) {
    output(true, await prepareLoginPage(await json(args[1])));
  } else {
    output(false, null, 'ACCEPTANCE_USAGE');
  }
} catch (error) {
  const allowed = new Set([
    'ACCEPTANCE_RESOURCE_HANDLE_INVALID',
    'ACCEPTANCE_RESOURCE_BINDING_FAILED',
    'ACCEPTANCE_RESOURCE_READ_FAILED',
    'ACCEPTANCE_RESOURCE_OPTIONS_INVALID',
    'ACCEPTANCE_RESOURCE_CLOSED',
    'ACCEPTANCE_RESOURCE_EXPIRED',
    'ACCEPTANCE_RESOURCE_BUSY',
    'ACCEPTANCE_RESOURCE_INTERVAL',
    'ACCEPTANCE_RESOURCE_LIMIT',
    'ACCEPTANCE_DELIVERY_INVALID',
    'ACCEPTANCE_REALTIME_UNAVAILABLE',
    'ACCEPTANCE_REALTIME_CALIBRATION_FAILED',
    'ACCEPTANCE_FIXTURE_BUSY',
    'ACCEPTANCE_FIXTURE_CLEANUP_PENDING',
    'ACCEPTANCE_CLEANUP_RECEIPT_INVALID',
    'ACCEPTANCE_CLEANUP_IDENTITY_MISMATCH',
    'ACCEPTANCE_CLEANUP_READER_UNOWNED',
    'ACCEPTANCE_CLEANUP_SCOPE_CHANGED',
    'ACCEPTANCE_CLEANUP_AUTH_PENDING',
    'ACCEPTANCE_CLEANUP_SCAN_LIMIT',
    'ACCEPTANCE_CLEANUP_SCHEMA_UNKNOWN',
    'ACCEPTANCE_VARIANT_INVALID',
    'ACCEPTANCE_VARIANT_PRECONDITION',
    'ACCEPTANCE_VARIANT_STATE_CHANGED',
    'ACCEPTANCE_PRIVATE_STATE_INVALID',
    'ACCEPTANCE_PRIVATE_STATE_UNSAFE',
    'ACCEPTANCE_CALIBRATION_FAILED',
    'ACCEPTANCE_LOAD_CONFIG_INVALID',
    'ACCEPTANCE_DIAGNOSTIC_COMMAND_INVALID',
    'ACCEPTANCE_DIAGNOSTIC_FAILED',
    'ACCEPTANCE_READER_INVALID',
    'ACCEPTANCE_READER_UNSAFE',
    'ACCEPTANCE_READER_BASE_UNSAFE',
    'ACCEPTANCE_MEDIA_FIXTURE_MISMATCH',
    'ACCEPTANCE_MEDIA_GENERATION_FAILED',
    'ACCEPTANCE_ACTOR_INVALID',
    'ACCEPTANCE_PREFLIGHT_FAILED',
    'ACCEPTANCE_TARIFF_PAUSE_FAILED',
    'ACCEPTANCE_TARIFF_RESTORE_FAILED',
    'ACCEPTANCE_INPUT_TOO_LARGE',
    'ACCEPTANCE_MANIFEST_INVALID',
    'ACCEPTANCE_MANIFEST_PATH_UNSAFE',
    'ACCEPTANCE_MANIFEST_MISMATCH',
    'ACCEPTANCE_MANIFEST_UNFROZEN',
    'ACCEPTANCE_MANIFEST_PUBLISH_FAILED',
    'ACCEPTANCE_RESULT_AMBIGUOUS',
    'ACCEPTANCE_SUPERSESSION_INVALID',
    'ACCEPTANCE_RECORD_LIMIT',
    'ACCEPTANCE_RECORD_INVALID',
    'ACCEPTANCE_RUN_EXISTS',
    'ACCEPTANCE_EVIDENCE_UNSAFE',
    'ACCEPTANCE_EVIDENCE_MISMATCH',
    'ACCEPTANCE_RECORD_PATH_UNSAFE',
    'ACCEPTANCE_TARGET_UNSAFE',
    'ACCEPTANCE_FIXTURE_MISMATCH',
    'ACCEPTANCE_BETA_PROFILE_UNSAFE',
    'ACCEPTANCE_STACK_MISMATCH',
    'ACCEPTANCE_STACK_STATUS_FAILED',
    'ACCEPTANCE_AUTH_DATABASE_MISMATCH',
    'ACCEPTANCE_AUTH_UNAVAILABLE',
    'ACCEPTANCE_AUTH_CREATE_FAILED',
    'ACCEPTANCE_ACTOR_PRIVILEGED',
    'ACCEPTANCE_ACTOR_LOGIN_FAILED',
    'ACCEPTANCE_TARIFF_GRANT_FAILED',
    'ACCEPTANCE_TEAM_CREATE_FAILED'
  ]);
  const code =
    error instanceof Error && allowed.has(error.message)
      ? error.message
      : 'ACCEPTANCE_INPUT_FAILED';
  output(false, null, code);
}
