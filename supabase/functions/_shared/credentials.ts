import { TeamFunctionError } from './errors.ts';
import { requireDriveOAuthGate, type OAuthProductionSignals } from './auth.ts';
import { isRecord } from './validation.ts';

export interface DriveCredential {
  credentialId: string;
  connectedBy: string;
  googlePermissionId: string;
  googleAccountEmail: string;
  scope: string;
  refreshToken: string;
}

export interface ServiceRpcClient {
  rpc: (
    name: string,
    parameters: Record<string, unknown>
  ) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

function parseCredential(value: unknown): DriveCredential | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (
    !isRecord(row) ||
    typeof row.credential_id !== 'string' ||
    typeof row.connected_by !== 'string' ||
    typeof row.google_permission_id !== 'string' ||
    typeof row.google_account_email !== 'string' ||
    typeof row.scope !== 'string' ||
    typeof row.refresh_token !== 'string'
  ) {
    return null;
  }
  return {
    credentialId: row.credential_id,
    connectedBy: row.connected_by,
    googlePermissionId: row.google_permission_id,
    googleAccountEmail: row.google_account_email,
    scope: row.scope,
    refreshToken: row.refresh_token
  };
}

export async function readDriveCredential(
  service: ServiceRpcClient,
  credentialId: string
): Promise<DriveCredential> {
  const { data, error } = await service.rpc('read_google_drive_credential', {
    p_credential: credentialId
  });
  if (error) throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
  const credential = parseCredential(data);
  if (!credential) throw new TeamFunctionError('NEEDS_REAUTH', { retryable: false });
  return credential;
}

interface GoogleTokenResponse {
  accessToken: string;
  expiresIn: number;
}

function parseTokenResponse(value: unknown): GoogleTokenResponse | null {
  if (
    !isRecord(value) ||
    typeof value.access_token !== 'string' ||
    value.access_token.length < 16 ||
    typeof value.expires_in !== 'number' ||
    !Number.isFinite(value.expires_in)
  ) {
    return null;
  }
  return { accessToken: value.access_token, expiresIn: Math.max(1, Math.floor(value.expires_in)) };
}

export async function refreshGoogleAccessToken(input: {
  credential: DriveCredential;
  clientId: string;
  clientSecret: string;
  oauthMode: unknown;
  productionSignals: OAuthProductionSignals;
  fetchImpl?: typeof fetch;
}): Promise<GoogleTokenResponse> {
  requireDriveOAuthGate(input.productionSignals, input.oauthMode);
  const fetchImpl = input.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    refresh_token: input.credential.refreshToken,
    grant_type: 'refresh_token'
  });
  let response: Response;
  try {
    response = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (isRecord(payload) && payload.error === 'invalid_grant') {
      throw new TeamFunctionError('NEEDS_REAUTH', { retryable: false });
    }
    throw new TeamFunctionError(response.status === 429 ? 'RATE_LIMITED' : 'DRIVE_UNAVAILABLE', {
      retryable: response.status === 429 || response.status >= 500
    });
  }
  const parsed = parseTokenResponse(payload);
  if (!parsed) throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  return parsed;
}
