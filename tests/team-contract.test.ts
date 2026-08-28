import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  TRANSCRIPT_INDEX_MAX_BYTES,
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
