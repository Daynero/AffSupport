import { TeamFunctionError, redactForLog } from './errors.ts';
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
  ) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
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

/** Pauses before Google's token endpoint is asked again; see `refreshGoogleAccessToken`. */
export const TOKEN_REFRESH_RETRY_DELAYS_MS: readonly number[] = [400, 1_200];
/** Past this, no further attempt starts: a person is waiting on the answer. */
const TOKEN_REFRESH_BUDGET_MS = 20_000;

export async function refreshGoogleAccessToken(input: {
  credential: DriveCredential;
  clientId: string;
  clientSecret: string;
  oauthMode: unknown;
  productionSignals: OAuthProductionSignals;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<GoogleTokenResponse> {
  requireDriveOAuthGate(input.productionSignals, input.oauthMode);
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? (ms => new Promise<void>(done => setTimeout(done, ms)));
  const now = input.now ?? Date.now;
  const startedAt = now();
  const retry = async (attempt: number) => {
    const delay = TOKEN_REFRESH_RETRY_DELAYS_MS[attempt];
    if (delay === undefined || now() - startedAt + delay >= TOKEN_REFRESH_BUDGET_MS) return false;
    await sleep(delay);
    return now() - startedAt < TOKEN_REFRESH_BUDGET_MS;
  };
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    refresh_token: input.credential.refreshToken,
    grant_type: 'refresh_token'
  });
  /*
   * A refresh changes nothing that a second one would not, so an unreachable endpoint, a 5xx
   * or a 429 is asked again after a pause (production 2026-11-12: one unanswered refresh during
   * a launch's source check reached the person as «Google Drive не відповідає»). A refused
   * grant is final at once, and no attempt starts past the budget.
   */
  let payload: unknown;
  let lastFailureCode: 'DRIVE_UNAVAILABLE' | 'RATE_LIMITED' = 'DRIVE_UNAVAILABLE';
  for (let attempt = 0; ; attempt++) {
    const remaining = TOKEN_REFRESH_BUDGET_MS - (now() - startedAt);
    if (remaining <= 0) throw new TeamFunctionError(lastFailureCode, { retryable: true });
    let response: Response;
    try {
      const signal = AbortSignal.timeout(Math.min(10_000, remaining));
      response = await fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal
      });
      payload = await response.json().catch(failure => {
        if (signal.aborted) throw failure;
        return null;
      });
    } catch (failure) {
      /*
       * The token endpoint could not be reached at all — DNS, the network, or the
       * ten-second timeout above. Unlogged, this reached the person as "Google
       * Drive is not responding" and reached us as nothing whatsoever, which is
       * the same sentence a real Drive outage produces. The reason is the whole
       * difference between "wait" and "fix something".
       */
      console.error(
        'token-refresh-unreachable',
        JSON.stringify(
          redactForLog(
            failure instanceof Error
              ? { name: failure.name, message: failure.message, attempt }
              : { value: failure, attempt }
          )
        )
      );
      lastFailureCode = 'DRIVE_UNAVAILABLE';
      if (await retry(attempt)) continue;
      throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
    }
    if (response.ok) break;
    if (isRecord(payload) && payload.error === 'invalid_grant') {
      throw new TeamFunctionError('NEEDS_REAUTH', { retryable: false });
    }
    console.error('token-refresh-refused', JSON.stringify({ status: response.status, attempt }));
    const transient = response.status === 429 || response.status >= 500;
    lastFailureCode = response.status === 429 ? 'RATE_LIMITED' : 'DRIVE_UNAVAILABLE';
    if (transient && (await retry(attempt))) continue;
    throw new TeamFunctionError(response.status === 429 ? 'RATE_LIMITED' : 'DRIVE_UNAVAILABLE', {
      retryable: transient
    });
  }
  const parsed = parseTokenResponse(payload);
  if (!parsed) throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  return parsed;
}
