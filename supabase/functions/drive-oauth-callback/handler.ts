import { evaluateDriveOAuthGate, type OAuthProductionSignals } from '../_shared/auth.ts';
import { TeamFunctionError } from '../_shared/errors.ts';

export interface OAuthCallbackTransaction {
  id?: string;
  teamId: string;
  actorId: string;
  origin: string;
  codeVerifier: string;
  credentialId: string | null;
}

export interface OAuthCallbackDependencies {
  peekTransaction: (state: string) => Promise<{
    origin: string;
    teamId?: string;
    actorId?: string;
    credentialId?: string | null;
  } | null>;
  consumeTransaction: (state: string) => Promise<OAuthCallbackTransaction | null>;
  exchangeCode: (input: { code: string; codeVerifier: string }) => Promise<{
    accessToken: string;
    refreshToken: string | null;
    scope?: string;
  }>;
  verifyPrincipal: (accessToken: string) => Promise<{ permissionId: string; email: string }>;
  storeCredential: (input: {
    actorId: string;
    permissionId: string;
    email: string;
    scope: string;
    refreshToken?: string;
    credentialId: string | null;
  }) => Promise<{ credentialId: string }>;
  bindCredential?: (input: {
    teamId: string;
    actorId: string;
    credentialId: string;
  }) => Promise<void>;
  markNeedsReauth: (credentialId: string | null) => Promise<void>;
}

export async function completeDriveOAuthCallback(
  input: {
    code: string;
    state: string;
    oauthMode: unknown;
    signals: OAuthProductionSignals;
  },
  dependencies: OAuthCallbackDependencies
): Promise<{ code: string; credentialId?: string }> {
  const requestGate = evaluateDriveOAuthGate(input.oauthMode, input.signals);
  if (!requestGate.allowed) return { code: 'OAUTH_APPROVAL_REQUIRED' };
  if (!input.code || !input.state) return { code: 'WRONG_STATE' };

  const peeked = await dependencies.peekTransaction(input.state);
  if (!peeked) return { code: 'WRONG_STATE' };
  const callbackGate = evaluateDriveOAuthGate(input.oauthMode, {
    ...input.signals,
    transactionOrigin: peeked.origin
  });
  if (!callbackGate.allowed) return { code: 'OAUTH_APPROVAL_REQUIRED' };

  const transaction = await dependencies.consumeTransaction(input.state);
  if (!transaction) return { code: 'WRONG_STATE' };
  try {
    const tokens = await dependencies.exchangeCode({
      code: input.code,
      codeVerifier: transaction.codeVerifier
    });
    const principal = await dependencies.verifyPrincipal(tokens.accessToken);
    const stored = await dependencies.storeCredential({
      actorId: transaction.actorId,
      permissionId: principal.permissionId,
      email: principal.email,
      // 011: what Google actually granted; drive.file is the request's floor.
      scope: tokens.scope ?? 'https://www.googleapis.com/auth/drive.file',
      refreshToken: tokens.refreshToken ?? undefined,
      credentialId: transaction.credentialId
    });
    await dependencies.bindCredential?.({
      teamId: transaction.teamId,
      actorId: transaction.actorId,
      credentialId: stored.credentialId
    });
    return { code: 'connected', credentialId: stored.credentialId };
  } catch (error) {
    const errorCode =
      error instanceof TeamFunctionError
        ? error.code
        : error && typeof error === 'object' && 'code' in error
          ? String((error as { code: unknown }).code)
          : '';
    if (errorCode === 'NEEDS_REAUTH' || errorCode === 'invalid_grant') {
      await dependencies.markNeedsReauth(transaction.credentialId);
      return { code: 'NEEDS_REAUTH' };
    }
    throw error;
  }
}
