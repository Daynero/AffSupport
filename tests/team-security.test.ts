import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  containsForbiddenTeamAnalyticsField,
  sanitizeTeamAnalyticsProperties
} from '@video-compressor/shared';
import { evaluateDriveOAuthGate } from '../supabase/functions/_shared/auth';
import {
  TeamFunctionError,
  errorResponse,
  redactForLog
} from '../supabase/functions/_shared/errors';
import { executeDriveConnectCommand } from '../supabase/functions/drive-connect/handler';
import {
  LANDING_IFRAME_SANDBOX,
  LANDING_PREVIEW_CSP
} from '../apps/agent/src/team-bridge/preview-origin';

const productionOrigin = 'https://soty.pp.ua';
const localSignals = {
  siteUrl: 'http://127.0.0.1:5173',
  requestOrigin: 'http://127.0.0.1:5173',
  transactionOrigin: 'http://127.0.0.1:5173'
};

describe('team security privacy boundaries', () => {
  it.each([
    [undefined, localSignals],
    ['disabled', localSignals],
    ['unexpected', localSignals],
    ['testing', { ...localSignals, siteUrl: productionOrigin }],
    ['testing', { ...localSignals, requestOrigin: productionOrigin }],
    ['testing', { ...localSignals, transactionOrigin: productionOrigin }]
  ])('blocks OAuth mode %s before every side effect for signals %o', async (mode, signals) => {
    const effects = {
      createOAuthTransaction: vi.fn(),
      exchangeCode: vi.fn(),
      writeCredential: vi.fn(),
      persistConnection: vi.fn()
    };
    expect(evaluateDriveOAuthGate(mode, signals).allowed).toBe(false);
    await expect(
      executeDriveConnectCommand(
        { action: 'start', teamId: '20000000-0000-4000-8000-000000000001' },
        { oauthMode: mode, signals, ...effects }
      )
    ).rejects.toMatchObject({ code: 'OAUTH_APPROVAL_REQUIRED' });
    expect(Object.values(effects).every(effect => effect.mock.calls.length === 0)).toBe(true);
  });

  it('redacts secret-bearing keys and identifying values from logs and structured errors', async () => {
    const sensitive = {
      authorization: 'Bearer google-access-token',
      harmlessKey: 'owner@example.test',
      providerMessage: '/Users/owner/secret-campaign.mp4',
      nested: {
        value: 'https://www.googleapis.com/upload?upload_id=secret-session',
        opaque: '0123456789abcdefghijklmnopqrstuvwxyzABCDEFG'
      },
      state: 'running'
    };
    const logged = JSON.stringify(redactForLog(sensitive));
    expect(logged).toContain('running');
    expect(logged).not.toMatch(/owner|secret-campaign|googleapis|upload_id|Bearer|0123456789/i);

    const response = errorResponse(
      new TeamFunctionError('INVALID_INPUT', {
        details: {
          teamCount: 2,
          email: 'owner@example.test',
          provider: '/private/provider-body',
          grantId: 'grant-secret-value'
        }
      })
    );
    const body = await response.json();
    expect(body).toEqual({
      ok: false,
      error: { code: 'INVALID_INPUT', retryable: false, details: { teamCount: 2 } }
    });
  });

  it('keeps analytics, audit targets, and Realtime publications content-free', async () => {
    const forbidden = {
      email: 'owner@example.test',
      filename: 'campaign.mp4',
      path: '/private/campaign.mp4',
      query: 'secret offer',
      transcript: 'customer words',
      content: 'private bytes',
      drive_id: 'google-drive-id',
      folder_id: 'google-folder-id',
      material_id: 'wishly-material-id',
      provider: 'google',
      grant: 'grant-id',
      grant_id: 'grant-id',
      ticket: 'ticket-value',
      vault_id: 'vault-secret',
      access_token: 'google-access-token',
      refresh_token: 'google-refresh-token',
      session_uri: 'https://googleapis.example/upload',
      session_url: 'https://googleapis.example/session',
      upload_uri: 'https://googleapis.example/resumable',
      metadata: { offer: 'private' }
    };
    expect(containsForbiddenTeamAnalyticsField(forbidden)).toBe(true);
    expect(
      sanitizeTeamAnalyticsProperties({
        ...forbidden,
        attempt_id: 'opaque_attempt_01',
        action: 'upload',
        storage_kind: 'shared_drive',
        size_bucket: 'large',
        attempt_number: 1,
        outcome: 'success',
        retryable: false
      })
    ).toEqual({
      attempt_id: 'opaque_attempt_01',
      action: 'upload',
      storage_kind: 'shared_drive',
      size_bucket: 'large',
      attempt_number: 1,
      outcome: 'success',
      retryable: false
    });

    const foundation = await readFile(
      'supabase/migrations/20260801094000_team_security_foundation.sql',
      'utf8'
    );
    const auditFunction = foundation.slice(
      foundation.indexOf('create or replace function private.record_team_audit'),
      foundation.indexOf('create or replace function private.store_google_drive_credential')
    );
    const auditAllowlist = auditFunction.slice(
      auditFunction.indexOf("'member_id'"),
      auditFunction.indexOf(') then')
    );
    expect(auditAllowlist).not.toMatch(
      /email|filename|path|query|drive_id|metadata|transcript|provider|grant|ticket|session_uri/i
    );

    const realtime = foundation.slice(foundation.indexOf('alter publication supabase_realtime'));
    expect(realtime).not.toMatch(
      /transcript_text|name|drive_file_id|root_folder_id|token|grant|ticket|session_uri|metadata/i
    );
  });

  it('keeps shared landing artifacts inert and the full view inside the existing sandbox', async () => {
    expect(LANDING_IFRAME_SANDBOX).toBe('allow-scripts');
    expect(LANDING_PREVIEW_CSP).toContain("connect-src 'none'");
    expect(LANDING_PREVIEW_CSP).toContain("form-action 'none'");
    expect(LANDING_PREVIEW_CSP).toContain("object-src 'none'");

    const origin = await readFile('apps/agent/src/team-bridge/preview-origin.ts', 'utf8');
    expect(origin).toContain('event.preventDefault()');
    expect(origin).toContain('window.open = () => null');
    expect(origin).toContain('external-navigation-blocked');

    const frame = await readFile('apps/web/src/team/preview/LandingPreviewFrame.tsx', 'utf8');
    expect(frame).toContain('sandbox={preview.sandbox}');
    expect(frame).toContain('referrerPolicy="no-referrer"');

    const cachedViewer = await readFile('apps/web/src/team/landings/LandingFullView.tsx', 'utf8');
    expect(cachedViewer).toContain('className="team-landing-preview team-landing-cached"');
    expect(cachedViewer).toContain('<img');
    expect(cachedViewer).not.toContain('dangerouslySetInnerHTML');

    const renderMigration = await readFile(
      'supabase/migrations/20260810090000_team_landing_renders.sql',
      'utf8'
    );
    expect(renderMigration).not.toMatch(
      /alter publication supabase_realtime[\s\S]*team_landing_renders/iu
    );
    const listFunction = renderMigration.slice(
      renderMigration.indexOf('create or replace function public.list_landing_renders'),
      renderMigration.indexOf('create or replace function public.service_start_landing_render')
    );
    expect(listFunction.slice(0, listFunction.indexOf('language plpgsql'))).not.toMatch(
      /artifact_root/iu
    );
  });
});
