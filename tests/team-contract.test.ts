import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_INTAKE_MAX_BYTES,
  BROWSER_DOWNLOAD_MAX_BYTES,
  DRIVE_OAUTH_MODES,
  GEO_CODES,
  LANGUAGE_CODES,
  RANGE_REQUEST_MAX_BYTES,
  ROLE_PERMISSIONS,
  TEAM_INVITE_TTL_DAYS,
  TEAM_MAX_ACTIVE_MEMBERS,
  TEAM_PERMISSION_FLAGS,
  TEAM_ACCOUNT_ERROR_CODES,
  TEAM_PROCESS_ERROR_CODES,
  CATALOG_IMAGE_ERROR_CODES,
  TEAM_ERROR_CODES,
  OPERATION_GRANT_TTL_SECONDS,
  TRANSCRIPT_INDEX_MAX_BYTES,
  TRANSFER_GRANT_TTL_SECONDS,
  UPLOAD_CHUNK_MULTIPLE_BYTES,
  classifyMaterial,
  ingestTranscript,
  isTeamPermissionFlag,
  parseDriveOAuthMode,
  parseTeamEdgeResult,
  resolveEffectivePermissions,
  sanitizeTeamAnalyticsProperties,
  TEAM_ANALYTICS_EVENT_NAMES,
  teamBackgroundRenderSupported,
  transcriptEditorEligibility
} from '../packages/shared/src/team/index';
import {
  AGENT_TOOL_CONTRACTS,
  WEB_TOOL_REQUIREMENTS,
  toolContractCompatible
} from '../packages/shared/src/release';

