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

const productionOrigin = 'https://wishly-app.pages.dev';
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
      ticket: 'ticket-value',
      session_uri: 'https://googleapis.example/upload',
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
});
