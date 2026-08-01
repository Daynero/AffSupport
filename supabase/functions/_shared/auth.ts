import { PRODUCTION_SITE_ORIGIN } from '../../../packages/shared/dist/release.js';
import {
  parseDriveOAuthMode,
  type DriveOAuthMode
} from '../../../packages/shared/dist/team/contract.js';
import { TeamFunctionError } from './errors.ts';

export interface OAuthProductionSignals {
  siteUrl?: string | null;
  requestOrigin?: string | null;
  transactionOrigin?: string | null;
  canonicalProductionOrigin?: string;
}

export interface DriveOAuthGateResult {
  allowed: boolean;
  mode: DriveOAuthMode;
  production: boolean;
  error: 'OAUTH_APPROVAL_REQUIRED' | null;
}

function normalizedOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin.toLocaleLowerCase('en-US');
  } catch {
    return null;
  }
}

export function hasProductionSignal(signals: OAuthProductionSignals): boolean {
  const canonical = normalizedOrigin(signals.canonicalProductionOrigin ?? PRODUCTION_SITE_ORIGIN);
  if (!canonical) return true;
  return [signals.siteUrl, signals.requestOrigin, signals.transactionOrigin]
    .map(normalizedOrigin)
    .some(origin => origin === canonical);
}

export function evaluateDriveOAuthGate(
  rawMode: unknown,
  signals: OAuthProductionSignals
): DriveOAuthGateResult {
  const mode = parseDriveOAuthMode(rawMode);
  const production = hasProductionSignal(signals);
  const allowed = mode === 'verified' || (mode === 'testing' && !production);
  return {
    allowed,
    mode,
    production,
    error: allowed ? null : 'OAUTH_APPROVAL_REQUIRED'
  };
}

export function requireDriveOAuthGate(
  signals: OAuthProductionSignals,
  rawMode: unknown = Deno.env.get('DRIVE_OAUTH_MODE')
): DriveOAuthGateResult {
  const result = evaluateDriveOAuthGate(rawMode, signals);
  if (!result.allowed) {
    throw new TeamFunctionError('OAUTH_APPROVAL_REQUIRED', {
      status: 503,
      retryable: false
    });
  }
  return result;
}

export function bearerToken(request: Request): string {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) throw new TeamFunctionError('AUTH_REQUIRED');
  const token = authorization.slice('Bearer '.length).trim();
  if (token.length < 16 || token.length > 8192) throw new TeamFunctionError('AUTH_REQUIRED');
  return token;
}

interface AuthUserResult {
  data: { user: { id: string } | null };
  error: unknown;
}

export interface CallerAuthClient {
  auth: { getUser: (jwt: string) => Promise<AuthUserResult> };
}

export async function authorizeCaller(
  request: Request,
  client: CallerAuthClient
): Promise<{ jwt: string; userId: string }> {
  const jwt = bearerToken(request);
  const { data, error } = await client.auth.getUser(jwt);
  if (error || !data.user || !/^[0-9a-f-]{36}$/i.test(data.user.id)) {
    throw new TeamFunctionError('AUTH_REQUIRED');
  }
  return { jwt, userId: data.user.id };
}

async function digest(value: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  let difference = 0;
  for (let index = 0; index < a.byteLength; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

export async function requireNamedWorkerSecret(
  request: Request,
  configuredSecret = Deno.env.get('CATALOG_SYNC_SECRET')
): Promise<void> {
  const supplied = request.headers.get('x-catalog-sync-secret');
  if (
    !configuredSecret ||
    configuredSecret.length < 32 ||
    !supplied ||
    !(await constantTimeEqual(configuredSecret, supplied))
  ) {
    throw new TeamFunctionError('AUTH_REQUIRED');
  }
}