import { createTeamTestDb } from './support/team-db';

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('team contract', () => {
  it('keeps roles, independent overrides, states, limits, and vocabularies canonical', () => {
    expect(TEAM_PERMISSION_FLAGS).toEqual([
      'view',
      'download',
      'upload',
      'edit',
      'delete',
      'process',
      'manage_members',
      'manage_metadata'
    ]);
    expect(ROLE_PERMISSIONS.owner).toEqual(
      Object.fromEntries(TEAM_PERMISSION_FLAGS.map(permission => [permission, true]))
    );
    expect(ROLE_PERMISSIONS.editor.edit).toBe(true);
    expect(ROLE_PERMISSIONS.editor.manage_metadata).toBe(true);
    expect(ROLE_PERMISSIONS.editor.delete).toBe(false);
    expect(ROLE_PERMISSIONS.viewer).toMatchObject({ view: true, download: true, edit: false });

    expect(
      resolveEffectivePermissions('editor', { edit: false, manage_metadata: true })
    ).toMatchObject({ edit: false, manage_metadata: true });
    expect(
      resolveEffectivePermissions('editor', { edit: true, manage_metadata: false })
    ).toMatchObject({ edit: true, manage_metadata: false });
    expect(resolveEffectivePermissions('owner', { view: false })).toEqual(ROLE_PERMISSIONS.owner);
    expect(isTeamPermissionFlag('manage_metadata')).toBe(true);
    expect(isTeamPermissionFlag('replace_root')).toBe(false);

    expect(TEAM_INVITE_TTL_DAYS).toBe(14);
    expect(TEAM_MAX_ACTIVE_MEMBERS).toBe(50);
    expect(TRANSCRIPT_INDEX_MAX_BYTES).toBe(1024 * 1024);
    expect(RANGE_REQUEST_MAX_BYTES).toBe(32 * 1024 * 1024);
    expect(BROWSER_DOWNLOAD_MAX_BYTES).toBe(100 * 1024 * 1024);
    expect(AGENT_INTAKE_MAX_BYTES).toBe(100 * 1024 * 1024 * 1024);
    expect(UPLOAD_CHUNK_MULTIPLE_BYTES).toBe(256 * 1024);
    expect(new Set(GEO_CODES).size).toBe(GEO_CODES.length);
    expect(GEO_CODES).toEqual(expect.arrayContaining(['US', 'UA', 'GB', 'DE']));
    expect(new Set(LANGUAGE_CODES).size).toBe(LANGUAGE_CODES.length);
    expect(LANGUAGE_CODES).toEqual(expect.arrayContaining(['en', 'uk', 'de', 'es']));
  });

  it('parses OAuth mode fail-closed', () => {
    expect(DRIVE_OAUTH_MODES).toEqual(['disabled', 'testing', 'verified']);
    expect(parseDriveOAuthMode(undefined)).toBe('disabled');
    expect(parseDriveOAuthMode('')).toBe('disabled');
    expect(parseDriveOAuthMode('testing')).toBe('testing');
    expect(parseDriveOAuthMode('verified')).toBe('verified');
    expect(parseDriveOAuthMode('enabled')).toBe('disabled');
  });

  it('classifies recognized MIME before extension and promotes only proven landing packages', () => {
    expect(
      classifyMaterial({ kind: 'file', mimeType: 'video/mp4', fileExtension: 'zip' })
    ).toMatchObject({ category: 'video', source: 'mime' });
    expect(
      classifyMaterial({
        kind: 'file',
        mimeType: 'application/octet-stream',
        fileExtension: '.VTT'
      })
    ).toMatchObject({ category: 'transcript', source: 'extension' });
    expect(
      classifyMaterial({
        kind: 'file',
        mimeType: 'application/zip',
        fileExtension: 'zip',
        landingPackageValidated: true
      })
    ).toMatchObject({ category: 'landing', source: 'inspected_landing' });
    expect(classifyMaterial({ kind: 'folder', mimeType: null, fileExtension: null }).category).toBe(
      null
    );
    expect(
      classifyMaterial({ kind: 'shortcut', mimeType: 'video/mp4', fileExtension: 'mp4' }).category
    ).toBe('other');
  });

  it('extracts bounded UTF-8 transcript text and keeps SRT/VTT read-only', () => {
    const bomText = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Привіт')]);
    expect(
      ingestTranscript(bomText, { extension: '.txt', totalBytes: bomText.byteLength })
    ).toEqual(expect.objectContaining({ state: 'full', text: 'Привіт', truncated: false }));

    const multibyte = new TextEncoder().encode(`${'a'.repeat(TRANSCRIPT_INDEX_MAX_BYTES - 1)}💙`);
    const bounded = ingestTranscript(multibyte, { extension: 'txt', totalBytes: multibyte.length });
    expect(bounded.state).toBe('truncated');
    expect(bounded.text?.endsWith('�')).toBe(false);
    expect(bounded.indexedBytes).toBeLessThanOrEqual(TRANSCRIPT_INDEX_MAX_BYTES);

    const srt = new TextEncoder().encode(
      '1\n00:00:00,000 --> 00:00:02,000\n<b>Hello</b>\n\n2\n00:00:02,500 --> 00:00:03,000\nWorld'
    );
    expect(ingestTranscript(srt, { extension: 'srt', totalBytes: srt.length }).text).toBe(
      'Hello\nWorld'
    );
    expect(
      transcriptEditorEligibility({
        extension: 'srt',
        sizeBytes: srt.length,
        ingestState: 'full'
      })
    ).toEqual({ eligible: false, reason: 'unsupported_format' });
    expect(
      transcriptEditorEligibility({
        extension: 'txt',
        sizeBytes: 12,
        ingestState: 'full'
      })
    ).toEqual({ eligible: true });
  });

  it('validates closed Edge results and strips content-identifying analytics fields', () => {
    expect(parseTeamEdgeResult({ ok: true, value: { state: 'connected' } })).toEqual({
      ok: true,
      value: { state: 'connected' }
    });
    expect(
      parseTeamEdgeResult({
        ok: false,
        error: { code: 'PERMISSION_DENIED', retryable: false }
      })
    ).toEqual({
      ok: false,
      error: { code: 'PERMISSION_DENIED', retryable: false }
    });
    expect(parseTeamEdgeResult({ ok: false, error: { code: 'provider said nope' } })).toEqual({
      ok: false,
      error: { code: 'INVALID_RESPONSE', retryable: false }
    });

    expect(
      sanitizeTeamAnalyticsProperties({
        flow_id: 'flow_01',
        duration_ms: 1250,
        category: 'video',
        outcome: 'success',
        email: 'member@example.com',
        filename: 'secret.mp4',
        path: '/private/secret.mp4',
        transcript: 'secret words',
        drive_id: 'provider-id',
        query: 'campaign name'
      })
    ).toEqual({
      flow_id: 'flow_01',
      duration_ms: 1250,
      category: 'video',
      outcome: 'success'
    });
  });

  it('negotiates teamWorkspace independently of existing agent tools', () => {
    expect(AGENT_TOOL_CONTRACTS.teamWorkspace).toBe(2);
    expect(WEB_TOOL_REQUIREMENTS.teamWorkspace).toEqual({ teamWorkspace: 1 });
    expect(toolContractCompatible('teamWorkspace', {})).toBe(false);
    expect(toolContractCompatible('teamWorkspace', { teamWorkspace: 1 })).toBe(true);
    expect(toolContractCompatible('teamWorkspace', { teamWorkspace: 2 })).toBe(true);
    expect(toolContractCompatible('compressor', { compressor: 3, imageEmbedding: 2 })).toBe(true);
  });

  it('keeps the applied error-code seed immutable and verifies the complete additive catalog', async () => {
    const basePath = 'supabase/migrations/20260801090000_team_contract_seed.sql';
    const deltaPath = 'supabase/migrations/20261202143000_account_error_codes.sql';
    const base = readFileSync(basePath, 'utf8');
    const delta = readFileSync(deltaPath, 'utf8');
    const processPath = 'supabase/migrations/20261206139000_process_error_codes.sql';
    const processDelta = readFileSync(processPath, 'utf8');
    const imagePath = 'supabase/migrations/20261206153000_catalog_image_error_codes.sql';
    const imageDelta = readFileSync(imagePath, 'utf8');
    const codes = (sql: string) => {
      const block =
        /insert into public\.team_error_codes \(code\) values\n([\s\S]*?)(?:;\n|\non conflict)/u.exec(
          sql
        )?.[1] ?? '';
      return [...block.matchAll(/\('([^']+)'\)/gu)].map(match => match[1]!);
    };
    expect(codes(delta)).toEqual([...TEAM_ACCOUNT_ERROR_CODES]);
    expect(
      codes(base).filter(code => (TEAM_ACCOUNT_ERROR_CODES as readonly string[]).includes(code))
    ).toEqual([]);
    expect(codes(processDelta)).toEqual([...TEAM_PROCESS_ERROR_CODES]);
    expect(codes(imageDelta)).toEqual([...CATALOG_IMAGE_ERROR_CODES]);
    expect(
      [...codes(base), ...codes(delta), ...codes(processDelta), ...codes(imageDelta)].sort()
    ).toEqual([...TEAM_ERROR_CODES].sort());
    const directory = mkdtempSync(join(tmpdir(), 'wishly-team-contract-delta-'));
    temporaryPaths.push(directory);
    const temporaryBase = join(directory, 'base.sql');
    const temporaryDelta = join(directory, 'delta.sql');
    const temporaryProcess = join(directory, 'process.sql');
    const temporaryImage = join(directory, 'images.sql');
    const rendered = spawnSync(
      process.execPath,
      [
        'scripts/generate-team-contract-sql.mjs',
        '--output',
        temporaryBase,
        '--extension-output',
        temporaryDelta,
        '--process-extension-output',
        temporaryProcess,
        '--image-extension-output',
        temporaryImage
      ],
      { encoding: 'utf8' }
    );
    expect(rendered.status, rendered.stderr).toBe(0);
    expect(readFileSync(temporaryBase, 'utf8')).toBe(base);
    expect(readFileSync(temporaryDelta, 'utf8')).toBe(delta);
    expect(readFileSync(temporaryProcess, 'utf8')).toBe(processDelta);
    expect(readFileSync(temporaryImage, 'utf8')).toBe(imageDelta);
    expect(readFileSync(imagePath, 'utf8')).toBe(imageDelta);
    expect(readFileSync(basePath, 'utf8')).toBe(base);
    expect(readFileSync(processPath, 'utf8')).toBe(processDelta);
    writeFileSync(temporaryDelta, delta.replaceAll('\n', '\r\n'));
    expect(
      spawnSync(
        process.execPath,
        ['scripts/generate-team-contract-sql.mjs', '--check', '--extension-output', temporaryDelta],
        { encoding: 'utf8' }
      ).status
    ).toBe(0);
    writeFileSync(temporaryDelta, delta.replace('ACCOUNT_ARCHIVED', 'STALE_ACCOUNT_ARCHIVED'));
    const stale = spawnSync(
      process.execPath,
      ['scripts/generate-team-contract-sql.mjs', '--check', '--extension-output', temporaryDelta],
      { encoding: 'utf8' }
    );
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toContain('out of date');
    writeFileSync(
      temporaryProcess,
      processDelta.replace('PROCESS_RESULT_UNCERTAIN', 'STALE_PROCESS_RESULT')
    );
    const staleProcess = spawnSync(
      process.execPath,
      [
        'scripts/generate-team-contract-sql.mjs',
        '--check',
        '--process-extension-output',
        temporaryProcess
      ],
      { encoding: 'utf8' }
    );
    expect(staleProcess.status).not.toBe(0);
    expect(staleProcess.stderr).toContain('out of date');
    writeFileSync(temporaryImage, imageDelta.replace('IMAGE_TOO_LARGE', 'STALE_IMAGE_TOO_LARGE'));
    const staleImage = spawnSync(
      process.execPath,
      [
        'scripts/generate-team-contract-sql.mjs',
        '--check',
        '--image-extension-output',
        temporaryImage
      ],
      { encoding: 'utf8' }
    );
    expect(staleImage.status).not.toBe(0);
    expect(staleImage.stderr).toContain('out of date');
    const db = await createTeamTestDb();
    try {
      const catalog = await db.root<{ code: string }>(
        'select code from public.team_error_codes order by code'
      );
      expect(catalog.map(row => row.code)).toEqual(expect.arrayContaining([...TEAM_ERROR_CODES]));
      expect(
        catalog
          .map(row => row.code)
          .filter(code => (TEAM_ACCOUNT_ERROR_CODES as readonly string[]).includes(code))
      ).toEqual([...TEAM_ACCOUNT_ERROR_CODES].sort());
    } finally {
      await db.close();
    }
  }, 60000);

  it('keeps the committed SQL current and detects stale output', () => {
    // The npm script is what guarantees `shared` is rebuilt before the contract is read,
    // so the generator never validates against a stale dist. Assert the wiring; do not
    // run it.
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['generate:team-contract']).toBe(
      'npm run build -w @video-compressor/shared && node scripts/generate-team-contract-sql.mjs'
    );

    // This used to run `npm run generate:team-contract` and then the same script with
    // `--check`. Two things were wrong with that. It rewrote a tracked migration and
    // rebuilt `packages/shared/dist` in the middle of a suite run, so every other gate
    // was reading artefacts this test had just changed underneath them. And regenerating
    // immediately before checking made the check vacuous — it could never detect the
    // staleness it was written to detect.
    //
    // Checking the committed file directly is both non-destructive and the assertion the
    // test claims to make. `npm test` builds shared first, so the contract read here is
    // current.
    const committed = spawnSync(
      process.execPath,
      ['scripts/generate-team-contract-sql.mjs', '--check'],
      { encoding: 'utf8' }
    );
    expect(
      committed.status,
      `The committed team contract SQL is out of date. Run \`npm run generate:team-contract\`.\n${committed.stderr}`
    ).toBe(0);

    const fixture = mkdtempSync(join(tmpdir(), 'wishly-team-contract-'));
    temporaryPaths.push(fixture);
    const generated = readFileSync(
      'supabase/migrations/20260801090000_team_contract_seed.sql',
      'utf8'
    );
    const stalePath = join(fixture, 'team_contract_seed.sql');
    const crlfPath = join(fixture, 'team_contract_seed_crlf.sql');
    writeFileSync(crlfPath, generated.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'));
    const crlf = spawnSync(
      process.execPath,
      ['scripts/generate-team-contract-sql.mjs', '--check', '--output', crlfPath],
      { encoding: 'utf8' }
    );
    expect(crlf.status, crlf.stderr).toBe(0);

    writeFileSync(stalePath, generated.replace('team_contract_version', 'stale_contract_version'));
    const result = spawnSync(
      process.execPath,
      ['scripts/generate-team-contract-sql.mjs', '--check', '--output', stalePath],
      { encoding: 'utf8' }
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('out of date');
  }, 60_000);
});

describe('011 — storage analytics and the background-render contract', () => {
  it('sanitizes the storage lifecycle counters and attention reason', () => {
    expect(
      sanitizeTeamAnalyticsProperties({
        selection_count: 2,
        folder_count: 37,
        file_count: 1240,
        unavailable_count: 3,
        ready_count: 1000,
        attention_reason: 'root_missing',
        duration_ms: 4200.4,
        folder_id: 'must-not-pass'
      })
    ).toEqual({
      selection_count: 2,
      folder_count: 37,
      file_count: 1240,
      unavailable_count: 3,
      ready_count: 1000,
      attention_reason: 'root_missing',
      duration_ms: 4200
    });
    expect(sanitizeTeamAnalyticsProperties({ attention_reason: 'password' })).toEqual({});
    expect(sanitizeTeamAnalyticsProperties({ file_count: -1, folder_count: 1.5 })).toEqual({});
  });

  it('registers the four storage lifecycle events', () => {
    for (const name of [
      'team_storage_connected',
      'team_index_completed',
      'team_previews_ready',
      'team_storage_attention'
    ]) {
      expect(TEAM_ANALYTICS_EVENT_NAMES).toContain(name);
    }
  });

  it('detects background rendering from the contract, never from the tool page map', () => {
    expect(AGENT_TOOL_CONTRACTS.teamBackgroundRender).toBe(1);
    expect('teamBackgroundRender' in WEB_TOOL_REQUIREMENTS).toBe(false);
    expect(teamBackgroundRenderSupported({ teamWorkspace: 2 })).toBe(false);
    expect(teamBackgroundRenderSupported({ teamWorkspace: 2, teamBackgroundRender: 1 })).toBe(true);
    expect(teamBackgroundRenderSupported(null)).toBe(false);
    // Legacy negotiation is untouched by the new key.
    expect(toolContractCompatible('teamWorkspace', { teamWorkspace: 1 })).toBe(true);
  });
});

describe("an operation's grants outlive the work they authorize", () => {
  it('accepts the space root as a process output destination while binding it to the operation', () => {
    const source = readFileSync('supabase/functions/drive-ops/index.ts', 'utf8');
    const handler = source.slice(
      source.indexOf('async function handleProcessOutputStart'),
      source.indexOf('async function handleProcessOutputStart') + 2200
    );
    expect(handler).not.toContain('!grant.destinationFolderId');
    expect(handler).toContain('grant.operationId !== operationId');
    expect(handler).toContain('operation.destinationFolderId !== grant.destinationFolderId');
    expect(handler).toContain('destinationFolderId: grant.destinationFolderId');
    expect(handler).toContain("permission: 'process'");
  });
  it('keeps a running operation usable for as long as the agent may take', () => {
    // A three-minute video took eight minutes to transcribe on the beta; a
    // forty-minute one on a throttled machine takes an hour. The transfer TTL
    // is for a transfer that starts at once, and every run longer than it
    // reached its upload with an expired ticket — the work finished and was
    // thrown away with PERMISSION_DENIED.
    expect(TRANSFER_GRANT_TTL_SECONDS).toBe(10 * 60);
    expect(OPERATION_GRANT_TTL_SECONDS).toBeGreaterThanOrEqual(60 * 60);
  });

  it('mints both process grants with that ttl', () => {
    // Read from the function's own source: there is no other way to hold a
    // Deno edge handler to this from here, and the failure it prevents is
    // silent — a completed transcription that never becomes a file.
    const source = readFileSync('supabase/functions/drive-ops/index.ts', 'utf8');
    const start = source.slice(source.indexOf('async function handleProcessStart'));
    const grants = start.slice(0, start.indexOf('return {'));
    const withOperationTtl = grants.match(/ttlSeconds:\s*OPERATION_GRANT_TTL_SECONDS/gu) ?? [];
    expect(withOperationTtl).toHaveLength(2);
    expect(grants).toMatch(/const ranges = Math\.ceil\([\s\S]*?\) \+ 8;/u);
    // Upload start consumes one use; three attempts of the same bound finalize must fit.
    const finalize = grants.slice(grants.indexOf("purpose: 'finalize'"));
    expect(finalize).toMatch(/maxUses:\s*4/u);
    for (const binding of [
      'operationId: authority.operationId',
      'teamId',
      'actorId',
      'materialId',
      'destinationFolderId',
      'toolId'
    ]) {
      expect(finalize).toContain(binding);
    }
  });
});

describe('edge functions import narrow shared modules, never the barrel', () => {
  /** Every `.ts` under supabase/functions, at any depth. */
  function functionSources(directory: string): string[] {
    return readdirSync(directory).flatMap(entry => {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) return functionSources(full);
      return entry.endsWith('.ts') ? [full] : [];
    });
  }

  it('never imports packages/shared/dist/types.js', () => {
    // The local Supabase stack bind-mounts one file per module in a function's
    // import graph, resolved when the stack starts. `types.js` re-exports the
    // whole shared package, so adding any new shared module (the stitcher's, in
    // 014) put a file in that graph which no running stack had mounted: every
    // drive-ops call answered 503 BOOT_ERROR — "the server answered
    // unexpectedly" in team mode — until someone restarted the stack. Functions
    // import the `team/*` module they actually need instead.
    const offenders = functionSources('supabase/functions').filter(file =>
      /from\s+'[^']*shared\/dist\/types\.js'/u.test(readFileSync(file, 'utf8'))
    );
    expect(offenders).toEqual([]);
  });
});
