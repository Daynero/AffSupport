import { execFileSync, spawnSync } from 'node:child_process';
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

  it('rebuilds shared before checking generated SQL and detects stale output', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['generate:team-contract']).toBe(
      'npm run build -w @video-compressor/shared && node scripts/generate-team-contract-sql.mjs'
    );

    execFileSync('npm', ['run', 'generate:team-contract'], { stdio: 'pipe' });
    execFileSync('npm', ['run', 'generate:team-contract', '--', '--check'], { stdio: 'pipe' });

    const fixture = mkdtempSync(join(tmpdir(), 'wishly-team-contract-'));
    temporaryPaths.push(fixture);
    const generated = readFileSync(
      'supabase/migrations/20260801090000_team_contract_seed.sql',
      'utf8'
    );
    const stalePath = join(fixture, 'team_contract_seed.sql');
    writeFileSync(stalePath, generated.replace('team_contract_version', 'stale_contract_version'));
    const result = spawnSync(
      process.execPath,
      ['scripts/generate-team-contract-sql.mjs', '--check', '--output', stalePath],
      { encoding: 'utf8' }
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('out of date');
  }, 30_000);
});
